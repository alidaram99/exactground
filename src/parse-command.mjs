// Find package installs in a shell command line. No I/O.
//
// Returns intents:
//   {kind:'package', ecosystem:'npm'|'pypi', name, spec, manager, raw}
//   {kind:'manifest', ecosystem, manager}          bare `npm install`, `uv sync`, `poetry install`...
//   {kind:'requirements', file, manager}           `pip install -r file`
//   {kind:'custom-index', manager}                 pip/uv with --index-url / --extra-index-url (private packages possible)

import { parseNpmSpec, parsePipRequirement } from './specs.mjs';

/** Split a command line into simple commands on && || ; | and newlines, respecting quotes. */
export function splitCommands(line) {
  const out = [];
  let cur = '';
  let q = null;
  const s = String(line);
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) {
      if (c === q) q = null;
      else if (c === '\\' && q === '"' && i + 1 < s.length) { cur += c + s[++i]; continue; }
      cur += c;
      continue;
    }
    if (c === '"' || c === "'") { q = c; cur += c; continue; }
    if (c === '\n' || c === ';' || c === '|' || (c === '&' && s[i + 1] === '&')) {
      if (c === '&' || (c === '|' && s[i + 1] === '|')) i++;
      out.push(cur);
      cur = '';
      continue;
    }
    if (c === '&') { out.push(cur); cur = ''; continue; }
    cur += c;
  }
  out.push(cur);
  return out.map((x) => x.trim()).filter(Boolean);
}

/** Tokenize a simple command (quotes and backslash escapes; no expansion). */
export function tokenize(cmd) {
  const toks = [];
  let cur = '';
  let q = null;
  let has = false;
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i];
    if (q) {
      if (c === q) { q = null; continue; }
      cur += c;
      continue;
    }
    if (c === '"' || c === "'") { q = c; has = true; continue; }
    if (/\s/.test(c)) {
      if (has || cur) toks.push(cur);
      cur = '';
      has = false;
      continue;
    }
    if (c === '\\' && i + 1 < cmd.length && /[\s"'\\]/.test(cmd[i + 1])) { cur += cmd[++i]; has = true; continue; }
    cur += c;
    has = true;
  }
  if (has || cur) toks.push(cur);
  return toks;
}

// Flags that take a value (so the value is not mistaken for a package name).
const NPM_VALUE_FLAGS = new Set(['--registry', '--prefix', '-C', '--dir', '--cwd', '--workspace', '-w', '--filter', '--tag', '--cache', '--userconfig', '--omit', '--include', '--loglevel', '--network-concurrency', '--package', '-p', '--call', '-c']);
const PIP_VALUE_FLAGS = new Set(['-i', '--index-url', '--extra-index-url', '-f', '--find-links', '-t', '--target', '--prefix', '--root', '-c', '--constraint', '--python', '-p', '--group', '--extra', '--platform', '--python-version', '--implementation', '--abi', '--only-binary', '--no-binary', '--upgrade-strategy', '--progress-bar', '--log', '--cache-dir', '--src', '--trusted-host', '--timeout', '--retries', '--index', '--default-index', '--source', '--optional', '--dev-dependency', '--package', '--with', '--from']);

function stripPrefix(toks) {
  let i = 0;
  while (i < toks.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(toks[i])) i++; // FOO=bar env assignments
  while (i < toks.length && ['sudo', 'env', 'time', 'command', 'exec', 'nohup'].includes(toks[i])) i++;
  return toks.slice(i);
}

const MANAGERS = ['npm', 'pnpm', 'yarn', 'bun', 'npx', 'bunx', 'pnpx', 'pip', 'pip3', 'uv', 'uvx', 'poetry', 'pdm', 'pipx', 'corepack', 'python', 'python3', 'py'];

/**
 * Executable name as the package-manager switch understands it: no directory, no .exe/.cmd/.bat/.ps1/.com suffix,
 * lower case, and Windows 8.3 short names (NPM~1.EXE, POETRY~1) mapped back to the manager they abbreviate (S2).
 */
export function baseName(t) {
  let b = String(t).replace(/\\/g, '/').split('/').pop().replace(/\.(exe|cmd|bat|ps1|com)$/i, '').toLowerCase();
  const short = b.match(/^([a-z0-9]{1,6})~\d+$/);
  if (short) {
    const hit = MANAGERS.find((m) => m === short[1] || (m.length > 6 && m.startsWith(short[1])));
    if (hit) b = hit;
  }
  return b;
}

function npmArgs(manager, args, intents, { executable = false } = {}) {
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--') continue;
    if (a.startsWith('-')) {
      if (NPM_VALUE_FLAGS.has(a) && !(a === '-w' && manager !== 'npm')) { // pnpm/yarn -w is --workspace-root (no value)
        if ((a === '--package' || a === '-p') && args[i + 1]) {
          const p = parseNpmSpec(args[i + 1]);
          if (p) intents.push({ kind: 'package', ecosystem: 'npm', ...p, manager, raw: args[i + 1] });
        }
        i++;
      }
      continue;
    }
    const p = parseNpmSpec(a);
    if (p) intents.push({ kind: 'package', ecosystem: 'npm', ...p, manager, raw: a });
    if (executable) break; // npx <pkg> args...: only the first positional is a package
  }
}

function pipArgs(manager, args, intents, { mode = 'install' } = {}) {
  let found = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '-r' || a === '--requirement' || a.startsWith('--requirement=') || /^-r\S/.test(a)) {
      const file = a.startsWith('--requirement=') ? a.split('=')[1] : a.length > 2 && a.startsWith('-r') ? a.slice(2) : args[++i];
      if (file) intents.push({ kind: 'requirements', file, manager });
      found = true;
      continue;
    }
    if (a === '-e' || a === '--editable') { i++; continue; }
    if (['-i', '--index-url', '--extra-index-url', '--index', '--default-index'].includes(a) || /^--(extra-)?index(-url)?=/.test(a)) {
      intents.push({ kind: 'custom-index', manager });
      if (!a.includes('=')) i++;
      continue;
    }
    if (a.startsWith('-')) {
      if (PIP_VALUE_FLAGS.has(a)) i++;
      continue;
    }
    const p = parsePipRequirement(a);
    if (p) { intents.push({ kind: 'package', ecosystem: 'pypi', ...p, manager, raw: a }); found = true; }
  }
  return found;
}

/** Install intents in one simple command. */
const INSTALLISH = /^(install|i|in|add|a|dlx|exec|x|sync|update|upgrade)$/i;
// A package-manager name anywhere in the text, also when split by quotes or concatenation (`'np'+'m'`).
const MANAGER_WORD = /(^|[^\w.-])(npm|pnpm|yarn|bun|npx|bunx|pnpx|pip[\d.]*|uv|uvx|poetry|pdm|pipx|corepack)(\.(exe|cmd|bat|ps1))?(?=$|[^\w-])/i;
const MANAGER_FRAGMENT = { test: (s) => MANAGER_WORD.test(s) || MANAGER_WORD.test(String(s).replace(/['"`^+]|\s*\+\s*/g, '')) };

export function intentsForCommand(cmd) {
  let toks = stripPrefix(tokenize(cmd));
  // PowerShell call operator / cmd `call` / `start`: `& npm install x`, `call npm install x`;
  // shell loop bodies split off by `;` (`do $p install x`, `then ...`).
  while (toks.length && ['&', 'call', '.', 'do', 'then', 'else'].includes(toks[0].toLowerCase())) toks = toks.slice(1);
  if (!toks.length) return [];
  // cmd caret escapes in the program name (`np^m install x` runs npm): drop the carets and check it normally (re-review 2).
  if (toks[0].includes('^')) toks = toks.map((t) => t.replace(/\^(.)/g, '$1'));
  const intents = [];
  const installish = toks.slice(1).some((t) => INSTALLISH.test(t)) || MANAGER_FRAGMENT.test(cmd);
  // An unresolved variable or expression as the program name (`$n install x`, `%PM% add x`) cannot be checked (S2).
  if (/^(\$|%|\$\{|\$\()/.test(toks[0]) && installish) {
    return [{ kind: 'opaque', reason: `the program name ${toks[0]} is a variable ExactGround cannot resolve` }];
  }
  // A program name built by an expression (`& ('np'+'m') install x`, `& ('npm') ...`, `& (Get-Command npm) ...`) (re-review 2).
  if (/^[([{]|[+^]/.test(toks[0]) && installish) {
    return [{ kind: 'opaque', reason: `the program name ${toks[0]} is an expression ExactGround cannot resolve` }];
  }
  // Loops whose body runs a command (`for %I in (npm) do %I install x`, `foreach ($p in 'npm') { & $p add x }`,
  // `'npm' | % { & $_ install x }`): the program is only known at run time (re-review 2).
  const bodyStart = toks.findIndex((t, i) => i > 0 && /^(do|\{)$/i.test(t));
  const loopInstall = MANAGER_FRAGMENT.test(cmd) || (bodyStart > 0 && toks.slice(bodyStart + 1).some((t) => INSTALLISH.test(t)));
  if (/^(for|foreach|foreach-object|%|while|until)$/i.test(toks[0]) && loopInstall) {
    return [{ kind: 'opaque', reason: `a ${toks[0]} loop runs a command ExactGround cannot resolve` }];
  }
  let tool = baseName(toks[0]);
  let rest = toks.slice(1);

  // python -m pip ..., py -m pip ..., python3 -m uv ...
  if (/^(python[\d.]*|py)$/.test(tool) && rest[0] === '-m' && rest[1]) {
    tool = rest[1].toLowerCase();
    rest = rest.slice(2);
  }
  if (/^pip[\d.]*$/.test(tool)) tool = 'pip';
  if (tool === 'corepack' && ['pnpm', 'yarn'].includes(rest[0])) { tool = rest[0]; rest = rest.slice(1); }

  // bash -lc "npm install x", sh -c '...', pwsh -Command "...", cmd /c "..."
  if (/^(bash|sh|zsh|dash|fish|pwsh|powershell|cmd)$/.test(tool)) {
    const i = rest.findIndex((t) => /^(-\w*c|\/c|-command)$/i.test(t));
    if (i < 0 || !rest[i + 1]) return [];
    // cmd /c and pwsh -Command take the rest of the line as the command (`cmd /c np^m install x`); sh -c takes one word.
    return parseCommand(/^(cmd|pwsh|powershell)$/.test(tool) ? rest.slice(i + 1).join(' ') : rest[i + 1]);
  }
  const sub = rest.find((t) => !t.startsWith('-'));
  const subIdx = rest.indexOf(sub);
  const after = subIdx >= 0 ? rest.slice(subIdx + 1) : [];

  switch (tool) {
    case 'npm':
      if (['install', 'i', 'in', 'ins', 'inst', 'insta', 'instal', 'isnt', 'isnta', 'isntal', 'isntall', 'add'].includes(sub)) {
        const before = intents.length;
        npmArgs('npm', after, intents);
        if (intents.length === before) intents.push({ kind: 'manifest', ecosystem: 'npm', manager: 'npm' });
      } else if (sub === 'exec' || sub === 'x') {
        npmArgs('npm', after, intents, { executable: true });
      }
      break;
    case 'pnpm':
      if (sub === 'add') npmArgs('pnpm', after, intents);
      else if (['install', 'i'].includes(sub)) {
        const before = intents.length;
        npmArgs('pnpm', after, intents);
        if (intents.length === before) intents.push({ kind: 'manifest', ecosystem: 'npm', manager: 'pnpm' });
      } else if (sub === 'dlx' || sub === 'exec') npmArgs('pnpm', after, intents, { executable: true });
      break;
    case 'yarn':
      if (sub === 'add') npmArgs('yarn', after, intents);
      else if (sub === 'dlx') npmArgs('yarn', after, intents, { executable: true });
      else if (sub === undefined || sub === 'install') intents.push({ kind: 'manifest', ecosystem: 'npm', manager: 'yarn' });
      break;
    case 'bun':
      if (sub === 'add' || sub === 'a') npmArgs('bun', after, intents);
      else if (['install', 'i'].includes(sub)) {
        const before = intents.length;
        npmArgs('bun', after, intents);
        if (intents.length === before) intents.push({ kind: 'manifest', ecosystem: 'npm', manager: 'bun' });
      } else if (sub === 'x') npmArgs('bun', after, intents, { executable: true });
      break;
    case 'npx':
    case 'bunx':
    case 'pnpx':
      npmArgs(tool, rest, intents, { executable: true });
      break;
    case 'pip':
      if (sub === 'install' || sub === 'download') pipArgs('pip', after, intents);
      break;
    case 'uv':
      if (sub === 'add') pipArgs('uv', after, intents);
      else if (sub === 'pip' && after[0] === 'install') pipArgs('uv', after.slice(1), intents);
      else if (sub === 'tool' && (after[0] === 'install' || after[0] === 'run')) pipArgs('uv', after.slice(1).filter((t) => !t.startsWith('-')).slice(0, 1), intents);
      else if (sub === 'sync') intents.push({ kind: 'manifest', ecosystem: 'pypi', manager: 'uv' });
      break;
    case 'uvx':
      pipArgs('uvx', rest.filter((t) => !t.startsWith('-')).slice(0, 1), intents);
      break;
    case 'pipx':
      if (sub === 'install' || sub === 'run') pipArgs('pipx', after.slice(0, 1), intents);
      break;
    case 'poetry':
      if (sub === 'add') pipArgs('poetry', after, intents);
      else if (sub === 'install' || sub === 'sync') intents.push({ kind: 'manifest', ecosystem: 'pypi', manager: 'poetry' });
      break;
    case 'pdm':
      if (sub === 'add') pipArgs('pdm', after, intents);
      else if (sub === 'install' || sub === 'sync') intents.push({ kind: 'manifest', ecosystem: 'pypi', manager: 'pdm' });
      break;
    default:
      break;
  }
  return intents;
}

/** All install intents in a full command line. */
const ASSIGN_SH = /^(?:export\s+|set\s+|local\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/i;
const ASSIGN_PS = /^\$([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/;

function unquote(v) {
  const t = String(v).trim();
  return /^(['"]).*\1$/.test(t) ? t.slice(1, -1) : t;
}

/** Replace $NAME, ${NAME} and %NAME% with values assigned earlier in the same command line. */
function substitute(cmd, vars) {
  return cmd
    .replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (m, n) => (n in vars ? vars[n] : m))
    .replace(/\$([A-Za-z_][A-Za-z0-9_]*)/g, (m, n) => (n in vars ? vars[n] : m))
    .replace(/%([A-Za-z_][A-Za-z0-9_]*)%/g, (m, n) => (n in vars ? vars[n] : m));
}

/**
 * All install intents in a full command line. Variables assigned earlier on the same line (`n=npm; $n install x`,
 * `$pm = "npm"; & $pm install x`, `set PM=npm && %PM% install x`) are resolved before parsing (S2).
 */
export function parseCommand(line) {
  const vars = {};
  const out = [];
  for (const raw of splitCommands(line)) {
    const cmd = substitute(raw, vars);
    const ps = cmd.match(ASSIGN_PS);
    if (ps) { vars[ps[1]] = unquote(ps[2]); continue; }
    const words = tokenize(cmd);
    if (words.length && words.every((w, i) => (i === 0 && /^(export|set|local)$/i.test(w)) || /^[A-Za-z_][A-Za-z0-9_]*=/.test(w))) {
      for (const w of words) {
        const m = w.match(ASSIGN_SH);
        if (m) vars[m[1]] = unquote(m[2]);
      }
      continue;
    }
    out.push(...intentsForCommand(cmd));
  }
  return out;
}
