import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { evaluate, formatOutput, commandText } from '../src/hook.mjs';
import { depsFromPatch, depsFromFileEdit, depsFromCommand } from '../src/analyze.mjs';
import { addedDeps, depsFromPyproject, lockedNames } from '../src/manifest.mjs';
import { hookConfig, installHooks } from '../src/install.mjs';
import { Cache } from '../src/registry.mjs';
import { fakeFetch, NOW } from './helpers.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'eg-proj-'));
const opts = () => ({ fetchImpl: fakeFetch(), now: NOW, cache: new Cache(null) });

test('Claude Code: Bash install of a missing package is denied', async () => {
  const r = await evaluate('claude', { tool_name: 'Bash', tool_input: { command: 'npm install reacct-dom-fake' }, cwd: tmp() }, opts());
  assert.equal(r.decision, 'deny');
  assert.equal(r.output.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(r.output.hookSpecificOutput.permissionDecisionReason, /does not exist on the npm registry/);
});

test('Claude Code: unrelated commands and real packages pass with no output', async () => {
  for (const command of ['ls -la', 'npm test', 'npm install react']) {
    const r = await evaluate('claude', { tool_name: 'Bash', tool_input: { command }, cwd: tmp() }, opts());
    assert.equal(r.decision, 'allow', command);
    assert.deepEqual(r.output, {});
  }
});

test('Claude Code: an Edit that adds a fake dependency to package.json is denied', async () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ dependencies: { react: '^19.0.0' } }, null, 2));
  const r = await evaluate('claude', {
    tool_name: 'Edit', cwd: dir,
    tool_input: { file_path: path.join(dir, 'package.json'), old_string: '"react": "^19.0.0"', new_string: '"react": "^19.0.0",\n    "react-fast-formz": "^2.0.0"' },
  }, opts());
  assert.equal(r.decision, 'deny');
  assert.match(r.text, /react-fast-formz/);
});

test('bare npm install checks only dependencies missing from the lockfile', async () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ dependencies: { react: '^19', 'ghost-dep': '^1', 'left-pad': '1.3.0' } }));
  fs.writeFileSync(path.join(dir, 'package-lock.json'), JSON.stringify({ packages: { '': {}, 'node_modules/react': {}, 'node_modules/left-pad': {} } }));
  const { deps } = depsFromCommand('npm install', dir);
  assert.deepEqual(deps.map((d) => d.name), ['ghost-dep']);
  const r = await evaluate('cursor', { command: 'npm install', cwd: dir }, opts());
  assert.equal(r.output.permission, 'deny');
});

test('pip install -r follows nested requirement files', async () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'requirements.txt'), 'requests==2.32.3\n-r dev.txt\n');
  fs.writeFileSync(path.join(dir, 'dev.txt'), 'flask\npytest-fakeplugin-zz\n');
  const r = await evaluate('gemini', { tool_name: 'run_shell_command', tool_input: { command: 'pip install -r requirements.txt' }, cwd: dir }, opts());
  assert.equal(r.output.decision, 'deny');
  assert.match(r.output.reason, /pytest-fakeplugin-zz/);
});

test('Codex: argv arrays and apply_patch manifests', async () => {
  assert.equal(commandText(['bash', '-lc', 'npm i zod']), 'npm i zod');
  const r = await evaluate('codex', { tool_name: 'Bash', tool_input: { command: ['bash', '-lc', 'pip install reqeusts'] }, cwd: tmp() }, opts());
  assert.equal(r.output.hookSpecificOutput.permissionDecision, 'deny');
  const patch = '*** Begin Patch\n*** Update File: requirements.txt\n@@\n requests\n+numpy==1.26.4\n+fakepkg-qq\n*** End Patch';
  assert.deepEqual(depsFromPatch(patch).map((d) => d.name), ['numpy', 'fakepkg-qq']);
  const p = await evaluate('codex', { tool_name: 'apply_patch', tool_input: { command: patch }, cwd: tmp() }, opts());
  assert.equal(p.decision, 'deny');
});

test('package.json patches only count dependency blocks', () => {
  const patch = '--- a/package.json\n+++ b/package.json\n@@\n   "scripts": {\n+    "build": "tsc",\n   },\n   "devDependencies": {\n+    "vitest": "^2.0.0"\n   }';
  assert.deepEqual(depsFromPatch(patch).map((d) => d.name), ['vitest']);
});

test('warnings are allowed with context, in each vendor format', async () => {
  const ev = { tool_name: 'Bash', tool_input: { command: 'npm i tiny-new-lib' }, cwd: tmp() };
  const c = await evaluate('claude', ev, opts());
  assert.equal(c.decision, 'warn');
  assert.match(c.output.hookSpecificOutput.additionalContext, /tiny-new-lib/);
  assert.equal(c.output.hookSpecificOutput.permissionDecision, undefined);
  assert.equal(formatOutput('gemini', 'warn', 'x').decision, 'allow');
  assert.equal(formatOutput('cursor', 'warn', 'x', {}).permission, 'allow');
  assert.deepEqual(formatOutput('cursor', 'allow', ''), { permission: 'allow' });
});

test('manifest helpers', () => {
  assert.deepEqual(addedDeps('package.json', '{"dependencies":{"a":"1"}}', '{"dependencies":{"a":"2","b":"^1","c":"file:../c","d":"workspace:*"}}').map((d) => d.name), ['b']);
  const py = depsFromPyproject('[project]\nname="x"\ndependencies = [\n  "httpx>=0.27",\n  "rich",\n]\n[project.optional-dependencies]\ndev = ["pytest"]\n[tool.poetry.dependencies]\npython = "^3.11"\npendulum = "^3.0"\nlocal = {path = "../l"}\n');
  assert.deepEqual(py.map((d) => d.name), ['httpx', 'rich', 'pytest', 'pendulum']);
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'uv.lock'), 'version = 1\n[[package]]\nname = "Rich"\nversion = "13"\n');
  assert.ok(lockedNames(dir, 'pypi').has('rich'));
  assert.equal(lockedNames(tmp(), 'npm'), null);
  const edit = path.join(dir, 'requirements.txt');
  fs.writeFileSync(edit, 'rich\n');
  assert.deepEqual(depsFromFileEdit(edit, [{ old_string: 'rich\n', new_string: 'rich\nnewdep\n' }], dir).map((d) => d.name), ['newdep']);
});

test('init --write merges hooks without removing existing ones, and is idempotent', () => {
  const dir = tmp();
  fs.mkdirSync(path.join(dir, '.claude'));
  fs.writeFileSync(path.join(dir, '.claude/settings.json'), JSON.stringify({ model: 'x', hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'other' }] }] } }));
  assert.equal(installHooks('claude', dir, ROOT).changed, true);
  const s = JSON.parse(fs.readFileSync(path.join(dir, '.claude/settings.json'), 'utf8'));
  assert.equal(s.model, 'x');
  assert.equal(s.hooks.PreToolUse.length, 2);
  assert.equal(installHooks('claude', dir, ROOT).changed, false);
  for (const v of ['codex', 'gemini', 'cursor']) assert.ok(hookConfig(v, ROOT).file);
});

test('plugin manifests are valid JSON and point at existing files', () => {
  const hooks = JSON.parse(fs.readFileSync(path.join(ROOT, 'hooks/hooks.json'), 'utf8'));
  assert.equal(hooks.hooks.PreToolUse[0].hooks[0].args[0], '${CLAUDE_PLUGIN_ROOT}/bin/exactground.mjs');
  for (const f of ['.claude-plugin/plugin.json', '.claude-plugin/marketplace.json', '.codex-plugin/plugin.json', 'plugin.json', 'hooks/codex.json', '.agents/plugins/marketplace.json']) {
    JSON.parse(fs.readFileSync(path.join(ROOT, f), 'utf8'));
  }
});

test('CLI: --version, usage errors, and hook prints exactly one JSON object', () => {
  const cli = path.join(ROOT, 'bin/exactground.mjs');
  const v = spawnSync(process.execPath, [cli, '--version'], { encoding: 'utf8' });
  assert.equal(v.stdout.trim(), JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version);
  assert.equal(spawnSync(process.execPath, [cli, 'check'], { encoding: 'utf8' }).status, 2);
  const h = spawnSync(process.execPath, [cli, 'hook', 'claude'], { input: JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'echo hi' } }), encoding: 'utf8' });
  assert.equal(h.status, 0);
  assert.deepEqual(JSON.parse(h.stdout), {});
  const bad = spawnSync(process.execPath, [cli, 'hook', 'claude'], { input: 'not json', encoding: 'utf8' });
  assert.equal(bad.status, 0);
  assert.deepEqual(JSON.parse(bad.stdout), {});
});
