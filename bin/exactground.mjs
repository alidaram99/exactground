#!/usr/bin/env node
// ExactGround CLI. Zero runtime dependencies (Node >= 20).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parsePipRequirement, parseNpmSpec } from '../src/specs.mjs';
import { depsFromCommand } from '../src/analyze.mjs';
import { checkDeps, describe, loadConfig } from '../src/check.mjs';
import { Cache } from '../src/registry.mjs';
import { runHook, VENDORS } from '../src/hook.mjs';
import { depsFromManifest, manifestType, requirementsFileDeps } from '../src/manifest.mjs';
import { hookConfig, installHooks } from '../src/install.mjs';
import { callApi } from '../src/api.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;

const HELP = `ExactGround ${VERSION} — stop coding agents from installing packages that do not exist.

Usage:
  exactground check <pkg...>            Check package names. Prefix PyPI names with pypi: (npm is the default)
                                        e.g. exactground check react@18.2.0 pypi:requests pypi:reqeusts
  exactground scan "<command>"          Check every install in a shell command (npm/pnpm/yarn/bun/npx, pip/uv/poetry/pdm/pipx)
  exactground manifest [file]           Check every dependency in package.json, requirements*.txt or pyproject.toml
  exactground hook <agent>              Agent hook (reads JSON on stdin): ${VENDORS.join(' | ')}
  exactground init <agent> [--write]    Print (or merge into this project) the hook config for an agent
  exactground api <tool> <json>         Paid version-exact checks via the hosted API (needs APIFY_TOKEN):
                                        check_symbols | check_packages | check_diff
  exactground --version | --help

Options:
  --json        Machine-readable output
  --strict      Block when the registry cannot be reached
  --offline     Use only the local cache

Exit codes: 0 ok/warn, 1 blocked, 2 usage error.
Docs: https://github.com/alidaram99/exactground`;

function parseArgs(argv) {
  const flags = new Set(argv.filter((a) => a.startsWith('--')));
  const pos = argv.filter((a) => !a.startsWith('--'));
  return { flags, pos };
}

function toDep(arg) {
  if (/^(pypi|pip|py):/i.test(arg)) {
    const p = parsePipRequirement(arg.replace(/^[^:]+:/, ''));
    return p && { ecosystem: 'pypi', ...p };
  }
  const p = parseNpmSpec(arg.replace(/^npm:/i, ''));
  return p && { ecosystem: 'npm', ...p };
}

function offlineFetch() {
  return Promise.reject(Object.assign(new Error('offline mode'), { name: 'OfflineError' }));
}

async function report(deps, flags, extra = {}) {
  const config = { ...loadConfig(process.cwd()), ...(flags.has('--strict') ? { strict: true } : {}) };
  const cache = new Cache();
  const results = await checkDeps(deps, { config, cache, fetchImpl: flags.has('--offline') ? offlineFetch : fetch, ...extra });
  cache.save();
  if (flags.has('--json')) console.log(JSON.stringify({ results }, null, 2));
  else if (!results.length) console.log('No registry packages found.');
  else for (const r of results) console.log(describe(r));
  return results.some((r) => r.verdict === 'block') ? 1 : 0;
}

async function main(argv) {
  const [cmd, ...rest] = argv;
  const { flags, pos } = parseArgs(rest);
  switch (cmd) {
    case undefined:
    case '-h':
    case '--help':
    case 'help':
      console.log(HELP);
      return 0;
    case '-v':
    case '--version':
    case 'version':
      console.log(VERSION);
      return 0;
    case 'check': {
      const deps = pos.map(toDep);
      const bad = pos.filter((_, i) => !deps[i]);
      if (!pos.length || bad.length) {
        console.error(bad.length ? `Not a registry package name: ${bad.join(', ')}` : 'Usage: exactground check <pkg...>');
        return 2;
      }
      return report(deps, flags);
    }
    case 'scan': {
      const command = pos.join(' ');
      if (!command) { console.error('Usage: exactground scan "<command>"'); return 2; }
      const { deps, customIndex, notes } = depsFromCommand(command, process.cwd());
      for (const n of notes) console.error(`note: ${n}`);
      return report(deps, flags, { customIndex });
    }
    case 'manifest': {
      let file = pos[0];
      if (!file) file = ['package.json', 'pyproject.toml', 'requirements.txt'].find((f) => fs.existsSync(f));
      if (!file || !fs.existsSync(file)) { console.error('No manifest found. Usage: exactground manifest [file]'); return 2; }
      const type = manifestType(file);
      if (!type) { console.error(`Unsupported manifest: ${file}`); return 2; }
      const deps = type === 'requirements' ? requirementsFileDeps(file, process.cwd()) : depsFromManifest(type, fs.readFileSync(file, 'utf8'));
      return report(deps, flags);
    }
    case 'hook':
      return runHook(pos[0]);
    case 'init': {
      const vendor = pos[0];
      if (!VENDORS.includes(vendor)) { console.error(`Usage: exactground init <${VENDORS.join('|')}> [--write]`); return 2; }
      if (flags.has('--write')) {
        const { file, changed } = installHooks(vendor, process.cwd(), ROOT);
        console.log(changed ? `Merged the ExactGround hook into ${file}` : `${file} already has the ExactGround hook`);
      } else {
        const { file, config } = hookConfig(vendor, ROOT);
        console.log(`# Merge into ${file} (or run: exactground init ${vendor} --write)\n${JSON.stringify(config, null, 2)}`);
      }
      return 0;
    }
    case 'api': {
      const [tool, json] = pos;
      if (!tool) { console.error('Usage: exactground api <check_symbols|check_packages|check_diff> \'<json args>\''); return 2; }
      const out = await callApi(tool, json ? JSON.parse(json) : {});
      console.log(JSON.stringify(out, null, 2));
      return out?.isError ? 1 : 0;
    }
    default:
      console.error(`Unknown command: ${cmd}\n\n${HELP}`);
      return 2;
  }
}

main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (err) => {
  console.error(`exactground: ${err?.message || err}`);
  process.exitCode = 2;
});
