// Regression tests for "Re-review 2 (grok, v0.1.3)" in docs/reviews/four-products-security-review.md:
// NTFS streams, program names built in the shell, and dynamically built writes into ExactGround's directories.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fakeFetch, NOW } from './helpers.mjs';

const USERCONF = fs.mkdtempSync(path.join(os.tmpdir(), 'eg-rr2-userconf-'));
const CACHE = fs.mkdtempSync(path.join(os.tmpdir(), 'eg-rr2-cache-'));
process.env.EXACTGROUND_CONFIG_DIR = USERCONF;
process.env.EXACTGROUND_CACHE_DIR = CACHE;

const { evaluate } = await import('../src/hook.mjs');
const { isProtectedPath, stripStream } = await import('../src/trust.mjs');

function project() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eg-rr2-proj-'));
  fs.mkdirSync(path.join(dir, '.git'));
  return dir;
}
const run = (ev) => evaluate('claude', ev, { fetchImpl: fakeFetch(), now: NOW });
const shell = (command, cwd, tool = 'PowerShell') => ({ tool_name: tool, tool_input: { command }, cwd });
const decision = (r) => r.output.hookSpecificOutput?.permissionDecision ?? 'allow';
const MISSING = 'fake-pkg-zz';

// ---------------- (a) NTFS alternate data streams ----------------

test('re-review 2 (a): a stream of the policy file is the policy file', async () => {
  const dir = project();
  for (const p of ['.exactground.json::$DATA', '.exactground.json:x', '.exactground.json:x:$DATA', '.exactground.json.', '.exactground.json. .',
    path.join(dir, '.ExactGround.json::$DATA'), path.join(USERCONF, 'config.json::$DATA'), `${USERCONF}:stream`]) {
    assert.equal(isProtectedPath(p, dir), true, p);
    const ev = { tool_name: 'Write', tool_input: { file_path: p, content: '{"allow":["x"]}' }, cwd: dir };
    assert.equal(decision(await run(ev)), 'deny', `Write ${p}`);
  }
  for (const c of [`Set-Content -Path .exactground.json -Stream x -Value '{}'`, `cmd /c "echo {} > .exactground.json::$DATA"`]) {
    assert.equal(decision(await run(shell(c, dir))), 'deny', c);
  }
  assert.equal(stripStream('C:\\x\\a.txt:s'), 'C:\\x\\a.txt');
  assert.equal(stripStream('C:a.txt'), 'C:a.txt');
  assert.equal(stripStream('C:\\x\\..'), 'C:\\x\\..');
  assert.equal(isProtectedPath('src/app.js', dir), false);
  assert.equal(isProtectedPath('C:\\proj\\notes.txt:Zone.Identifier', dir), false);
});

// ---------------- (b) program names built in the shell ----------------

test('re-review 2 (b): caret escapes, call-operator expressions and loops that run a package manager are denied', async () => {
  const dir = project();
  for (const c of [
    `& ('np'+'m') install ${MISSING}`,
    `& ('npm') install ${MISSING}`,
    `& ( 'np' + 'm' ) i ${MISSING}`,
    `& (Get-Command npm) install ${MISSING}`,
    `& $('np'+'m') install ${MISSING}`,
    `& $(Get-Command npm).Source add ${MISSING}`,
    `cmd /c np^m install ${MISSING}`,
    `np^m install ${MISSING}`,
    `p^i^p install reqeusts`,
    `for %I in (npm) do %I install ${MISSING}`,
    `cmd /c "for %I in (npm) do %I install ${MISSING}"`,
    `foreach ($p in 'npm') { & $p install ${MISSING} }`,
    `'npm' | % { & $_ install ${MISSING} }`,
    `'npm' | ForEach-Object { & $_ add ${MISSING} }`,
    `for p in npm; do $p install ${MISSING}; done`,
  ]) {
    assert.equal(decision(await run(shell(c, dir, 'Bash'))), 'deny', c);
  }
});

// ---------------- (c) dynamically built writes into ExactGround's directories ----------------

test('re-review 2 (c): writes whose target is built with Join-Path, concatenation or env vars are denied', async () => {
  const dir = project();
  for (const c of [
    `Set-Content -Path (Join-Path $env:APPDATA 'exactground\\config.json') -Value '{"allow":["${MISSING}"]}'`,
    `[IO.File]::WriteAllText((Join-Path $env:APPDATA 'exactground\\config.json'), '{}')`,
    `Copy-Item evil.json (Join-Path $env:APPDATA 'exactground\\config.json')`,
    `New-Item -Force -Path (Join-Path $env:APPDATA 'exactground') -Name config.json -Value '{}'`,
    `Set-Content -Path (Join-Path (Join-Path $env:APPDATA ('ex'+'actground')) ('trusted-'+'projects.json')) -Value '{}'`,
    `$a='exa'; $b='ctground'; Set-Content "$env:APPDATA\\$a$b\\config.json" '{}'`,
    `$d = Join-Path $env:APPDATA ($x + $y); Out-File -FilePath "$d\\config.json" -InputObject '{}'`,
    `Set-Content "$env:EXACTGROUND_CONFIG_DIR\\config.json" '{}'`,
    `cmd /c copy evil.json "%EXACTGROUND_CONFIG_DIR%\\config.json"`,
    `cp evil.json "$XDG_CONFIG_HOME/exact""ground/config.json"`,
    `cp evil.json ~/.config/$n/config.json`,
    `echo {} > "%APPDATA%\\ex"^"actground\\config.json"`,
    `Set-Content ([Environment]::GetFolderPath('ApplicationData') + "\\$d\\config.json") '{}'`,
  ]) {
    assert.equal(decision(await run(shell(c, dir))), 'deny', c);
  }
});

// ---------------- false positives ----------------

test('re-review 2: the false-positive table stays allowed', async () => {
  const dir = project();
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'p', version: '1.0.0', scripts: { test: 'x', build: 'x' } }));
  for (const c of [
    'git add src/app.js', 'git add .', 'git status',
    'apt install curl', 'apt-get install -y curl', 'brew install jq', 'winget install Git.Git', 'choco install nodejs',
    'code --install-extension ms-python.python',
    'npm test', 'npm run build', 'npm run test', 'pip list', 'pip --version',
    'cat .exactground.json', 'Get-Content README.md', `Get-Content (Join-Path $env:APPDATA 'exactground\\config.json')`,
    `Set-Content -Path (Join-Path $PWD 'out.txt') -Value hi`,
    `Set-Content -Path (Join-Path $PSScriptRoot 'build\\notes.md') -Value hi`,
    `New-Item -ItemType Directory -Force (Join-Path . 'dist')`,
    `Copy-Item README.md (Join-Path 'docs' 'README.md')`,
    'Set-Content notes.txt hello',
    `node -e "require('fs').writeFileSync('notes.txt','background')"`,
    'echo $(date)', 'export X=$(pwd) && npm test',
    'for f in *.txt; do wc -l $f; done', 'for %f in (*.txt) do type %f',
    `Get-ChildItem *.md | % { $_.Name }`,
    '& ./build.ps1 -Configuration Release', `& (Join-Path $PSScriptRoot 'build.ps1')`,
    `npx -y github:alidaram99/exactground#v0.1.4 check pypi:requests 2>&1`,
    'echo "^a" | grep "^a"',
    'cargo add serde', 'go get example.com/x',
  ]) {
    assert.equal(decision(await run(shell(c, dir, 'Bash'))), 'allow', c);
  }
});
