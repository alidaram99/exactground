// Public registry lookups (npm, PyPI) with a small on-disk cache. Never throws: network trouble -> status 'unknown'.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { normalizePypi } from './specs.mjs';

const UA = 'exactground/0.1 (+https://github.com/alidaram99/exactground)';
const HOUR = 3600_000;
const TTL = { exists: 24 * HOUR, missing: HOUR / 2, unknown: 0 };

export function cacheDir(env = process.env) {
  if (env.EXACTGROUND_CACHE_DIR) return env.EXACTGROUND_CACHE_DIR;
  const base = env.XDG_CACHE_HOME || (process.platform === 'win32' ? env.LOCALAPPDATA : null) || path.join(os.homedir(), '.cache');
  return path.join(base, 'exactground');
}

export class Cache {
  constructor(dir = cacheDir(), now = () => Date.now()) {
    this.file = dir ? path.join(dir, 'registry-cache.json') : null;
    this.now = now;
    this.data = {};
    this.dirty = false;
    if (this.file) {
      try { this.data = JSON.parse(fs.readFileSync(this.file, 'utf8')); } catch { this.data = {}; }
    }
  }
  get(k) {
    const e = this.data[k];
    if (!e) return null;
    if (this.now() - e.at > (TTL[e.value.status] ?? 0)) return null;
    return e.value;
  }
  set(k, value) {
    if (value.status === 'unknown') return;
    this.data[k] = { at: this.now(), value };
    this.dirty = true;
  }
  save() {
    if (!this.file || !this.dirty) return;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const keep = Object.entries(this.data).sort((a, b) => b[1].at - a[1].at).slice(0, 5000);
      fs.writeFileSync(this.file, JSON.stringify(Object.fromEntries(keep)));
      this.dirty = false;
    } catch { /* cache is best effort */ }
  }
}

async function getJson(fetchImpl, url, { timeoutMs = 4000, headers = {} } = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, { headers: { 'User-Agent': UA, Accept: 'application/json', ...headers }, signal: ctrl.signal });
    if (res.status === 404) return { status: 404 };
    if (!res.ok) return { status: res.status, error: `HTTP ${res.status}` };
    return { status: 200, json: await res.json() };
  } catch (err) {
    return { status: 0, error: err.name === 'AbortError' ? 'timeout' : err.message };
  } finally {
    clearTimeout(t);
  }
}

const npmPath = (name) => name.replace('/', '%2f');

/**
 * npm lookup. Returns {status:'exists'|'missing'|'unknown', versions?, latest?, created?, deprecated?, weeklyDownloads?}
 * `deep` adds creation time and weekly downloads (two more requests); used only when a name needs a closer look.
 */
export async function lookupNpm(name, { fetchImpl = fetch, deep = false, timeoutMs } = {}) {
  const r = await getJson(fetchImpl, `https://registry.npmjs.org/${npmPath(name)}`, {
    timeoutMs, headers: { Accept: 'application/vnd.npm.install-v1+json; q=1.0, application/json; q=0.8' },
  });
  if (r.status === 404) return { status: 'missing' };
  if (r.status !== 200) return { status: 'unknown', error: r.error };
  const doc = r.json;
  const versions = Object.keys(doc.versions || {});
  const latest = doc['dist-tags']?.latest ?? versions.at(-1) ?? null;
  const out = { status: 'exists', versions, distTags: Object.keys(doc['dist-tags'] || {}), latest, deprecated: doc.versions?.[latest]?.deprecated || null };
  if (!versions.length) out.status = 'unpublished';
  if (deep) {
    const [full, dl] = await Promise.all([
      getJson(fetchImpl, `https://registry.npmjs.org/${npmPath(name)}`, { timeoutMs }),
      getJson(fetchImpl, `https://api.npmjs.org/downloads/point/last-week/${name}`, { timeoutMs }),
    ]);
    if (full.status === 200) out.created = full.json.time?.created ?? null;
    if (dl.status === 200) out.weeklyDownloads = dl.json.downloads ?? null;
  }
  return out;
}

/** PyPI lookup via the JSON API. Same shape as lookupNpm; `created` = earliest file upload. */
export async function lookupPypi(name, { fetchImpl = fetch, timeoutMs } = {}) {
  const r = await getJson(fetchImpl, `https://pypi.org/pypi/${encodeURIComponent(normalizePypi(name))}/json`, { timeoutMs });
  if (r.status === 404) return { status: 'missing' };
  if (r.status !== 200) return { status: 'unknown', error: r.error };
  const j = r.json;
  const versions = Object.keys(j.releases || {});
  let created = null;
  for (const files of Object.values(j.releases || {})) {
    for (const f of files || []) {
      const t = f.upload_time_iso_8601 || f.upload_time;
      if (t && (!created || t < created)) created = t;
    }
  }
  const withFiles = versions.filter((v) => (j.releases[v] || []).length);
  return {
    status: withFiles.length ? 'exists' : 'unpublished',
    versions, latest: j.info?.version ?? null, created,
    yanked: j.info?.yanked || false,
    summary: j.info?.summary || '',
  };
}

/** Cached lookup for {ecosystem, name}. */
export async function lookup(ecosystem, name, { cache, fetchImpl = fetch, deep = false, timeoutMs } = {}) {
  const k = `${ecosystem}:${ecosystem === 'pypi' ? normalizePypi(name) : name}${deep ? ':deep' : ''}`;
  const hit = cache?.get(k);
  if (hit) return { ...hit, cached: true };
  const v = ecosystem === 'npm' ? await lookupNpm(name, { fetchImpl, deep, timeoutMs }) : await lookupPypi(name, { fetchImpl, timeoutMs });
  cache?.set(k, v);
  return v;
}
