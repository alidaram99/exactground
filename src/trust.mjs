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

export const PROJECT_CONFIG = '.exactground.json';

export function userConfigDir(env = process.env) {
  if (env.EXACTGROUND_CONFIG_DIR) return env.EXACTGROUND_CONFIG_DIR;
  if (process.platform === 'win32' && env.APPDATA) return path.join(env.APPDATA, 'exactground');
  return path.join(env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'exactground');
}

const trustFile = (env) => path.join(userConfigDir(env), 'trusted-projects.json');
const userConfigFile = (env) => path.join(userConfigDir(env), 'config.json');

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
  const user = readJson(userConfigFile(env));
  if (user && typeof user === 'object') config = { ...config, ...user };
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

/** True if a path is one the agent must not write: a project config, the user config dir, or the cache dir. */
export function isProtectedPath(p, cwd, env = process.env) {
  if (!p) return false;
  const full = path.resolve(cwd || '.', String(p));
  if (path.basename(full).toLowerCase() === PROJECT_CONFIG) return true;
  const inside = (dir) => {
    const rel = path.relative(path.resolve(dir), full);
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
  };
  return inside(userConfigDir(env)) || inside(cacheDir(env));
}

const WRITE_VERB = /(>|>>|\btee\b|\bcp\b|\bmv\b|\bln\b|\brm\b|\bdel\b|\bsed\s+-i|\bperl\s+-i|\btouch\b|\btruncate\b|Set-Content|Add-Content|Out-File|Copy-Item|Move-Item|Remove-Item|New-Item|writeFile|open\()/;

/** A shell command that writes ExactGround's own policy, trust or cache files. */
export function shellTouchesProtected(command, env = process.env) {
  const c = String(command || '');
  if (!WRITE_VERB.test(c)) return false;
  if (c.includes(PROJECT_CONFIG)) return true;
  for (const dir of [userConfigDir(env), cacheDir(env)]) {
    const variants = [dir, dir.replace(/\\/g, '/'), 'trusted-projects.json', 'registry-cache.json'];
    if (variants.some((v) => c.includes(v))) return true;
  }
  return /[\\/]\.?config[\\/]exactground|[\\/]\.cache[\\/]exactground|AppData[\\/](Roaming|Local)[\\/]exactground/i.test(c);
}
