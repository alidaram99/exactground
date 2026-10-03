// Hook configuration snippets for each agent, and a safe merge into a project's config file.

import fs from 'node:fs';
import path from 'node:path';

const MARK = 'exactground';
const fwd = (p) => p.replace(/\\/g, '/');

/** {file, config} for a vendor, using an absolute path to this checkout's CLI. */
export function hookConfig(vendor, root) {
  const cli = fwd(path.join(root, 'bin', 'exactground.mjs'));
  const shell = (v) => `node "${cli}" hook ${v}`;
  switch (vendor) {
    case 'claude':
      return {
        file: '.claude/settings.json',
        config: { hooks: { PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: 'node', args: [cli, 'hook', 'claude'], timeout: 15 }] }] } },
      };
    case 'codex':
      return {
        file: '.codex/hooks.json',
        config: { hooks: { PreToolUse: [{ matcher: '.*', hooks: [{ type: 'command', command: shell('codex'), timeout: 15 }] }] } },
      };
    case 'gemini':
      return {
        file: '.gemini/settings.json',
        config: { hooks: { BeforeTool: [{ matcher: '.*', hooks: [{ type: 'command', name: MARK, command: shell('gemini'), timeout: 15000 }] }] } },
      };
    case 'cursor':
      return {
        file: '.cursor/hooks.json',
        config: { version: 1, hooks: { beforeShellExecution: [{ command: shell('cursor'), timeout: 15 }], preToolUse: [{ command: shell('cursor'), timeout: 15 }] } },
      };
    default:
      throw new Error(`unknown vendor ${vendor}`);
  }
}

/** Merge the vendor's hook into <project>/<file>, keeping every existing hook. Idempotent. */
export function installHooks(vendor, projectDir, root) {
  const { file, config } = hookConfig(vendor, root);
  const full = path.join(projectDir, file);
  let current = {};
  if (fs.existsSync(full)) current = JSON.parse(fs.readFileSync(full, 'utf8'));
  if (JSON.stringify(current).includes('exactground')) return { file: full, changed: false };
  const merged = { ...current, ...(config.version ? { version: current.version ?? config.version } : {}), hooks: { ...(current.hooks || {}) } };
  for (const [event, entries] of Object.entries(config.hooks)) merged.hooks[event] = [...(merged.hooks[event] || []), ...entries];
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, JSON.stringify(merged, null, 2) + '\n');
  return { file: full, changed: true };
}
