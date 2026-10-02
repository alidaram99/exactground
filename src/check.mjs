// Policy: turn registry facts into verdicts. block | warn | ok | unknown.

import fs from 'node:fs';
import path from 'node:path';
import { lookup } from './registry.mjs';
import { lookalikeOf, popularRank } from './typosquat.mjs';
import { exactVersion, normalizePypi } from './specs.mjs';

const DAY = 86_400_000;

export const DEFAULT_CONFIG = {
  allow: [],              // names always allowed, e.g. ["my-private-pkg", "pypi:internal-lib"]
  privateScopes: [],      // npm scopes served by a private registry, e.g. ["@acme"]
  newPackageDays: 30,     // younger than this -> warn
  lookalikeBlockDays: 180,// look-alike of a popular package AND younger than this -> block
  lowDownloads: 500,      // npm weekly downloads below this -> warn (and block if also a look-alike)
  strict: false,          // true: registry unreachable -> block instead of allow-with-warning
};

/** Load .exactground.json from the project root (nearest upward), merged over defaults. */
export function loadConfig(cwd) {
  let dir = path.resolve(cwd || '.');
  for (;;) {
    const f = path.join(dir, '.exactground.json');
    if (fs.existsSync(f)) {
      try { return { ...DEFAULT_CONFIG, ...JSON.parse(fs.readFileSync(f, 'utf8')), configFile: f }; } catch { return { ...DEFAULT_CONFIG, configError: f }; }
    }
    const parent = path.dirname(dir);
    if (parent === dir || fs.existsSync(path.join(dir, '.git'))) return { ...DEFAULT_CONFIG };
    dir = parent;
  }
}

function allowed(cfg, eco, name) {
  const n = eco === 'pypi' ? normalizePypi(name) : name;
  return (cfg.allow || []).some((a) => a === n || a === `${eco}:${n}` || (eco === 'pypi' && normalizePypi(a.replace(/^pypi:/, '')) === n && !a.startsWith('npm:')));
}

const ageDays = (iso, now) => (iso ? Math.floor((now - Date.parse(iso)) / DAY) : null);

/**
 * Check deps [{ecosystem, name, spec}] and return results with verdicts.
 * opts: {config, cache, fetchImpl, now, customIndex (pip --index-url seen: missing -> warn, not block)}
 */
export async function checkDeps(deps, opts = {}) {
  const cfg = { ...DEFAULT_CONFIG, ...(opts.config || {}) };
  const now = opts.now ?? Date.now();
  const unique = [];
  const seen = new Set();
  for (const d of deps) {
    const k = `${d.ecosystem}:${d.ecosystem === 'pypi' ? normalizePypi(d.name) : d.name}@${d.spec || ''}`;
    if (!seen.has(k)) { seen.add(k); unique.push(d); }
  }
  return Promise.all(unique.map(async (d) => {
    const r = { ecosystem: d.ecosystem, name: d.name, spec: d.spec || '', verdict: 'ok', reasons: [] };
    if (allowed(cfg, d.ecosystem, d.name)) { r.reasons.push('allow-listed in .exactground.json'); return r; }
    if (d.ecosystem === 'npm' && (cfg.privateScopes || []).some((s) => d.name.startsWith(`${s.replace(/\/$/, '')}/`))) {
      r.reasons.push('private scope (not checked)');
      return r;
    }
    const popular = popularRank(d.ecosystem, d.name);
    const look = popular ? null : lookalikeOf(d.ecosystem, d.name);
    const info = await lookup(d.ecosystem, d.name, { cache: opts.cache, fetchImpl: opts.fetchImpl, deep: d.ecosystem === 'npm' && !popular, timeoutMs: opts.timeoutMs });
    r.registry = info.status;
    if (info.status === 'unknown') {
      r.verdict = cfg.strict ? 'block' : 'unknown';
      r.reasons.push(`registry unreachable (${info.error || 'error'}); ${cfg.strict ? 'blocked because strict mode is on' : 'not verified'}`);
      return r;
    }
    if (info.status === 'missing' || info.status === 'unpublished') {
      const where = d.ecosystem === 'npm' ? 'the npm registry' : 'PyPI';
      if (opts.customIndex) {
        r.verdict = 'warn';
        r.reasons.push(`not on ${where}; a custom package index is in use, so it may be private`);
      } else {
        r.verdict = 'block';
        r.reasons.push(info.status === 'missing' ? `"${d.name}" does not exist on ${where}` : `"${d.name}" has no published versions on ${where}`);
        if (look) r.reasons.push(`did you mean "${look.name}"? (it ${look.reason})`);
      }
      return r;
    }
    if (d.ecosystem === 'npm' && /-security$/.test(info.latest || '')) {
      r.verdict = 'block';
      r.reasons.push(`"${d.name}" is an npm security placeholder (${info.latest}): the original package was removed as malicious`);
      if (look) r.reasons.push(`did you mean "${look.name}"?`);
      return r;
    }
    const exact = exactVersion(d.ecosystem, d.spec);
    if (exact && !info.versions.includes(exact) && !(d.ecosystem === 'npm' && info.distTags?.includes(d.spec))) {
      r.verdict = 'block';
      r.reasons.push(`version ${exact} of "${d.name}" was never published (latest is ${info.latest})`);
      return r;
    }
    if (popular) { r.popularRank = popular; return r; }
    const age = ageDays(info.created, now);
    const lowDl = typeof info.weeklyDownloads === 'number' && info.weeklyDownloads < cfg.lowDownloads;
    const young = age != null && age < cfg.newPackageDays;
    if (look) {
      const risky = (age != null && age < cfg.lookalikeBlockDays) || lowDl;
      r.verdict = risky ? 'block' : 'warn';
      r.lookalikeOf = look.name;
      const why = [age != null && age < cfg.lookalikeBlockDays ? `first published ${age} days ago` : null,
        lowDl ? `${info.weeklyDownloads} downloads last week` : null].filter(Boolean).join(', ');
      r.reasons.push(`"${d.name}" looks like the popular package "${look.name}" (it ${look.reason})${why ? `; ${why}` : ''}`);
      return r;
    }
    if (young) { r.verdict = 'warn'; r.reasons.push(`first published ${age} days ago`); }
    if (lowDl) { r.verdict = 'warn'; r.reasons.push(`only ${info.weeklyDownloads} downloads last week`); }
    if (info.deprecated) { r.verdict = 'warn'; r.reasons.push(`latest version is deprecated: ${String(info.deprecated).slice(0, 160)}`); }
    if (info.yanked) { r.verdict = 'warn'; r.reasons.push('latest release is yanked'); }
    return r;
  }));
}

/** One-line human summary of a result. */
export function describe(r) {
  const id = `${r.ecosystem === 'pypi' ? 'pypi:' : ''}${r.name}${r.spec ? (r.ecosystem === 'npm' ? '@' : '') + r.spec : ''}`;
  return `${r.verdict.toUpperCase().padEnd(7)} ${id}${r.reasons.length ? ' — ' + r.reasons.join('; ') : ''}`;
}
