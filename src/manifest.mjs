// Dependency manifests and lockfiles: package.json, requirements*.txt, pyproject.toml,
// package-lock.json, pnpm-lock.yaml, yarn.lock, bun.lock, uv.lock, poetry.lock, pdm.lock.

import fs from 'node:fs';
import path from 'node:path';
import { npmDependencyTarget, parsePipRequirement, normalizePypi } from './specs.mjs';

const NPM_DEP_FIELDS = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'];

/** Which manifest type a path is, or null. */
export function manifestType(file) {
  const b = path.basename(String(file)).toLowerCase();
  if (b === 'package.json') return 'package.json';
  if (b === 'pyproject.toml') return 'pyproject.toml';
  if (/^requirements.*\.(txt|in)$/.test(b) || /\.requirements\.txt$/.test(b)) return 'requirements';
  return null;
}

export function ecosystemOf(type) {
  return type === 'package.json' ? 'npm' : type ? 'pypi' : null;
}

/** Registry dependencies in a package.json text. Returns [] for unparsable JSON (an edit in progress). */
export function depsFromPackageJson(text) {
  let pkg;
  try { pkg = JSON.parse(text); } catch { return []; }
  const out = [];
  for (const field of NPM_DEP_FIELDS) {
    for (const [name, value] of Object.entries(pkg?.[field] || {})) {
      const t = npmDependencyTarget(name, value);
      if (t) out.push({ ecosystem: 'npm', name: t.name, spec: t.spec, field });
    }
  }
  return out;
}

/** Requirements file lines -> deps. Nested `-r other.txt` references are returned in `includes`. */
export function depsFromRequirements(text) {
  const deps = [];
  const includes = [];
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    const inc = line.match(/^(?:-r|--requirement)\s*=?\s*(\S+)/);
    if (inc) { includes.push(inc[1]); continue; }
    const p = parsePipRequirement(line);
    if (p) deps.push({ ecosystem: 'pypi', ...p });
  }
  return { deps, includes };
}

function tomlStringsInArray(body) {
  const out = [];
  const re = /"((?:[^"\\]|\\.)*)"|'([^']*)'/g;
  let m;
  while ((m = re.exec(body))) out.push(m[1] ?? m[2]);
  return out;
}

/** Minimal pyproject.toml reader: PEP 621 dependencies/optional-dependencies, dependency-groups, Poetry tables. */
export function depsFromPyproject(text) {
  const deps = [];
  let table = '';
  const lines = String(text).split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].replace(/\s+#.*$/, '');
    const header = line.match(/^\s*\[\[?([^\]]+)\]\]?\s*$/);
    if (header) { table = header[1].trim(); continue; }
    const arr = line.match(/^\s*([A-Za-z0-9_.-]+|"[^"]+")\s*=\s*\[(.*)$/);
    const inPep621 = (table === 'project' && arr && arr[1] === 'dependencies')
      || table === 'project.optional-dependencies' || table === 'dependency-groups'
      || (table === 'tool.uv' && arr && ['dev-dependencies', 'constraint-dependencies'].includes(arr[1]));
    if (arr && inPep621) {
      let body = arr[2];
      while (!/\]\s*$/.test(body) && i + 1 < lines.length) body += '\n' + lines[++i].replace(/\s+#.*$/, '');
      for (const s of tomlStringsInArray(body)) {
        const p = parsePipRequirement(s);
        if (p) deps.push({ ecosystem: 'pypi', ...p });
      }
      continue;
    }
    if (/^tool\.poetry(\.group\.[^.]+)?\.(dev-)?dependencies$/.test(table)) {
      const kv = line.match(/^\s*("?)([A-Za-z0-9][A-Za-z0-9._-]*)\1\s*=\s*(.+)$/);
      if (!kv || kv[2].toLowerCase() === 'python') continue;
      const value = kv[3].trim();
      if (/\b(path|git|url)\s*=/.test(value)) continue;
      const ver = value.match(/^["']([^"']*)["']/) || value.match(/version\s*=\s*["']([^"']*)["']/);
      deps.push({ ecosystem: 'pypi', name: normalizePypi(kv[2]), spec: ver ? ver[1] : '' });
    }
  }
  return deps;
}

/** Deps in a manifest text of the given type. */
export function depsFromManifest(type, text) {
  if (type === 'package.json') return depsFromPackageJson(text);
  if (type === 'pyproject.toml') return depsFromPyproject(text);
  if (type === 'requirements') return depsFromRequirements(text).deps;
  return [];
}

const key = (d) => `${d.ecosystem}:${d.name}`;

/** Deps present in `after` but not in `before` (new names only; version bumps of known names are not re-checked). */
export function addedDeps(type, before, after) {
  const old = new Set(depsFromManifest(type, before || '').map(key));
  const seen = new Set();
  return depsFromManifest(type, after || '').filter((d) => !old.has(key(d)) && !seen.has(key(d)) && seen.add(key(d)));
}

function read(file) {
  try { return fs.readFileSync(file, 'utf8'); } catch { return null; }
}

/** Find the nearest directory (from start upward) containing one of the names. */
export function findUp(start, names) {
  let dir = path.resolve(start || '.');
  for (;;) {
    for (const n of names) if (fs.existsSync(path.join(dir, n))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** Names already locked in this project (so a bare install only checks new deps). null = no lockfile. */
export function lockedNames(dir, ecosystem) {
  const names = new Set();
  let found = false;
  if (ecosystem === 'npm') {
    const pl = read(path.join(dir, 'package-lock.json')) ?? read(path.join(dir, 'npm-shrinkwrap.json'));
    if (pl) {
      found = true;
      try {
        const j = JSON.parse(pl);
        for (const k of Object.keys(j.packages || {})) {
          const m = k.match(/(?:^|\/)node_modules\/((?:@[^/]+\/)?[^/]+)$/);
          if (m) names.add(m[1]);
        }
        for (const k of Object.keys(j.dependencies || {})) names.add(k);
      } catch { /* ignore */ }
    }
    const pn = read(path.join(dir, 'pnpm-lock.yaml'));
    if (pn) {
      found = true;
      for (const m of pn.matchAll(/^\s{2,4}'?\/?((?:@[^/@\s']+\/)?[^/@\s':]+)@/gm)) names.add(m[1]);
      for (const m of pn.matchAll(/^\s{6,}'?((?:@[^/@\s']+\/)?[^/@\s':]+)'?:\s*$/gm)) names.add(m[1]);
    }
    const yl = read(path.join(dir, 'yarn.lock'));
    if (yl) {
      found = true;
      for (const m of yl.matchAll(/^"?((?:@[^/@\s"]+\/)?[^/@\s",]+)@/gm)) names.add(m[1]);
    }
    const bl = read(path.join(dir, 'bun.lock'));
    if (bl) {
      found = true;
      for (const m of bl.matchAll(/"((?:@[^/@\s"]+\/)?[^/@\s"]+)":\s*\["\1@/g)) names.add(m[1]);
    }
  } else {
    for (const f of ['uv.lock', 'poetry.lock', 'pdm.lock']) {
      const t = read(path.join(dir, f));
      if (!t) continue;
      found = true;
      for (const m of t.matchAll(/^name\s*=\s*"([^"]+)"/gm)) names.add(normalizePypi(m[1]));
    }
  }
  return found ? names : null;
}

/** Deps a bare install (`npm install`, `uv sync`, `poetry install`) would newly resolve from the registry. */
export function unlockedManifestDeps(cwd, ecosystem) {
  if (ecosystem === 'npm') {
    const dir = findUp(cwd, ['package.json']);
    if (!dir) return { dir: null, deps: [] };
    const deps = depsFromPackageJson(read(path.join(dir, 'package.json')) || '');
    const locked = lockedNames(dir, 'npm');
    return { dir, deps: locked ? deps.filter((d) => !locked.has(d.name)) : deps };
  }
  const dir = findUp(cwd, ['pyproject.toml']);
  if (!dir) return { dir: null, deps: [] };
  const deps = depsFromPyproject(read(path.join(dir, 'pyproject.toml')) || '');
  const locked = lockedNames(dir, 'pypi');
  return { dir, deps: locked ? deps.filter((d) => !locked.has(d.name)) : deps };
}

export const MAX_REQUIREMENTS_BYTES = 256 * 1024;

/**
 * Deps in a requirements file, following nested -r includes (max depth 5). Security review S3: the file and every
 * include must be a regular file inside `root` (not a symlink) and at most 256 KB; otherwise an error is recorded
 * and nothing from it is read. Returns {deps, errors}.
 */
export function requirementsFileDeps(file, cwd, root = cwd, depth = 0, acc = { deps: [], errors: [] }) {
  const full = path.resolve(cwd || '.', file);
  const base = path.resolve(root || cwd || '.');
  const rel = path.relative(base, full);
  if (depth > 5) { acc.errors.push(`${file}: nested -r includes deeper than 5 levels`); return acc; }
  if (rel.startsWith('..') || path.isAbsolute(rel)) { acc.errors.push(`${file}: outside the project (${base}); refusing to read it`); return acc; }
  let st;
  try { st = fs.lstatSync(full); } catch { acc.errors.push(`${file}: not found`); return acc; }
  if (st.isSymbolicLink()) { acc.errors.push(`${file}: is a symbolic link; refusing to follow it`); return acc; }
  if (!st.isFile()) { acc.errors.push(`${file}: not a regular file`); return acc; }
  if (st.size > MAX_REQUIREMENTS_BYTES) { acc.errors.push(`${file}: larger than ${MAX_REQUIREMENTS_BYTES / 1024} KB; refusing to read it`); return acc; }
  const { deps, includes } = depsFromRequirements(fs.readFileSync(full, 'utf8'));
  acc.deps.push(...deps);
  for (const inc of includes) requirementsFileDeps(inc, path.dirname(full), base, depth + 1, acc);
  return acc;
}
