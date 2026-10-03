// From an agent action (shell command, file write/edit, patch) to the dependencies it would introduce.

import fs from 'node:fs';
import path from 'node:path';
import { parseCommand } from './parse-command.mjs';
import { addedDeps, manifestType, ecosystemOf, unlockedManifestDeps, requirementsFileDeps } from './manifest.mjs';
import { projectRoot } from './trust.mjs';

function readFile(file) {
  try { return fs.readFileSync(file, 'utf8'); } catch { return ''; }
}

// Installs the parser cannot see into (security review S2): inline scripts, command substitution, eval.
const INSTALL_WORDS = /\b(npm|pnpm|yarn|bun|npx|bunx|pip[\d.]*|uv|uvx|poetry|pdm|pipx)\b[^\n;|&]{0,40}\b(install|add|i|dlx|exec|sync)\b|\b(npx|uvx|bunx)\b/;
const OPAQUE = [
  /\b(node|deno|bun|python[\d.]*|py|ruby|perl|php|pwsh|powershell)(\.exe)?\s+(-e|-c|-p|--eval|--print|-command)\b/i,
  /\$\(|`/,
  /\beval\b/,
];

/** True if the command contains an install that ExactGround cannot parse (it would run unchecked). */
export function hasOpaqueInstall(command) {
  const c = String(command || '');
  return INSTALL_WORDS.test(c) && OPAQUE.some((re) => re.test(c));
}

/** Deps introduced by a shell command line run in `cwd`. Returns {deps, customIndex, notes, errors, opaque}. */
export function depsFromCommand(command, cwd) {
  const intents = parseCommand(command);
  const deps = [];
  const notes = [];
  const errors = [];
  let customIndex = false;
  const root = projectRoot(cwd);
  for (const it of intents) {
    if (it.kind === 'package') deps.push({ ecosystem: it.ecosystem, name: it.name, spec: it.spec, source: `${it.manager} command` });
    else if (it.kind === 'custom-index') customIndex = true;
    else if (it.kind === 'requirements') {
      const found = requirementsFileDeps(it.file, cwd, root);
      deps.push(...found.deps.map((d) => ({ ...d, source: it.file })));
      errors.push(...found.errors);
    } else if (it.kind === 'manifest') {
      const { dir, deps: un } = unlockedManifestDeps(cwd, it.ecosystem);
      deps.push(...un.map((d) => ({ ...d, source: `${it.ecosystem === 'npm' ? 'package.json' : 'pyproject.toml'} (not in lockfile)` })));
      if (!dir) notes.push(`${it.manager}: no manifest found from ${cwd}`);
    }
  }
  return { deps, customIndex, notes, errors, opaque: hasOpaqueInstall(command), intents: intents.length };
}

/** Deps added by writing `newText` to `file` (compares with what is on disk now). */
export function depsFromFileWrite(file, newText, cwd) {
  const type = manifestType(file);
  if (!type) return [];
  const full = path.resolve(cwd || '.', file);
  return addedDeps(type, readFile(full), newText).map((d) => ({ ...d, source: `edit to ${path.basename(file)}` }));
}

/** Apply exact-string edits (Claude Edit/MultiEdit, Gemini replace) to the current file text. */
export function applyEdits(text, edits) {
  let out = text;
  for (const e of edits) {
    if (e.old_string == null || !out.includes(e.old_string)) continue;
    out = e.replace_all ? out.split(e.old_string).join(e.new_string ?? '') : out.replace(e.old_string, () => e.new_string ?? '');
  }
  return out;
}

export function depsFromFileEdit(file, edits, cwd) {
  const type = manifestType(file);
  if (!type) return [];
  const full = path.resolve(cwd || '.', file);
  const before = readFile(full);
  return addedDeps(type, before, applyEdits(before, edits)).map((d) => ({ ...d, source: `edit to ${path.basename(file)}` }));
}

/**
 * Deps added by a unified diff or a Codex apply_patch body. For manifest files the added lines are parsed;
 * for package.json, `"name": "range"` lines inside dependency blocks are taken as additions.
 */
export function depsFromPatch(patch) {
  const deps = [];
  let file = null;
  let removed = new Set();
  let block = null; // current package.json object key, tracked from context and added lines
  let sawOpener = false;
  const DEP_BLOCKS = new Set(['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']);
  const lines = String(patch).split(/\r?\n/);
  for (const line of lines) {
    const f = line.match(/^\*\*\* (?:Add|Update) File: (.+)$/) || line.match(/^\+\+\+ (?:b\/)?(.+)$/);
    if (f) { file = f[1].trim(); removed = new Set(); block = null; sawOpener = false; continue; }
    if (/^\*\*\* (Delete File|End Patch|Begin Patch)/.test(line)) { file = null; continue; }
    const type = file && manifestType(file);
    if (!type) continue;
    if (type === 'package.json' && !line.startsWith('-')) {
      const content = line.slice(1);
      const open = content.match(/^\s*"([^"]+)"\s*:\s*\{/);
      if (open) { block = open[1]; sawOpener = true; }
      else if (/^\s*\}/.test(content)) block = null;
    }
    if (line.startsWith('-') && !line.startsWith('---')) { removed.add(line.slice(1).trim()); continue; }
    if (!line.startsWith('+') || line.startsWith('+++')) continue;
    const body = line.slice(1).trim();
    if (removed.has(body)) continue;
    if (type === 'package.json') {
      const m = body.match(/^"((?:@[^"/]+\/)?[^"/]+)"\s*:\s*"([^"]*)"\s*,?$/);
      // Hunks may start inside a block without showing its opener; then accept version-looking values only.
      const looksVersion = m && /^(\^|~|>=?|<=?|=)?\s*v?\d|^\*$|^(latest|next)$/.test(m[2]);
      if (m && (DEP_BLOCKS.has(block) || (!sawOpener && block === null && looksVersion))) {
        const tmp = addedDeps('package.json', '{}', JSON.stringify({ dependencies: { [m[1]]: m[2] } }));
        deps.push(...tmp.map((d) => ({ ...d, source: `patch to ${path.basename(file)}` })));
      }
    } else {
      const text = type === 'requirements' ? body : `[project]\ndependencies = [${body.replace(/,$/, '')}]`;
      const tmp = addedDeps(type, '', text);
      deps.push(...tmp.map((d) => ({ ...d, source: `patch to ${path.basename(file)}` })));
    }
  }
  return deps;
}

export { ecosystemOf };
