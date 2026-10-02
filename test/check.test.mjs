import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { checkDeps } from '../src/check.mjs';
import { Cache } from '../src/registry.mjs';
import { lookalikeOf, editDistance, popularRank } from '../src/typosquat.mjs';
import { fakeFetch, NOW } from './helpers.mjs';

const run = (deps, opts = {}) => checkDeps(deps, { fetchImpl: fakeFetch(), now: NOW, ...opts });
const by = (results) => Object.fromEntries(results.map((r) => [r.name, r]));

test('missing packages are blocked with a did-you-mean', async () => {
  const r = by(await run([{ ecosystem: 'npm', name: 'react' }, { ecosystem: 'pypi', name: 'reqeusts' }, { ecosystem: 'npm', name: 'totally-made-up-pkg' }]));
  assert.equal(r.react.verdict, 'ok');
  assert.equal(r.reqeusts.verdict, 'block');
  assert.match(r.reqeusts.reasons.join(' '), /did you mean "requests"/);
  assert.equal(r['totally-made-up-pkg'].verdict, 'block');
});

test('a pinned version that was never published is blocked', async () => {
  const r = by(await run([{ ecosystem: 'npm', name: 'react', spec: '99.0.0' }, { ecosystem: 'pypi', name: 'numpy', spec: '==1.26.4' }, { ecosystem: 'npm', name: 'react', spec: 'latest' }]));
  assert.equal(r.react.verdict === 'block' || r.react.verdict === 'ok', true);
  const results = await run([{ ecosystem: 'npm', name: 'react', spec: '99.0.0' }]);
  assert.equal(results[0].verdict, 'block');
  assert.match(results[0].reasons[0], /never published/);
  assert.equal(r.numpy.verdict, 'ok');
});

test('young or little-used look-alikes are blocked, established look-alikes only warned', async () => {
  const r = by(await run([{ ecosystem: 'npm', name: 'expresss' }]));
  assert.equal(r.expresss.verdict, 'block');
  assert.equal(r.expresss.lookalikeOf, 'express');
  const old = (await run([{ ecosystem: 'npm', name: 'old-expresss' }]))[0];
  assert.notEqual(old.verdict, 'block');
});

test('new, little-used, deprecated and security-placeholder packages', async () => {
  const r = by(await run([{ ecosystem: 'npm', name: 'tiny-new-lib' }, { ecosystem: 'npm', name: 'left-pad' }, { ecosystem: 'npm', name: 'reacct' }]));
  assert.equal(r['tiny-new-lib'].verdict, 'warn');
  assert.match(r['tiny-new-lib'].reasons.join(' '), /3 days ago/);
  assert.equal(r['left-pad'].verdict, 'warn');
  assert.match(r['left-pad'].reasons.join(' '), /deprecated/);
  assert.equal(r.reacct.verdict, 'block');
  assert.match(r.reacct.reasons[0], /security placeholder/);
});

test('allow list, private scopes and custom indexes', async () => {
  const config = { allow: ['totally-made-up-pkg', 'pypi:internal-lib'], privateScopes: ['@acme'] };
  const r = by(await run([{ ecosystem: 'npm', name: 'totally-made-up-pkg' }, { ecosystem: 'pypi', name: 'internal_lib' }, { ecosystem: 'npm', name: '@acme/secret' }], { config }));
  assert.equal(r['totally-made-up-pkg'].verdict, 'ok');
  assert.equal(r.internal_lib.verdict, 'ok');
  assert.equal(r['@acme/secret'].verdict, 'ok');
  const ci = (await run([{ ecosystem: 'pypi', name: 'corp-only' }], { customIndex: true }))[0];
  assert.equal(ci.verdict, 'warn');
});

test('registry down: unknown (fail open) by default, block in strict mode', async () => {
  const deps = [{ ecosystem: 'npm', name: 'whatever-pkg' }];
  assert.equal((await run(deps, { fetchImpl: fakeFetch({ down: true }) }))[0].verdict, 'unknown');
  assert.equal((await run(deps, { fetchImpl: fakeFetch({ down: true }), config: { strict: true } }))[0].verdict, 'block');
});

test('cache avoids repeat lookups and expires missing names quickly', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eg-cache-'));
  let t = NOW;
  const cache = new Cache(dir, () => t);
  const f = fakeFetch();
  await checkDeps([{ ecosystem: 'npm', name: 'react' }, { ecosystem: 'npm', name: 'nope-pkg' }], { fetchImpl: f, cache, now: NOW });
  const first = f.calls.length;
  await checkDeps([{ ecosystem: 'npm', name: 'react' }, { ecosystem: 'npm', name: 'nope-pkg' }], { fetchImpl: f, cache, now: NOW });
  assert.equal(f.calls.length, first);
  cache.save();
  t += 2 * 3600_000; // 2 h later: "missing" expired (30 min), "exists" still valid (24 h)
  const reloaded = new Cache(dir, () => t);
  assert.ok(reloaded.get('npm:react'));
  assert.equal(reloaded.get('npm:nope-pkg:deep'), null);
});

test('look-alike detection', () => {
  assert.equal(lookalikeOf('npm', 'react'), null);
  assert.equal(lookalikeOf('npm', 'expresss')?.name, 'express');
  assert.equal(lookalikeOf('npm', 'lodahs')?.name, 'lodash');
  assert.equal(lookalikeOf('pypi', 'reqeusts')?.name, 'requests');
  assert.equal(lookalikeOf('pypi', 'python-dateutils')?.name, 'python-dateutil');
  assert.equal(lookalikeOf('npm', '@types/react'), null);
  assert.equal(lookalikeOf('npm', 'my-totally-unique-name'), null);
  assert.equal(editDistance('abcd', 'abdc'), 1);
  assert.ok(popularRank('npm', 'react') > 0);
});
