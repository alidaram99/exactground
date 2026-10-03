// Regression table for "## False-positive audit (grok, v0.1.4)" in docs/reviews/four-products-security-review.md:
// all 100 realistic agent tool calls, with the decision each must get in v0.1.5. The 15 unjustified denies of v0.1.4
// (cases 1-9, 22-25, 99, 100) now allow; the 4 controls (93-96) and the 2 accepted low denies (97, 98) stay denied.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fakeFetch, NOW } from './helpers.mjs';

const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const USERCONF = tmp('eg-fp-userconf-');
const CACHE = tmp('eg-fp-cache-');
process.env.EXACTGROUND_CONFIG_DIR = USERCONF;
process.env.EXACTGROUND_CACHE_DIR = CACHE;
process.env.APPDATA = tmp('eg-fp-appdata-');
process.env.LOCALAPPDATA = tmp('eg-fp-localappdata-');

const { evaluate } = await import('../src/hook.mjs');

// The audit's offline registry: the shared fake plus real, popular tools agents run every day.
const EXTRA_NPM = ['prettier', 'eslint', 'vitest', 'jest', 'tsx', 'rimraf', 'concurrently'];
const EXTRA_PYPI = ['ruff', 'black', 'pytest'];
function auditFetch() {
  const base = fakeFetch();
  const ok = (body) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  const old = new Date(NOW - 4000 * 86_400_000).toISOString();
  return async (url) => {
    const u = new URL(url);
    const npmName = decodeURIComponent(u.pathname.slice(1));
    if (u.host === 'registry.npmjs.org' && EXTRA_NPM.includes(npmName)) {
      return ok({ name: npmName, 'dist-tags': { latest: '9.0.0' }, versions: { '9.0.0': {} }, time: { created: old } });
    }
    if (u.host === 'api.npmjs.org' && EXTRA_NPM.includes(u.pathname.split('/last-week/')[1])) return ok({ downloads: 30_000_000 });
    const pyName = u.pathname.split('/')[2];
    if (u.host === 'pypi.org' && EXTRA_PYPI.includes(pyName)) {
      return ok({ info: { version: '8.0.0', summary: 'x' }, releases: { '8.0.0': [{ upload_time_iso_8601: old }] } });
    }
    return base(url);
  };
}

function project() {
  const dir = tmp('eg-fp-proj-');
  fs.mkdirSync(path.join(dir, '.git'));
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'demo', version: '1.0.0', dependencies: { lodash: '^4.17.21', react: '^19.0.0' } }));
  fs.writeFileSync(path.join(dir, 'package-lock.json'), JSON.stringify({ packages: { '': {}, 'node_modules/lodash': {}, 'node_modules/react': {} } }));
  fs.writeFileSync(path.join(dir, 'requirements.txt'), 'requests==2.32.3\n');
  return dir;
}

const DIR = project();
// Host shapes used in the audit.
const ev = {
  claude: (command) => ({ tool_name: 'Bash', tool_input: { command }, cwd: DIR }),
  ps: (command) => ({ tool_name: 'PowerShell', tool_input: { command }, cwd: DIR }),
  cursor: (command) => ({ command, cwd: DIR }),
  codex: (command) => ({ tool_name: 'exec_command', tool_input: { command: ['bash', '-lc', command] }, cwd: DIR }),
  gemini: (command) => ({ tool_name: 'run_shell_command', tool_input: { command }, cwd: DIR }),
  write: (file_path) => ({ tool_name: 'Write', tool_input: { file_path, content: 'x' }, cwd: DIR }),
  edit: (file_path) => ({ tool_name: 'Edit', tool_input: { file_path, old_string: 'a', new_string: 'b' }, cwd: DIR }),
  multi: (file_path) => ({ tool_name: 'MultiEdit', tool_input: { file_path, edits: [{ old_string: 'a', new_string: 'b' }] }, cwd: DIR }),
};
const VENDOR = { claude: 'claude', ps: 'claude', write: 'claude', edit: 'claude', multi: 'claude', cursor: 'cursor', codex: 'codex', gemini: 'gemini' };

// [case, host, command or path, expected decision in v0.1.5, v0.1.4 decision]
const CASES = [
  [1, 'claude', "Set-Content -Path (Join-Path $HOME '.npmrc') -Value 'fund=false'", 'allow', 'deny'],
  [2, 'claude', "Set-Content -Path (Join-Path $HOME '.gitconfig') -Value '[user]'", 'allow', 'deny'],
  [3, 'claude', "Add-Content -Path (Join-Path $HOME '.bashrc') -Value 'export EDITOR=vim'", 'allow', 'deny'],
  [4, 'claude', "New-Item -Force -Path (Join-Path $HOME '.config\\alacritty\\settings.json') -Value '{}'", 'allow', 'deny'],
  [5, 'cursor', "Set-Content (Join-Path $env:APPDATA 'Code\\User\\settings.json') '{}'", 'allow', 'deny'],
  [6, 'ps', "Set-Content (Join-Path $HOME 'projects\\notes.md') '# notes'", 'allow', 'deny'],
  [7, 'claude', "Set-Content (Join-Path $env:USERPROFILE 'Documents\\todo.txt') 'buy milk'", 'allow', 'deny'],
  [8, 'claude', "Copy-Item README.md (Join-Path $HOME 'projects\\README.md')", 'allow', 'deny'],
  [9, 'claude', "New-Item -ItemType Directory (Join-Path $env:LOCALAPPDATA 'npm-cache')", 'allow', 'deny'],
  [10, 'claude', "'done' | Out-File (Join-Path $PSScriptRoot 'build.log')", 'allow', 'allow'],
  [11, 'claude', "'done' | Out-File .\\logs\\build.log", 'allow', 'allow'],
  [12, 'claude', 'npm test > logs\\build.log 2>&1', 'allow', 'allow'],
  [13, 'claude', 'python script.py > logs\\out.txt', 'allow', 'allow'],
  [14, 'claude', 'echo hello > ~/.bashrc', 'allow', 'allow'],
  [15, 'claude', "Set-Content ~/.npmrc 'fund=false'", 'allow', 'allow'],
  [16, 'claude', "Set-Content ~/.gitconfig '[user]'", 'allow', 'allow'],
  [17, 'gemini', "echo 'export PATH=$PATH:~/bin' >> ~/.bashrc", 'allow', 'allow'],
  [18, 'claude', 'for f in src/*.js; do npm test -- "$f"; done', 'allow', 'allow'],
  [19, 'claude', 'for f in src/*.js; do npx eslint "$f"; done', 'allow', 'allow'],
  [20, 'claude', 'for f in src/*.js; do npx prettier --write "$f"; done', 'allow', 'allow'],
  [21, 'codex', 'for d in packages/*; do npm ci --prefix "$d"; done', 'allow', 'allow'],
  [22, 'ps', 'Get-ChildItem *.js | ForEach-Object { npx eslint $_ }', 'allow', 'deny'],
  [23, 'ps', 'foreach ($f in Get-ChildItem *.test.js) { npm test $f }', 'allow', 'deny'],
  [24, 'ps', '1..3 | ForEach-Object { npm run lint }', 'allow', 'deny'],
  [25, 'cursor', 'for %f in (src\\*.js) do npx prettier --write %f', 'allow', 'deny'],
  [26, 'claude', 'for f in *.txt; do wc -l "$f"; done', 'allow', 'allow'],
  [27, 'claude', 'for f in tests/*.py; do python -m pytest "$f"; done', 'allow', 'allow'],
  [28, 'ps', 'Get-ChildItem | ForEach-Object { $_.Name }', 'allow', 'allow'],
  [29, 'ps', 'Get-ChildItem | % { $_.Name }', 'allow', 'allow'],
  [30, 'ps', 'foreach ($line in Get-Content README.md) { $line }', 'allow', 'allow'],
  [31, 'claude', 'while read -r f; do echo "$f"; done < README.md', 'allow', 'allow'],
  [32, 'cursor', 'for %i in (1 2 3) do @echo %i', 'allow', 'allow'],
  [33, 'claude', '& $python -m pytest', 'allow', 'allow'],
  [34, 'ps', '& .\\scripts\\build.ps1', 'allow', 'allow'],
  [35, 'ps', "& (Join-Path $PSScriptRoot 'build.ps1')", 'allow', 'allow'],
  [36, 'ps', '& $env:PYTHON -m pytest tests', 'allow', 'allow'],
  [37, 'gemini', 'npm ci', 'allow', 'allow'],
  [38, 'claude', 'npm install', 'allow', 'allow'],
  [39, 'claude', 'npm install lodash', 'allow', 'allow'],
  [40, 'codex', 'pnpm add lodash', 'allow', 'allow'],
  [41, 'claude', 'yarn add lodash', 'allow', 'allow'],
  [42, 'claude', 'uv add requests', 'allow', 'allow'],
  [43, 'claude', 'poetry add requests', 'allow', 'allow'],
  [44, 'gemini', 'pip install -r requirements.txt', 'allow', 'allow'],
  [45, 'claude', 'npx prettier --write src', 'allow', 'allow'],
  [46, 'cursor', 'npx eslint src', 'allow', 'allow'],
  [47, 'claude', 'npm test', 'allow', 'allow'],
  [48, 'claude', 'npm run build', 'allow', 'allow'],
  [49, 'claude', 'npm run lint', 'allow', 'allow'],
  [50, 'claude', 'npm install --save-dev eslint', 'allow', 'allow'],
  [51, 'claude', 'pnpm exec eslint .', 'allow', 'allow'],
  [52, 'claude', 'git status', 'allow', 'allow'],
  [53, 'claude', 'git add src/app.js', 'allow', 'allow'],
  [54, 'claude', 'git add .', 'allow', 'allow'],
  [55, 'claude', 'git diff', 'allow', 'allow'],
  [56, 'claude', 'git log -1', 'allow', 'allow'],
  [57, 'claude', 'git commit -m "fix the failing test"', 'allow', 'allow'],
  [58, 'claude', 'git checkout -b feature/notes', 'allow', 'allow'],
  [59, 'gemini', 'docker build -t demo .', 'allow', 'allow'],
  [60, 'claude', 'docker compose up -d', 'allow', 'allow'],
  [61, 'claude', 'docker run --rm node:20 npm test', 'allow', 'allow'],
  [62, 'claude', 'make test', 'allow', 'allow'],
  [63, 'claude', 'make -C src test', 'allow', 'allow'],
  [64, 'codex', 'cargo build --release', 'allow', 'allow'],
  [65, 'claude', 'cargo test', 'allow', 'allow'],
  [66, 'claude', 'cargo add serde', 'allow', 'allow'],
  [67, 'claude', 'go test ./...', 'allow', 'allow'],
  [68, 'claude', 'go get golang.org/x/tools', 'allow', 'allow'],
  [69, 'cursor', 'cmd /c echo hello^ world', 'allow', 'allow'],
  [70, 'claude', 'cmd /c echo price is 2^&2', 'allow', 'allow'],
  [71, 'claude', 'cmd /c echo caret^^shown', 'allow', 'allow'],
  [72, 'write', 'src/app.js', 'allow', 'allow'],
  [73, 'write', '~/.npmrc', 'allow', 'allow'],
  [74, 'write', '%APPDATA%\\Code\\User\\settings.json', 'allow', 'allow'],
  [75, 'edit', 'src/app.js', 'allow', 'allow'],
  [76, 'multi', 'src/app.js', 'allow', 'allow'],
  [77, 'claude', `node -e "require('fs').writeFileSync('notes.txt','background')"`, 'allow', 'allow'],
  [78, 'claude', 'node -e "console.log(1)"', 'allow', 'allow'],
  [79, 'claude', 'python -c "print(1)"', 'allow', 'allow'],
  [80, 'claude', 'echo $(date)', 'allow', 'allow'],
  [81, 'claude', 'export X=$(pwd) && npm test', 'allow', 'allow'],
  [82, 'claude', 'apt-get install -y curl', 'allow', 'allow'],
  [83, 'claude', 'brew install git', 'allow', 'allow'],
  [84, 'claude', 'winget install Git.Git', 'allow', 'allow'],
  [85, 'claude', 'choco install git', 'allow', 'allow'],
  [86, 'claude', 'code --install-extension dbaeumer.vscode-eslint', 'allow', 'allow'],
  [87, 'claude', 'pip list', 'allow', 'allow'],
  [88, 'claude', 'pip --version', 'allow', 'allow'],
  [89, 'claude', 'Get-Content README.md', 'allow', 'allow'],
  [90, 'claude', 'cat README.md', 'allow', 'allow'],
  [91, 'ps', "Set-Content notes.txt 'hello'", 'allow', 'allow'],
  [92, 'claude', 'gofmt -w src', 'allow', 'allow'],
  // Controls: these must stay denied.
  [93, 'claude', "Set-Content (Join-Path $env:APPDATA 'exactground\\config.json') '{\"allow\":[\"fake-pkg-zz\"]}'", 'deny', 'deny'],
  [94, 'claude', "& ('np'+'m') install lodash", 'deny', 'deny'],
  [95, 'cursor', 'for %I in (npm) do %I install lodash', 'deny', 'deny'],
  [96, 'claude', 'npm install missing-pkg-zz', 'deny', 'deny'],
  // Low denies accepted in Resolution 3.
  [97, 'claude', 'git add .exactground.json', 'deny', 'deny'],
  [98, 'claude', 'echo exactground > notes.txt', 'deny', 'deny'],
  // Fixed in v0.1.5.
  [99, 'ps', '& $python -m pip install requests', 'allow', 'deny'],
  [100, 'ps', 'Get-ChildItem -Filter *.py | ForEach-Object { pip install -r requirements.txt }', 'allow', 'deny'],
];

const decide = async (host, cmd) => {
  const r = await evaluate(VENDOR[host], ev[host](cmd), { fetchImpl: auditFetch(), now: NOW });
  return { decision: r.decision === 'deny' ? 'deny' : 'allow', text: r.text };
};

test('false-positive audit: the table has all 100 cases, 15 of them fixed in v0.1.5', () => {
  assert.equal(CASES.length, 100);
  assert.deepEqual(CASES.map((c) => c[0]), Array.from({ length: 100 }, (_, i) => i + 1));
  assert.deepEqual(CASES.filter((c) => c[3] === 'allow' && c[4] === 'deny').map((c) => c[0]), [1, 2, 3, 4, 5, 6, 7, 8, 9, 22, 23, 24, 25, 99, 100]);
});

for (const [n, host, cmd, want] of CASES) {
  test(`false-positive audit case ${n} (${host}): ${want} — ${cmd}`, async () => {
    const { decision, text } = await decide(host, cmd);
    assert.equal(decision, want, `case ${n}: ${cmd}\n${text}`);
  });
}

test('control 93: the deny names ExactGround policy, not a generic profile write', async () => {
  const { text } = await decide('claude', CASES[92][2]);
  assert.match(text, /writes ExactGround policy, trust or cache files/);
});

test('narrowed rules keep every unresolvable form denied (bypasses stay closed)', async () => {
  for (const [host, cmd] of [
    // Per-user path whose tail is a variable: the destination cannot be known.
    ['ps', "$a='exa'; $b='ctground'; Set-Content \"$env:APPDATA\\$a$b\\config.json\" '{}'"],
    ['ps', "$d = Join-Path $env:APPDATA ($x + $y); Out-File -FilePath \"$d\\config.json\" -InputObject '{}'"],
    ['claude', 'cp evil.json ~/.config/$n/config.json'],
    ['ps', "Set-Content (Join-Path $HOME $name) '{}'"],
    // Loops whose program is a variable or expression.
    ['ps', "foreach ($p in 'npm') { & $p install fake-pkg-zz }"],
    ['ps', "'npm' | % { & $_ install fake-pkg-zz }"],
    ['cursor', 'for %I in (npm) do %I install fake-pkg-zz'],
    ['ps', "foreach ($p in 'npm') { & ('n'+'pm') install fake-pkg-zz }"],
    // Literal manager, variable package name: the package cannot be checked.
    ['ps', "foreach ($p in 'fake-pkg-zz') { npm install $p }"],
    ['ps', "'fake-pkg-zz' | ForEach-Object { npx $_ }"],
    ['claude', 'npm install $PKG'],
    ['claude', 'pip install $PKG'],
    // Variable or expression manager.
    ['ps', '& $pm install lodash'],
    ['ps', '& $python -m $pm install requests'],
    ['ps', "& ('np'+'m') install lodash"],
    // A literal `-m pip` is parsed, so a missing name is still caught.
    ['ps', '& $python -m pip install reqeusts'],
    ['ps', 'Get-ChildItem | ForEach-Object { npm install fake-pkg-zz }'],
  ]) {
    assert.equal((await decide(host, cmd)).decision, 'deny', cmd);
  }
  const { text } = await decide('ps', "Set-Content (Join-Path $HOME $name) '{}'");
  assert.match(text, /path built from variables/);
});
