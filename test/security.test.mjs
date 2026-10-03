// Regression tests for the security review (docs/reviews/four-products-security-review.md): S1, S2, S3, S9.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { fakeFetch, NOW } from './helpers.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const CLI = path.join(ROOT, 'bin/exactground.mjs');
const USERCONF = fs.mkdtempSync(path.join(os.tmpdir(), 'eg-sec-userconf-'));
const CACHE = fs.mkdtempSync(path.join(os.tmpdir(), 'eg-sec-cache-'));
process.env.EXACTGROUND_CONFIG_DIR = USERCONF;
process.env.EXACTGROUND_CACHE_DIR = CACHE;

const { evaluate } = await import('../src/hook.mjs');
const { trustProjectConfig } = await import('../src/trust.mjs');
const { lookupNpm } = await import('../src/registry.mjs');

function project() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eg-sec-proj-'));
  fs.mkdirSync(path.join(dir, '.git'));
  return dir;
}
const bash = (command, cwd) => ({ tool_name: 'Bash', tool_input: { command }, cwd });
const decision = (r) => r.output.hookSpecificOutput?.permissionDecision ?? 'allow';

test('S1: a poisoned cache entry cannot allow a missing package on the hook path', async () => {
  fs.writeFileSync(path.join(CACHE, 'registry-cache.json'), JSON.stringify({
    'npm:fake-pkg-zz:deep': { at: Date.now(), value: { status: 'exists', versions: ['1.0.0'], latest: '1.0.0', distTags: ['latest'] } },
    'npm:fake-pkg-zz': { at: Date.now(), value: { status: 'exists', versions: ['1.0.0'], latest: '1.0.0', distTags: ['latest'] } },
  }));
  const f = fakeFetch();
  const r = await evaluate('claude', bash('npm install fake-pkg-zz@1.0.0', project()), { fetchImpl: f, now: NOW });
  assert.equal(decision(r), 'deny');
  assert.ok(f.calls.some((u) => u.includes('fake-pkg-zz')), 'the registry was re-queried');
});

test('S1: registry unreachable denies on the hook path (strict is the hook default)', async () => {
  const r = await evaluate('claude', bash('npm install some-real-looking-pkg', project()), { fetchImpl: fakeFetch({ down: true }), now: NOW });
  assert.equal(decision(r), 'deny');
  assert.match(r.text, /strict/);
});

test('S1: an unapproved project .exactground.json is ignored; approval by hash works; any edit revokes it', async () => {
  const dir = project();
  const cfg = path.join(dir, '.exactground.json');
  fs.writeFileSync(cfg, JSON.stringify({ allow: ['fake-pkg-zz'], strict: false }));
  const ev = bash('npm install fake-pkg-zz', dir);
  let r = await evaluate('claude', ev, { fetchImpl: fakeFetch(), now: NOW });
  assert.equal(decision(r), 'deny');
  assert.match(r.text, /not approved/);
  trustProjectConfig(cfg);
  r = await evaluate('claude', ev, { fetchImpl: fakeFetch(), now: NOW });
  assert.equal(decision(r), 'allow');
  fs.writeFileSync(cfg, JSON.stringify({ allow: ['fake-pkg-zz', 'another-fake'] }));
  r = await evaluate('claude', ev, { fetchImpl: fakeFetch(), now: NOW });
  assert.equal(decision(r), 'deny', 'edited after approval -> untrusted again');
});

test('S1: the agent may not write ExactGround policy, approval or cache files', async () => {
  const dir = project();
  const cases = [
    { tool_name: 'Write', tool_input: { file_path: path.join(dir, '.exactground.json'), content: '{"allow":["x"]}' }, cwd: dir },
    { tool_name: 'Edit', tool_input: { file_path: '.exactground.json', old_string: 'a', new_string: 'b' }, cwd: dir },
    { tool_name: 'apply_patch', tool_input: { command: '*** Begin Patch\n*** Add File: sub/.exactground.json\n+{}\n*** End Patch' }, cwd: dir },
    bash('echo {"allow":["x"]} > .exactground.json', dir),
    bash(`cp evil.json "${path.join(USERCONF, 'trusted-projects.json')}"`, dir),
    { tool_name: 'Write', tool_input: { file_path: path.join(CACHE, 'registry-cache.json'), content: '{}' }, cwd: dir },
  ];
  for (const ev of cases) {
    const r = await evaluate('claude', ev, { fetchImpl: fakeFetch(), now: NOW });
    assert.equal(decision(r), 'deny', JSON.stringify(ev.tool_input).slice(0, 80));
    assert.match(r.text, /exactground trust|policy/);
  }
  const read = await evaluate('claude', bash('cat .exactground.json', dir), { fetchImpl: fakeFetch(), now: NOW });
  assert.equal(decision(read), 'allow', 'reading the policy is fine');
});

test('S2: installs hidden in inline scripts, command substitution or eval are denied', async () => {
  const dir = project();
  for (const c of [
    `node -e "require('child_process').execSync('npm install fake-pkg-zz')"`,
    `python -c "import subprocess; subprocess.run(['pip','install','reqeusts'])"`,
    'echo $(npm i fake-pkg-zz)',
    'eval "pip install reqeusts"',
  ]) {
    const r = await evaluate('claude', bash(c, dir), { fetchImpl: fakeFetch(), now: NOW });
    assert.equal(decision(r), 'deny', c);
  }
  const plain = await evaluate('claude', bash('node -e "console.log(1)"', dir), { fetchImpl: fakeFetch(), now: NOW });
  assert.equal(decision(plain), 'allow');
});

test('S2: the hook fails closed on unreadable input, for every agent; EXACTGROUND_FAIL_OPEN=1 opts out', () => {
  const run = (vendor, env = {}) => JSON.parse(spawnSync(process.execPath, [CLI, 'hook', vendor], { input: '{', encoding: 'utf8', env: { ...process.env, ...env } }).stdout);
  assert.equal(run('claude').hookSpecificOutput.permissionDecision, 'deny');
  assert.equal(run('codex').hookSpecificOutput.permissionDecision, 'deny');
  assert.equal(run('gemini').decision, 'deny');
  assert.equal(run('cursor').permission, 'deny');
  assert.deepEqual(run('claude', { EXACTGROUND_FAIL_OPEN: '1' }), {});
});

test('S3: pip -r paths are jailed to the project, no symlinks, size-capped; violations deny the install', async () => {
  const dir = project();
  const outside = path.join(path.dirname(dir), `eg-outside-${Date.now()}.txt`);
  fs.writeFileSync(outside, 'requests\n');
  let r = await evaluate('claude', bash(`pip install -r "${outside}"`, dir), { fetchImpl: fakeFetch(), now: NOW });
  assert.equal(decision(r), 'deny');
  assert.match(r.text, /outside the project/);
  r = await evaluate('claude', bash('pip install -r ../x.txt', dir), { fetchImpl: fakeFetch(), now: NOW });
  assert.equal(decision(r), 'deny');
  fs.writeFileSync(path.join(dir, 'big.txt'), 'requests\n'.repeat(40_000));
  r = await evaluate('claude', bash('pip install -r big.txt', dir), { fetchImpl: fakeFetch(), now: NOW });
  assert.equal(decision(r), 'deny');
  assert.match(r.text, /256 KB/);
  fs.writeFileSync(path.join(dir, 'inc.txt'), `-r ${outside}\n`);
  r = await evaluate('claude', bash('pip install -r inc.txt', dir), { fetchImpl: fakeFetch(), now: NOW });
  assert.equal(decision(r), 'deny', 'nested include outside the project');
  let linked = false;
  try { fs.symlinkSync(outside, path.join(dir, 'link.txt')); linked = true; } catch { /* no symlink privilege on this OS user */ }
  if (linked) {
    r = await evaluate('claude', bash('pip install -r link.txt', dir), { fetchImpl: fakeFetch(), now: NOW });
    assert.equal(decision(r), 'deny');
    assert.match(r.text, /symbolic link/);
  }
  fs.writeFileSync(path.join(dir, 'ok.txt'), 'requests\nflask\n');
  r = await evaluate('claude', bash('pip install -r ok.txt', dir), { fetchImpl: fakeFetch(), now: NOW });
  assert.equal(decision(r), 'allow');
});

test('S9: scoped npm names are encoded in the downloads URL', async () => {
  const urls = [];
  const f = async (url) => { urls.push(String(url)); return new Response(JSON.stringify({ versions: { '1.0.0': {} }, 'dist-tags': { latest: '1.0.0' }, time: {}, downloads: 5 }), { status: 200 }); };
  await lookupNpm('@scope/pkg', { fetchImpl: f, deep: true });
  assert.ok(urls.some((u) => u.endsWith('/downloads/point/last-week/%40scope%2Fpkg')), urls.join(' '));
});
