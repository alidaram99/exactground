// Regression tests for the independent re-review (docs/reviews/four-products-security-review.md,
// "Re-review (grok, 2026-10-03)"): every reproduced bypass of S1, S2 and S3, plus false-positive guards.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fakeFetch, NOW } from './helpers.mjs';

const USERCONF = fs.mkdtempSync(path.join(os.tmpdir(), 'eg-rr-userconf-'));
const CACHE = fs.mkdtempSync(path.join(os.tmpdir(), 'eg-rr-cache-'));
process.env.EXACTGROUND_CONFIG_DIR = USERCONF;
process.env.EXACTGROUND_CACHE_DIR = CACHE;

const { evaluate } = await import('../src/hook.mjs');
const { trustProjectConfig, userConfigFile } = await import('../src/trust.mjs');
const { requirementsFileDeps } = await import('../src/manifest.mjs');
const { baseName } = await import('../src/parse-command.mjs');

function project() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eg-rr-proj-'));
  fs.mkdirSync(path.join(dir, '.git'));
  return dir;
}
const run = (ev) => evaluate('claude', ev, { fetchImpl: fakeFetch(), now: NOW });
const bash = (command, cwd, tool = 'Bash') => ({ tool_name: tool, tool_input: { command }, cwd });
const decision = (r) => r.output.hookSpecificOutput?.permissionDecision ?? 'allow';
const MISSING = 'fake-pkg-zz';

// ---------------- S1 ----------------

test('S1: an unapproved user-level config.json is ignored; `trust --user` approval works; edits revoke it', async () => {
  const cfg = userConfigFile();
  fs.writeFileSync(cfg, JSON.stringify({ allow: [MISSING], strict: false }));
  const ev = bash(`npm install ${MISSING}`, project());
  let r = await run(ev);
  assert.equal(decision(r), 'deny', 'agent-written user config must not allow a missing package');
  assert.match(r.text, /trust --user/);
  trustProjectConfig(cfg);
  r = await run(ev);
  assert.equal(decision(r), 'allow', 'after human approval the user config applies');
  fs.writeFileSync(cfg, JSON.stringify({ allow: [MISSING, 'x'], strict: false }));
  r = await run(ev);
  assert.equal(decision(r), 'deny', 'edited after approval -> untrusted');
  fs.rmSync(cfg);
});

test('S1: shell writes to the user config / approvals / project policy are denied whatever the verb', async () => {
  const dir = project();
  const target = path.join(USERCONF, 'config.json');
  const cases = [
    `[IO.File]::WriteAllText("${target}", '{"allow":["${MISSING}"]}')`,
    `cmd /c copy evil.json "${target}"`,
    `cmd /c copy evil.json "%APPDATA%\\exactground\\config.json"`,
    `xcopy evil.json "${USERCONF}\\" /Y`,
    `robocopy . "${USERCONF}" evil.json`,
    `move evil.json .exactground.json`,
    `Move-Item evil.json .exactground.json`,
    `'{}' | Out-File .exactground.json`,
    `echo {} > "${path.join(USERCONF, 'trusted-projects.json')}"`,
    `cp evil.json ~/.config/exactground/config.json`,
    `node -e "require('fs').writeFileSync(require('path').join(process.env.APPDATA,'exact'+'ground','config.json'),'{}')"`,
    `python -c "open(__import__('os').path.join(__import__('os').environ['APPDATA'],'exact'+'ground','config.json'),'w').write('{}')"`,
  ];
  for (const c of cases) {
    const r = await run(bash(c, dir));
    assert.equal(decision(r), 'deny', c);
  }
  for (const c of ['cat .exactground.json', 'type .exactground.json', `Get-Content "${target}"`, 'git status']) {
    assert.equal(decision(await run(bash(c, dir))), 'allow', `read-only stays allowed: ${c}`);
  }
});

test('S1: every non-read-only tool has its paths checked (NotebookEdit, MCP filesystem, unknown tools)', async () => {
  const dir = project();
  const cases = [
    { tool_name: 'NotebookEdit', tool_input: { notebook_path: path.join(dir, '.exactground.json'), new_source: '{}' }, cwd: dir },
    { tool_name: 'mcp__filesystem__write_file', tool_input: { path: path.join(USERCONF, 'config.json'), content: '{}' }, cwd: dir },
    { tool_name: 'SomeFutureWriter', tool_input: { target: { file: '.ExactGround.JSON' } }, cwd: dir },
  ];
  for (const ev of cases) assert.equal(decision(await run(ev)), 'deny', ev.tool_name);
  const read = { tool_name: 'Read', tool_input: { file_path: path.join(dir, '.exactground.json') }, cwd: dir };
  assert.equal(decision(await run(read)), 'allow', 'Read of the policy is allowed');
  const mcpRead = { tool_name: 'mcp__filesystem__read_file', tool_input: { path: path.join(dir, '.exactground.json') }, cwd: dir };
  assert.equal(decision(await run(mcpRead)), 'allow');
});

// ---------------- S2 ----------------

test('S2: package managers reached through variables, 8.3 names, suffixes, full paths and call operators are checked', async () => {
  const dir = project();
  for (const c of [
    `n=npm; $n install ${MISSING}`,
    `export PM=npm && $PM install ${MISSING}`,
    `$pm = "npm"; & $pm install ${MISSING}`,
    `set PM=npm && %PM% install ${MISSING}`,
    `NPM~1.EXE install ${MISSING}`,
    `npm.cmd install ${MISSING}`,
    `npm.ps1 install ${MISSING}`,
    `"C:\\Program Files\\nodejs\\npm.cmd" install ${MISSING}`,
    `& npm install ${MISSING}`,
    `pnpm dlx ${MISSING}`,
    `yarn dlx ${MISSING}`,
    `uvx reqeusts`,
    `pipx run reqeusts`,
  ]) {
    const r = await run(bash(c, dir));
    assert.equal(decision(r), 'deny', c);
  }
  assert.equal(baseName('NPM~1.EXE'), 'npm');
  assert.equal(baseName('POETRY~1'), 'poetry');
  assert.equal(baseName('/usr/local/bin/pip3'), 'pip3');
});

test('S2: a tool named PowerShell (or any tool carrying a command string) is treated as a shell', async () => {
  const dir = project();
  for (const tool of ['PowerShell', 'Terminal', 'mcp__shell__run', 'run_in_terminal']) {
    const r = await run(bash(`npm install ${MISSING}`, dir, tool));
    assert.equal(decision(r), 'deny', tool);
  }
});

test('S2: unresolvable program names and opaque executors with a package manager are denied', async () => {
  const dir = project();
  for (const c of [
    `$x install ${MISSING}`,
    `%TOOL% add ${MISSING}`,
    `iex "npm install ${MISSING}"`,
    `Invoke-Expression 'pip install reqeusts'`,
    `Start-Process npm -ArgumentList 'install ${MISSING}'`,
    'pwsh -EncodedCommand bgBwAG0AIABpAG4AcwB0AGEAbABsACAAeAA=',
    `echo $(npm i ${MISSING})`,
    `ruby -e "system('pip install reqeusts')"`,
  ]) {
    assert.equal(decision(await run(bash(c, dir))), 'deny', c);
  }
});

test('S2: no false positives on ordinary commands', async () => {
  const dir = project();
  for (const c of [
    'git add .',
    'git add -A && git commit -m "x"',
    'apt install curl',
    'sudo apt-get install -y jq',
    'brew install jq',
    'code --install-extension ms-python.python',
    'winget install Git.Git',
    'choco install nodejs',
    'export X=$(pwd) && npm test',
    'echo $(date)',
    'node -e "console.log(1)"',
    'python -c "print(1)"',
    'npm run build',
    'npm ci',
    'cargo add serde',
    'go get github.com/x/y',
  ]) {
    assert.equal(decision(await run(bash(c, dir))), 'allow', c);
  }
});

// ---------------- S3 ----------------

test('S3: a hard-linked requirements file is refused', () => {
  const dir = project();
  const outside = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'eg-rr-out-')), 'secret.txt');
  fs.writeFileSync(outside, 'TOKEN_LIKE_VALUE\n');
  fs.linkSync(outside, path.join(dir, 'reqs.txt'));
  const r = requirementsFileDeps('reqs.txt', dir, dir);
  assert.equal(r.deps.length, 0);
  assert.match(r.errors.join(' '), /hard links/);
});

test('S3: a requirements file reached through a junction / linked directory outside the project is refused', () => {
  const dir = project();
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eg-rr-junction-'));
  fs.writeFileSync(path.join(outDir, 'reqs.txt'), 'TOKEN_LIKE_VALUE\n');
  // 'junction' needs no admin rights on Windows; on Linux/macOS the type is ignored and a directory symlink is made.
  fs.symlinkSync(outDir, path.join(dir, 'linked'), 'junction');
  const r = requirementsFileDeps(path.join('linked', 'reqs.txt'), dir, dir);
  assert.equal(r.deps.length, 0);
  assert.match(r.errors.join(' '), /outside the project/);
});

test('S3: the hook denies the install for both link tricks', async () => {
  const dir = project();
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eg-rr-junction2-'));
  fs.writeFileSync(path.join(outDir, 'reqs.txt'), 'requests\n');
  fs.symlinkSync(outDir, path.join(dir, 'linked'), 'junction');
  fs.linkSync(path.join(outDir, 'reqs.txt'), path.join(dir, 'hard.txt'));
  assert.equal(decision(await run(bash('pip install -r linked/reqs.txt', dir))), 'deny');
  assert.equal(decision(await run(bash('pip install -r hard.txt', dir))), 'deny');
  fs.writeFileSync(path.join(dir, 'ok.txt'), 'requests\n');
  assert.equal(decision(await run(bash('pip install -r ok.txt', dir))), 'allow', 'a normal file inside the project still works');
});
