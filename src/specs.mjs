// Package-spec parsing for npm-style and pip-style arguments. No I/O.

/** PEP 503 normalized PyPI project name. */
export function normalizePypi(name) {
  return String(name).trim().toLowerCase().replace(/[-_.]+/g, '-');
}

const NPM_NAME = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/i;

/** Is this a plausible registry package name (not a path, URL, git ref or shorthand)? */
export function isNpmRegistryName(name) {
  return NPM_NAME.test(name) && name.length <= 214;
}

/**
 * Parse one npm/pnpm/yarn/bun argument such as `react`, `react@18.2.0`, `@types/node@^20`, `alias@npm:real@1`.
 * Returns {name, spec} or null when the argument does not refer to the public registry (paths, URLs, git, workspace).
 */
export function parseNpmSpec(arg) {
  let a = String(arg).trim();
  if (!a || a.startsWith('-')) return null;
  if (/^(\.{0,2}\/|~|[a-zA-Z]:[\\/]|file:|link:|portal:|workspace:|git\+|git:|github:|gitlab:|bitbucket:|https?:|ssh:)/.test(a)) return null;
  if (/\.(tgz|tar\.gz)$/i.test(a)) return null;
  let name;
  let spec = '';
  if (a.startsWith('@')) {
    const at = a.indexOf('@', 1);
    name = at === -1 ? a : a.slice(0, at);
    spec = at === -1 ? '' : a.slice(at + 1);
    if (!name.includes('/')) return null;
  } else {
    if (a.includes('/')) return null; // github shorthand user/repo
    const at = a.indexOf('@');
    name = at === -1 ? a : a.slice(0, at);
    spec = at === -1 ? '' : a.slice(at + 1);
  }
  if (spec.startsWith('npm:')) return parseNpmSpec(spec.slice(4)); // alias@npm:real@range
  if (/^(file:|link:|workspace:|git|github:|https?:)/.test(spec)) return null;
  if (!isNpmRegistryName(name)) return null;
  return { name, spec };
}

/** Parse a version value from package.json; returns the real registry name for aliases, or null if not registry. */
export function npmDependencyTarget(name, value) {
  const v = String(value ?? '').trim();
  if (/^(file:|link:|portal:|workspace:|git\+|git:|github:|gitlab:|bitbucket:|https?:|\.{0,2}\/|~)/.test(v)) return null;
  if (/^[\w.-]+\/[\w.-]+(#.*)?$/.test(v)) return null; // user/repo shorthand
  if (v.startsWith('npm:')) {
    const parsed = parseNpmSpec(v.slice(4));
    return parsed ? { name: parsed.name, spec: parsed.spec } : null;
  }
  if (!isNpmRegistryName(name)) return null;
  return { name, spec: v };
}

/**
 * Parse a PEP 508 requirement such as `requests[socks]>=2.31; python_version>"3.8"` or `numpy==1.26.4`.
 * Returns {name, spec} or null for URLs, paths, VCS links, options and blank lines.
 */
export function parsePipRequirement(line) {
  let s = String(line).replace(/\s+#.*$/, '').trim();
  if (!s || s.startsWith('#') || s.startsWith('-')) return null;
  if (/^(git\+|hg\+|svn\+|bzr\+|https?:|file:|\.{0,2}[\\/]|[a-zA-Z]:[\\/])/.test(s)) return null;
  if (/\.(whl|zip|tar\.gz|tgz)$/i.test(s)) return null;
  s = s.split(';')[0].trim();
  if (/\s@\s/.test(s)) return null; // name @ url
  const m = s.match(/^([A-Za-z0-9][A-Za-z0-9._-]*)\s*(\[[^\]]*\])?\s*(.*)$/);
  if (!m) return null;
  const spec = m[3].trim();
  return { name: normalizePypi(m[1]), spec };
}

/** Exact pinned version for a spec, if any: npm `1.2.3`, pip `==1.2.3`. */
export function exactVersion(ecosystem, spec) {
  const s = String(spec || '').trim();
  if (ecosystem === 'npm') return /^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(s) ? s : null;
  const m = s.match(/^===?\s*([\w.!+-]+)$/);
  return m && !m[1].includes('*') ? m[1] : null;
}
