// Agent hook adapters: Claude Code (PreToolUse), Codex (PreToolUse), Gemini CLI (BeforeTool), Cursor
// (beforeShellExecution / preToolUse). Reads the host's JSON, returns the host's JSON.
//
// Security posture (review S1/S2): on the hook path every package is re-checked against the registry (the local
// cache is never trusted to allow), strict mode is the default (registry unreachable -> deny), a project
// .exactground.json counts only after a human runs `exactground trust`, the agent may not write ExactGround's own
// policy/trust/cache files, installs hidden inside inline scripts are denied, and an internal error DENIES the
// action (set EXACTGROUND_FAIL_OPEN=1 to allow on internal errors instead).

import path from 'node:path';
import { depsFromCommand, depsFromFileWrite, depsFromFileEdit, depsFromPatch } from './analyze.mjs';
import { checkDeps, describe } from './check.mjs';
import { loadHookConfig, isProtectedPath, shellTouchesProtected } from './trust.mjs';

export const VENDORS = ['claude', 'codex', 'gemini', 'cursor'];

const SHELL_TOOLS = new Set(['Bash', 'Shell', 'run_shell_command', 'shell', 'exec_command', 'local_shell', 'container.exec', 'terminal']);
const WRITE_TOOLS = new Set(['Write', 'write_file', 'create_file']);
const EDIT_TOOLS = new Set(['Edit', 'MultiEdit', 'replace', 'edit_file', 'str_replace_based_edit_tool']);
const PATCH_TOOLS = new Set(['apply_patch']);
// Tools that only read. Everything else has its path-like arguments checked against the protected files.
const READ_ONLY_TOOL = /^(Read|Grep|Glob|LS|NotebookRead|WebFetch|WebSearch|TodoWrite|read_file|read_many_files|list_directory|glob|search_file_content|grep|web_fetch|google_web_search|view|mcp__.*__(read|get|list|search|find|view|stat)[\w-]*)$/i;
const PATH_KEY = /(path|file|target|dest|destination|notebook|uri|filename|dir|directory|source|output)/i;

/** String values of path-like keys anywhere in a tool input (nested objects and arrays included). */
function pathLikeValues(input, depth = 0, out = []) {
  if (!input || typeof input !== 'object' || depth > 4) return out;
  for (const [k, v] of Object.entries(input)) {
    if (typeof v === 'string' && PATH_KEY.test(k) && v.length < 4096) out.push(v);
    else if (v && typeof v === 'object') pathLikeValues(v, depth + 1, out);
  }
  return out;
}

const SHELLS = /^(?:.*[\/])?(bash|sh|zsh|dash|fish|pwsh|powershell|cmd)(\.exe)?$/i;
/** Codex may send argv arrays such as ["bash", "-lc", "npm install x"]; unwrap the shell to the script. */
export function commandText(c) {
  if (!Array.isArray(c)) return String(c ?? '');
  if (c.length >= 3 && SHELLS.test(c[0]) && /^(-\w*c|\/c|-command)$/i.test(c[1])) return String(c[2]);
  return c.map((t) => (/\s/.test(t) ? JSON.stringify(t) : t)).join(' ');
}

const EMPTY = { deps: [], customIndex: false, notes: [], errors: [], opaque: false };

/** Files a patch adds, updates, moves or deletes (Codex apply_patch and unified diffs). */
function patchFiles(patch) {
  const out = [];
  for (const line of String(patch).split(/\r?\n/)) {
    const m = line.match(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/) || line.match(/^\*\*\* Move to: (.+)$/) || line.match(/^(?:\+\+\+|---) (?:[ab]\/)?(.+?)\s*$/);
    if (m && m[1] !== '/dev/null') out.push(m[1].trim());
  }
  return out;
}

/** Work out what an agent action would do: deps it introduces, protected files it writes, unparsable installs. */
export function depsForEvent(ev) {
  const cwd = ev.cwd || process.cwd();
  const tool = ev.tool_name;
  const input = ev.tool_input || {};
  // Cursor beforeShellExecution sends {command, cwd} at the top level.
  // S2 (re-review): any tool whose input carries a command string is a shell, whatever it is called
  // (Claude Code's PowerShell tool, vendor-specific shell names, future tools).
  const carriesCommand = typeof input.command === 'string' || Array.isArray(input.command) || typeof input.cmd === 'string';
  const shell = !tool && typeof ev.command === 'string' ? ev.command
    : (SHELL_TOOLS.has(tool) || (carriesCommand && !PATCH_TOOLS.has(tool))) ? commandText(input.command ?? input.cmd) : null;
  if (shell != null) {
    const r = depsFromCommand(shell, cwd);
    return { ...r, protectedWrite: shellTouchesProtected(shell) ? 'a shell command that writes ExactGround policy, trust or cache files' : null };
  }
  if (PATCH_TOOLS.has(tool)) {
    const patch = commandText(input.command ?? input.patch ?? input.input);
    const prot = patchFiles(patch).find((f) => isProtectedPath(f, cwd));
    return { ...EMPTY, deps: depsFromPatch(patch), protectedWrite: prot ? `a patch to ${prot}` : null };
  }
  const file = input.file_path ?? input.path ?? input.filePath;
  // S1 (re-review): check the paths of EVERY tool that is not read-only (NotebookEdit, MCP filesystem tools, ...).
  if (!READ_ONLY_TOOL.test(String(tool || ''))) {
    const hit = pathLikeValues(input).find((p) => isProtectedPath(p, cwd));
    if (hit) return { ...EMPTY, protectedWrite: `a ${tool || 'tool'} call on ${path.basename(String(hit))}` };
  }
  if (file && WRITE_TOOLS.has(tool)) return { ...EMPTY, deps: depsFromFileWrite(file, input.content ?? '', cwd) };
  if (file && EDIT_TOOLS.has(tool)) {
    const edits = Array.isArray(input.edits) ? input.edits : [input];
    return { ...EMPTY, deps: depsFromFileEdit(file, edits, cwd) };
  }
  return { ...EMPTY };
}

function message(results) {
  const blocked = results.filter((r) => r.verdict === 'block');
  const warned = results.filter((r) => r.verdict === 'warn' || r.verdict === 'unknown');
  const lines = [];
  if (blocked.length) {
    lines.push(`ExactGround blocked this action: ${blocked.length} package${blocked.length > 1 ? 's' : ''} failed the registry check.`);
    lines.push(...blocked.map(describe));
    lines.push('Use a package that exists (check the official docs) or fix the name/version. A human can allow a private name in .exactground.json "allow" and approve it with `exactground trust`.');
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

/**
 * Evaluate one hook event. Returns {decision, text, results, output}.
 * `cache` exists for tests only: by default the hook path re-fetches every package and never allows from cache (S1).
 */
export async function evaluate(vendor, ev, { fetchImpl, cache = null, now, timeoutMs = 4000, env = process.env } = {}) {
  const cwd = ev.cwd || process.cwd();
  const { deps, customIndex, errors = [], opaque, protectedWrite } = depsForEvent(ev);
  const deny = (text) => ({ decision: 'deny', text, results: [], output: formatOutput(vendor, 'deny', text, ev) });
  if (protectedWrite) {
    return deny(`ExactGround blocked ${protectedWrite}. The agent may not change ExactGround's own policy, approvals or cache.\n`
      + 'To change the policy, a human edits .exactground.json and then runs `exactground trust` in a terminal to approve that exact content.');
  }
  if (errors.length) {
    return deny(`ExactGround blocked this install: a requirements file could not be checked safely.\n${errors.map((e) => `  - ${e}`).join('\n')}\n`
      + 'Keep requirements files inside the project as regular files (no symlinks, at most 256 KB).');
  }
  if (opaque) {
    return deny('ExactGround blocked this command: it installs packages from inside an inline script, command substitution or eval, '
      + 'which cannot be checked. Run the install as a plain command (for example `npm install <name>` or `pip install <name>`) so the names can be verified.');
  }
  if (!deps.length) return { decision: 'allow', text: '', results: [], output: formatOutput(vendor, 'allow', '', ev) };
  const { config, notes } = loadHookConfig(cwd, env);
  const results = await checkDeps(deps, { config, cache, fetchImpl, now, customIndex, timeoutMs });
  let decision = results.some((r) => r.verdict === 'block') ? 'deny'
    : results.some((r) => r.verdict === 'warn' || r.verdict === 'unknown') ? 'warn' : 'allow';
  if (decision === 'allow' && notes.length) decision = 'warn';
  const text = [message(results), ...notes.map((n) => `Note: ${n}`)].filter(Boolean).join('\n');
  return { decision, text, results, output: formatOutput(vendor, decision, text, ev) };
}

async function readStdin() {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString('utf8');
}

/** CLI entry: `exactground hook <vendor>`. Prints exactly one JSON object; exit code 0. */
export async function runHook(vendor, env = process.env) {
  if (!VENDORS.includes(vendor)) {
    process.stderr.write(`exactground hook: vendor must be one of ${VENDORS.join(', ')}\n`);
    process.stdout.write('{}\n');
    return 0;
  }
  let ev = {};
  try {
    ev = JSON.parse((await readStdin()) || '{}');
    const res = await evaluate(vendor, ev, { env });
    if (res.decision !== 'allow') process.stderr.write(res.text + '\n');
    process.stdout.write(JSON.stringify(res.output) + '\n');
  } catch (err) {
    // Fail closed (review S2): an action ExactGround could not evaluate is denied unless the user opts out.
    const failOpen = env.EXACTGROUND_FAIL_OPEN === '1';
    const text = `ExactGround could not check this action (${err?.message || err}). `
      + (failOpen ? 'Allowed because EXACTGROUND_FAIL_OPEN=1.' : 'Denied for safety; set EXACTGROUND_FAIL_OPEN=1 to allow actions when the checker itself fails.');
    process.stderr.write(`exactground: ${text}\n`);
    process.stdout.write(JSON.stringify(formatOutput(vendor, failOpen ? 'allow' : 'deny', text, ev)) + '\n');
  }
  return 0;
}
