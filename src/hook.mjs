// Agent hook adapters: Claude Code (PreToolUse), Codex (PreToolUse), Gemini CLI (BeforeTool), Cursor
// (beforeShellExecution / preToolUse). Reads the host's JSON, returns the host's JSON. Never throws: on any
// internal error the action is allowed and a note goes to stderr (hooks fail open; see README "Limits").

import { depsFromCommand, depsFromFileWrite, depsFromFileEdit, depsFromPatch } from './analyze.mjs';
import { checkDeps, describe, loadConfig } from './check.mjs';
import { Cache } from './registry.mjs';

export const VENDORS = ['claude', 'codex', 'gemini', 'cursor'];

const SHELL_TOOLS = new Set(['Bash', 'Shell', 'run_shell_command', 'shell', 'exec_command', 'local_shell', 'container.exec', 'terminal']);
const WRITE_TOOLS = new Set(['Write', 'write_file', 'create_file']);
const EDIT_TOOLS = new Set(['Edit', 'MultiEdit', 'replace', 'edit_file', 'str_replace_based_edit_tool']);
const PATCH_TOOLS = new Set(['apply_patch']);

const SHELLS = /^(?:.*[\/])?(bash|sh|zsh|dash|fish|pwsh|powershell|cmd)(\.exe)?$/i;
/** Codex may send argv arrays such as ["bash", "-lc", "npm install x"]; unwrap the shell to the script. */
export function commandText(c) {
  if (!Array.isArray(c)) return String(c ?? '');
  if (c.length >= 3 && SHELLS.test(c[0]) && /^(-\w*c|\/c|-command)$/i.test(c[1])) return String(c[2]);
  return c.map((t) => (/\s/.test(t) ? JSON.stringify(t) : t)).join(' ');
}

/** Work out which deps an agent action would introduce. */
export function depsForEvent(ev) {
  const cwd = ev.cwd || process.cwd();
  const tool = ev.tool_name;
  const input = ev.tool_input || {};
  // Cursor beforeShellExecution sends {command, cwd} at the top level.
  if (!tool && typeof ev.command === 'string') return depsFromCommand(ev.command, cwd);
  if (SHELL_TOOLS.has(tool)) return depsFromCommand(commandText(input.command ?? input.cmd), cwd);
  if (PATCH_TOOLS.has(tool)) return { deps: depsFromPatch(commandText(input.command ?? input.patch ?? input.input)), customIndex: false, notes: [] };
  const file = input.file_path ?? input.path ?? input.filePath;
  if (file && WRITE_TOOLS.has(tool)) return { deps: depsFromFileWrite(file, input.content ?? '', cwd), customIndex: false, notes: [] };
  if (file && EDIT_TOOLS.has(tool)) {
    const edits = Array.isArray(input.edits) ? input.edits : [input];
    return { deps: depsFromFileEdit(file, edits, cwd), customIndex: false, notes: [] };
  }
  return { deps: [], customIndex: false, notes: [] };
}

function message(results) {
  const blocked = results.filter((r) => r.verdict === 'block');
  const warned = results.filter((r) => r.verdict === 'warn' || r.verdict === 'unknown');
  const lines = [];
  if (blocked.length) {
    lines.push(`ExactGround blocked this action: ${blocked.length} package${blocked.length > 1 ? 's' : ''} failed the registry check.`);
    lines.push(...blocked.map(describe));
    lines.push('Use a package that exists (check the official docs), fix the name/version, or add a deliberate exception to .exactground.json "allow".');
  }
  if (warned.length) {
    if (!blocked.length) lines.push('ExactGround: allowed, with warnings. Verify these packages before relying on them:');
    lines.push(...warned.map(describe));
  }
  return lines.join('\n');
}

/** Format a decision for a vendor. decision: 'deny' | 'warn' | 'allow'. */
export function formatOutput(vendor, decision, text, ev = {}) {
  const cursorShell = vendor === 'cursor' && !ev.tool_name;
  switch (vendor) {
    case 'claude':
    case 'codex':
      if (decision === 'deny') return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: text } };
      if (decision === 'warn') return { systemMessage: text, hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: text } };
      return {};
    case 'gemini':
      if (decision === 'deny') return { decision: 'deny', reason: text, systemMessage: text.split('\n')[0] };
      if (decision === 'warn') return { decision: 'allow', systemMessage: text };
      return {};
    case 'cursor':
      if (decision === 'deny') return { permission: 'deny', user_message: text.split('\n')[0], agent_message: text };
      if (decision === 'warn') return cursorShell ? { permission: 'allow', agent_message: text } : { permission: 'allow' };
      return { permission: 'allow' };
    default:
      throw new Error(`unknown vendor ${vendor}`);
  }
}

/** Evaluate one hook event. Returns {decision, text, results, output}. */
export async function evaluate(vendor, ev, { fetchImpl, cache, now, timeoutMs = 4000 } = {}) {
  const { deps, customIndex } = depsForEvent(ev);
  if (!deps.length) return { decision: 'allow', text: '', results: [], output: formatOutput(vendor, 'allow', '', ev) };
  const config = loadConfig(ev.cwd || process.cwd());
  const ownCache = cache ?? new Cache();
  const results = await checkDeps(deps, { config, cache: ownCache, fetchImpl, now, customIndex, timeoutMs });
  if (!cache) ownCache.save();
  const decision = results.some((r) => r.verdict === 'block') ? 'deny'
    : results.some((r) => r.verdict === 'warn' || r.verdict === 'unknown') ? 'warn' : 'allow';
  const text = message(results);
  return { decision, text, results, output: formatOutput(vendor, decision, text, ev) };
}

async function readStdin() {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString('utf8');
}

/** CLI entry: `exactground hook <vendor>`. Prints exactly one JSON object; exit code 0. */
export async function runHook(vendor) {
  if (!VENDORS.includes(vendor)) {
    process.stderr.write(`exactground hook: vendor must be one of ${VENDORS.join(', ')}\n`);
    process.stdout.write('{}\n');
    return 0;
  }
  let ev = {};
  try {
    ev = JSON.parse((await readStdin()) || '{}');
    const res = await evaluate(vendor, ev);
    if (res.decision !== 'allow') process.stderr.write(res.text + '\n');
    process.stdout.write(JSON.stringify(res.output) + '\n');
  } catch (err) {
    process.stderr.write(`exactground: internal error, action allowed (${err?.message || err})\n`);
    process.stdout.write(JSON.stringify(formatOutput(vendor, 'allow', '', ev)) + '\n');
  }
  return 0;
}
