// Trust boundary for the agent hooks (security review S1).
//
// The agent can write files in the project, so nothing it can write may relax the policy:
//  - A project `.exactground.json` is honoured by the hooks only after a human approves it with
//    `exactground trust` (sha256 recorded in the USER config dir). Any edit changes the hash and drops trust.
//  - The user-level config (outside every project) is always trusted.
//  - Tool calls that write `.exactground.json`, the user config dir or the cache dir are denied.

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DEFAULT_CONFIG } from './check.mjs';
import { cacheDir } from './registry.mjs';
import { splitCommands, tokenize } from './parse-command.mjs';

export const PROJECT_CONFIG = '.exactground.json';

export function userConfigDir(env = process.env) {
  if (env.EXACTGROUND_CONFIG_DIR) return env.EXACTGROUND_CONFIG_DIR;
  if (process.platform === 'win32' && env.APPDATA) return path.join(env.APPDATA, 'exactground');
  return path.join(env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'exactground');
}

const trustFile = (env) => path.join(userConfigDir(env), 'trusted-projects.json');
export const userConfigFile = (env = process.env) => path.join(userConfigDir(env), 'config.json');

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

export function sha256(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

/** Directory of the project: nearest ancestor with .git, else cwd. */
export function projectRoot(cwd) {
  let dir = path.resolve(cwd || '.');
  for (;;) {
    if (fs.existsSync(path.join(dir, '.git'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return path.resolve(cwd || '.');
    dir = parent;
  }
}

/** Nearest .exactground.json from cwd up to the project root, or null. */
export function findProjectConfig(cwd) {
  const root = projectRoot(cwd);
  let dir = path.resolve(cwd || '.');
  for (;;) {
    const f = path.join(dir, PROJECT_CONFIG);
    if (fs.existsSync(f)) return f;
    if (dir === root) return null;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

const norm = (p) => path.resolve(p).toLowerCase();

/** Record the current content hash of a project config as approved by the human. */
export function trustProjectConfig(file, env = process.env) {
  const full = path.resolve(file);
  const text = fs.readFileSync(full, 'utf8');
  JSON.parse(text); // refuse to trust invalid JSON
  const list = readJson(trustFile(env)) || {};
  list[norm(full)] = sha256(text);
  fs.mkdirSync(userConfigDir(env), { recursive: true });
  fs.writeFileSync(trustFile(env), JSON.stringify(list, null, 2) + '\n');
  return { file: full, hash: list[norm(full)] };
}

export function isTrusted(file, text, env = process.env) {
  const list = readJson(trustFile(env)) || {};
  return list[norm(file)] === sha256(text);
}

/**
 * Policy for the hook path: defaults with strict ON, then the user-level config, then a project config only if trusted.
 * Returns {config, notes[]}.
 */
export function loadHookConfig(cwd, env = process.env) {
  const notes = [];
  let config = { ...DEFAULT_CONFIG, strict: true };
  // S1 (re-review): the user-level config.json is just a file the agent's shell can write, so it gets the same
  // treatment as a project file: honoured only when its exact content was approved with `exactground trust --user`.
  const uf = userConfigFile(env);
  if (fs.existsSync(uf)) {
    let text = '';
    try { text = fs.readFileSync(uf, 'utf8'); } catch { /* unreadable */ }
    if (text && isTrusted(uf, text, env)) {
      try { config = { ...config, ...JSON.parse(text) }; } catch { notes.push(`${uf} is not valid JSON; ignored`); }
    } else if (text) {
      notes.push(`${uf} is not approved, so its settings are ignored. If you wrote it, run \`exactground trust --user\` in a terminal.`);
    }
  }
  const file = findProjectConfig(cwd);
  if (file) {
    let text = '';
    try { text = fs.readFileSync(file, 'utf8'); } catch { /* unreadable */ }
    if (text && isTrusted(file, text, env)) {
      try { config = { ...config, ...JSON.parse(text) }; } catch { notes.push(`${file} is not valid JSON; ignored`); }
    } else {
      notes.push(`${file} is not approved, so its allow-list and settings are ignored. If you wrote it, run \`exactground trust\` in a terminal to approve this exact content.`);
    }
  }
  return { config, notes };
}

/**
 * The file a path really names on NTFS: `.exactground.json::$DATA` and `.exactground.json:x` are streams of
 * `.exactground.json` (re-review 2), and Windows drops trailing dots and spaces. A drive colon (`C:`) is kept.
 */
export function stripStream(p) {
  const s = String(p);
  const cut = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\'));
  const dir = s.slice(0, cut + 1);
  let name = s.slice(cut + 1);
  const drive = cut < 0 && /^[A-Za-z]:/.test(name) ? name.slice(0, 2) : '';
  name = name.slice(drive.length);
  const colon = name.indexOf(':');
  if (colon > 0) name = name.slice(0, colon);
  if (!/^\.+$/.test(name)) name = name.replace(/[. ]+$/, '');
  return dir + drive + (name || (dir || drive ? '' : s));
}

/** True if a path is one the agent must not write: a project config, the user config dir, or the cache dir. */
export function isProtectedPath(p, cwd, env = process.env) {
  if (!p) return false;
  const full = path.resolve(cwd || '.', stripStream(String(p)));
  if (path.basename(full).toLowerCase() === PROJECT_CONFIG) return true;
  const inside = (dir) => {
    const rel = path.relative(path.resolve(dir), full);
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
  };
  return inside(userConfigDir(env)) || inside(cacheDir(env));
}

// Programs that only read: a command made of these (and no output redirection) may mention protected files.
const READ_ONLY = new Set(['cat', 'type', 'more', 'less', 'head', 'tail', 'get-content', 'gc', 'grep', 'rg', 'findstr', 'select-string',
  'sls', 'ls', 'dir', 'get-childitem', 'gci', 'stat', 'wc', 'jq', 'test-path', 'file', 'git', 'exactground']);
// Inline interpreters and write APIs used to build file paths dynamically (`'exact'+'ground'`).
const INLINE = /\b(node|deno|bun|python[\d.]*|py|ruby|perl|php|pwsh|powershell)(\.exe)?\s+(-e|-c|-p|-r|--eval|--print|-command|-encodedcommand|-enc)\b/i;
const WRITE_API = /(writeFile|appendFile|copyFile|cpSync|renameSync|rename\(|createWriteStream|WriteAllText|WriteAllBytes|AppendAllText|File\]::Copy|File\]::Move|Copy-Item|Move-Item|Set-Content|Add-Content|Out-File|New-Item|open\(|shutil\.|os\.replace|Path\(.*\)\.write|\.write_text|\.write_bytes|>)/i;
const POLICY_HINT = /(exact|(?<![a-z])ground|trusted|registry-cache|appdata|xdg_config|\.config|\.cache)/i;
// Shell verbs that write or replace files (in addition to WRITE_API).
const SHELL_WRITE = /(^|[\s;&|({])(cp|copy|mv|move|ren|rename|xcopy|robocopy|rsync|tee|ln|mklink|dd|ni|sc|ac|cpi|mi|rni|Rename-Item|Set-ItemProperty|Export-Clixml|ConvertTo-Json\s.*\|\s*Set-Content)(?=$|[\s;&|)])/i;
// ExactGround's own file and directory names, after quotes and concatenation are removed (`'ex'+'actground'`).
const POLICY_NAME = /exactground|trusted-?projects|registry-cache/i;
// Environment variables that point straight at ExactGround's directories.
const OWN_DIR_VAR = /EXACTGROUND_(CONFIG|CACHE)_DIR/i;
// The per-user directories ExactGround's config, approvals and cache live under.
const USER_DIR_REF = /\$env:(APPDATA|LOCALAPPDATA|USERPROFILE|HOME|XDG_CONFIG_HOME|XDG_CACHE_HOME)\b|%(APPDATA|LOCALAPPDATA|USERPROFILE|HOME|XDG_CONFIG_HOME|XDG_CACHE_HOME)%|\$\{?(HOME|XDG_CONFIG_HOME|XDG_CACHE_HOME)\b|GetFolderPath|SpecialFolder|(^|[\s'"(=,])~(?=[\\/'"\s)]|$)/i;
// A path assembled at run time rather than written out.
const DYNAMIC_PATH = /Join-Path|\[(System\.)?IO\.Path\]::Combine|\s-f\s|\+|\$\(|path\.join|os\.path\.join|(APPDATA|USERPROFILE|HOME|XDG_CONFIG_HOME|XDG_CACHE_HOME|~)%?\}?[\\/][^\s'";|]*[$%]/i;

/** The command with quotes, backticks, carets and `+` concatenation removed, so split names read whole. */
function collapse(c) {
  return String(c).replace(/['"`^]/g, '').replace(/\s*\+\s*/g, '');
}

function protectedMention(c, env) {
  if (/\.exactground\.json/i.test(c) || /trusted-projects\.json|registry-cache\.json/i.test(c)) return true;
  for (const dir of [userConfigDir(env), cacheDir(env)]) {
    for (const v of [dir, dir.replace(/\\/g, '/')]) if (c.toLowerCase().includes(v.toLowerCase())) return true;
  }
  return /[\\/]\.?config[\\/]exactground|[\\/]\.cache[\\/]exactground|AppData[\\/](Roaming|Local)[\\/]exactground|%APPDATA%[\\/]exactground|\$env:APPDATA[\\/]exactground/i.test(c);
}

/**
 * A shell command that may write ExactGround's own policy, approval or cache files (S1, re-review).
 * Any simple command that mentions those files is denied unless its program only reads and nothing is redirected,
 * whatever the verb (copy, xcopy, robocopy, move, [IO.File]::WriteAllText, Out-File, redirection, ...).
 * Inline interpreter scripts that call a write API and build a policy-looking path are denied too.
 */
export function shellTouchesProtected(command, env = process.env) {
  const c = String(command || '');
  const joined = collapse(c);
  if (INLINE.test(c) && WRITE_API.test(c) && (POLICY_HINT.test(c) || POLICY_HINT.test(joined))) return true;
  // Re-review 2: a write whose target is built at run time (Join-Path, `+`, -f, env vars) is denied when the command
  // names ExactGround's files in any split form, or builds a path from the directories they live in.
  const w = c.replace(/\d*>\s*&\s*\d|\d*>\s*(\/dev\/null|\$null|nul)\b/gi, '');
  if (WRITE_API.test(w) || SHELL_WRITE.test(w)) {
    if (POLICY_NAME.test(joined)) return true;
    if (OWN_DIR_VAR.test(c)) return true;
    if (USER_DIR_REF.test(c) && DYNAMIC_PATH.test(c)) return true;
  }
  for (const simple of splitCommands(c)) {
    if (!protectedMention(simple, env)) continue;
    const prog = (tokenize(simple)[0] || '').replace(/\\/g, '/').split('/').pop().replace(/\.(exe|cmd|bat|ps1|com)$/i, '').toLowerCase();
    const readOnly = READ_ONLY.has(prog) && !/>/.test(simple) && !/\btee\b/i.test(simple) && !(prog === 'git' && !/^git\s+(status|diff|log|show|ls-files)\b/i.test(simple.trim()));
    if (!readOnly) return true;
  }
  return false;
}
