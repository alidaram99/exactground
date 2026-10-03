# ExactGround: stop AI coding agents from installing packages that do not exist

**ExactGround blocks an AI coding agent from installing an npm or PyPI package that does not exist, and its hosted check tells you whether a function exists in the exact version you have installed.**

The free, open-source guard runs as a hook in Claude Code, Codex, Gemini CLI and Cursor. It checks the following against the public npm registry and PyPI **before the command runs**:
- the `npm`/`pnpm`/`yarn`/`bun`/`npx` and `pip`/`uv`/`poetry`/`pdm`/`pipx` install commands it can parse;
- new dependencies written into `package.json`, `requirements*.txt` or `pyproject.toml`.

It blocks hallucinated package names (the root of *slopsquatting*), versions that were never published, young or little-used look-alikes of popular packages, and npm security placeholders. Zero dependencies, local, MIT.

**Threat model, plainly:** ExactGround stops an agent that hallucinates or mistypes a package name in a normal install command. It is a cooperative guardrail, not a sandbox: an agent that deliberately tries to evade it (by writing its own scripts, editing files the hooks do not see, or running code another way) can get around it. To contain an agent you do not trust, use OS or container sandboxing.

**Out of scope, on purpose:** an agent running as your user that deliberately obfuscates its commands (building program names or file paths at run time, writing its own scripts, encoding commands) can defeat any hook-based guard, including this one. ExactGround denies the obfuscation patterns it knows, but it does not chase this class further. For an agent you treat as adversarial, run it in an OS sandbox or container, or as a separate OS user that cannot write your ExactGround config. See [SECURITY.md](SECURITY.md).

**What it does not see:**
- Installs hidden inside inline scripts (`node -e`, `python -c`), command substitution (`$(...)`), `eval`/`iex`/`Start-Process` or `-EncodedCommand` cannot be checked, so the hook **denies** them and asks for a plain install command. Package managers reached through variables (`n=npm; $n install x`), 8.3 short names (`NPM~1.EXE`), `.cmd/.ps1` suffixes and full paths are resolved and checked. Program names built at run time (`& ('np'+'m')`, `for %I in (npm) do ...`) are denied; cmd carets (`np^m`) are removed and checked.
- Every tool call is inspected: any tool that carries a `command` is treated as a shell, and every non-read-only tool has its file paths checked against ExactGround's own policy files. Anything run outside the agent (CI, cron, other programs) is not seen.
- Hooks are guardrails, not a sandbox: an agent with other ways to run code can get around them (see the threat model above).
- If the registry cannot be reached, or the checker itself fails, the hook **denies** by default.

[![CI](https://github.com/alidaram99/exactground/actions/workflows/ci.yml/badge.svg)](https://github.com/alidaram99/exactground/actions/workflows/ci.yml) · Website: https://alidaram99.github.io/exactground/ · Hosted API: https://apify.com/dropin-apis/exactground-api

```console
$ npx -y github:alidaram99/exactground#v0.1.4 check pypi:requests pypi:reqeusts pypi:huggingface-cli react@99.0.0
OK      pypi:requests
BLOCK   pypi:reqeusts — "reqeusts" does not exist on PyPI; did you mean "requests"? (it is 1 edit away)
BLOCK   pypi:huggingface-cli — "huggingface-cli" does not exist on PyPI
BLOCK   react@99.0.0 — version 99.0.0 of "react" was never published (latest is 19.3.0)
```

## Why this matters

- **Package hallucination is common and repeatable.** The USENIX Security 2025 study *We Have a Package for You!* (Spracklen et al.) had 16 models write **576,000 code samples**. Of the **2.23 million package recommendations** in them, **440,445 (19.7%) named packages that do not exist**, 205,474 unique names. In a separate test, the authors re-ran 500 prompts that had produced a hallucination 10 times each, and 43% of those hallucinated names came back in all 10 runs ([paper](https://www.usenix.org/conference/usenixsecurity25/presentation/spracklen)).
- **Slopsquatting** turns that into an attack: someone registers the invented name with malware, and the next agent that runs `pip install <invented-name>` installs it ([Wikipedia](https://en.wikipedia.org/wiki/Slopsquatting); [CSA research note, 2026](https://labs.cloudsecurityalliance.org/research/csa-research-note-slopsquatting-ai-supply-chain-20260419-csa/)). `huggingface-cli` (above) is the classic example: a name models invent for the real `huggingface_hub[cli]`.
- **Agents install without a human looking.** A rule like "don't invent packages" in `CLAUDE.md` or `AGENTS.md` is text the model may ignore, especially after context compaction. A hook is code that runs every time.

## Quick start

Node.js 20 or newer. No install needed:

```sh
npx -y github:alidaram99/exactground#v0.1.4 check left-pad expresss pypi:numpy==1.26.4
npx -y github:alidaram99/exactground#v0.1.4 scan "npm i zod react-hook-formz && pip install -r requirements.txt"
npx -y github:alidaram99/exactground#v0.1.4 manifest package.json
```

For hooks, use a local checkout of a tagged release (faster, pinned, and nothing is downloaded at hook time):

```sh
git clone --depth 1 --branch v0.1.4 https://github.com/alidaram99/exactground.git ~/tools/exactground
```

## Add it to your coding agent

`exactground init <agent>` prints the exact config with absolute paths for your checkout. `--write` merges it into the current project and keeps your existing hooks.

### Claude Code (plugin)

```sh
claude plugin marketplace add alidaram99/exactground
claude plugin install exactground@exactground-marketplace
```

The plugin registers a `PreToolUse` hook on `Bash|Write|Edit|MultiEdit`.
- A blocked install is denied with the reason shown to Claude, for example: *"reqeusts" does not exist on PyPI; did you mean "requests"?*
- Warnings are allowed and passed to Claude as context.

Manual alternative: `node ~/tools/exactground/bin/exactground.mjs init claude --write`.

### Codex

```sh
codex plugin marketplace add alidaram99/exactground --ref v0.1.4
```

Install the plugin, then review and trust the hook in `/hooks`; Codex only runs trusted hooks. Manual alternative: `exactground init codex --write` writes `.codex/hooks.json`, with `PreToolUse` on `Bash` and `apply_patch`, so patches that add dependencies to `package.json`, `requirements.txt` or `pyproject.toml` are checked too.

### Gemini CLI (extension)

```sh
gemini extensions install https://github.com/alidaram99/exactground --ref v0.1.4
```

The extension's `BeforeTool` hook covers `run_shell_command|write_file|replace`. Manual alternative: `exactground init gemini --write` adds the same hook to `.gemini/settings.json`.

### Cursor

`exactground init cursor --write` adds a `beforeShellExecution` hook to `.cursor/hooks.json`. Cursor cannot block file edits before they happen, so ExactGround catches the follow-up `npm install`/`pip install`/`uv sync` instead: a bare install checks every manifest dependency that is not yet in the lockfile.

## What it checks

| Situation | Verdict |
|---|---|
| Name not on npm/PyPI (`npm i reacct-dom`, `pip install reqeusts`) | **block**, with "did you mean" |
| Pinned version never published (`react@99.0.0`, `numpy==9.9`) | **block** |
| npm security placeholder (`0.0.1-security`: malware was removed) | **block** |
| Look-alike of a top-3,000 package that is < 180 days old or < 500 weekly downloads | **block** |
| Look-alike that is old and widely used | warn |
| Published < 30 days ago, < 500 weekly downloads, deprecated, or yanked | warn |
| Registry unreachable | **denied** in the agent hooks (strict is the hook default); the manual CLI warns unless `--strict` |
| `--index-url`/`--extra-index-url` in use (private packages possible) | missing names only warn |

**Where it looks:**
- direct installs;
- `npx`/`pnpm dlx`/`bunx`/`uvx` runs;
- `pip install -r` files, including nested `-r`;
- bare `npm install`/`yarn`/`pnpm install`/`uv sync`/`poetry install` (dependencies missing from the lockfile);
- `Write`/`Edit` of `package.json`, `requirements*.txt` and `pyproject.toml`;
- Codex `apply_patch`.

Commands wrapped in `bash -lc "…"` are unwrapped.

**Configuration:** optional `.exactground.json` at the project root:

```json
{ "allow": ["my-internal-lib", "pypi:corp-utils"], "privateScopes": ["@acme"], "newPackageDays": 30, "lowDownloads": 500 }
```

The agent cannot approve its own exceptions:
- The hooks honour a project `.exactground.json` only after **you** run `exactground trust` in a terminal. That records the file's SHA-256 in your user config directory, outside the project.
- Any later edit needs approval again. Your user-level `config.json` is treated the same way: approve it with `exactground trust --user`.
- A tool call that writes `.exactground.json`, the approvals or the cache is denied.
- Settings for all projects can go in `~/.config/exactground/config.json` (`%APPDATA%\exactground\config.json` on Windows).

The manual CLI caches lookups for 24 hours in `~/.cache/exactground`. The agent hooks always re-check the registry and never allow an install from the cache alone.

## Version-exact API checks (hosted, pay per check)

**Hosted API status:** live on the [Apify Store](https://apify.com/dropin-apis/exactground-api) since 2026-10-03. Calls need your Apify API token (requests without one get HTTP 401).

Most hallucinations are real packages used wrongly: `useActionState` in a React 18 project, or `numpy.asfarray` after NumPy 2.0 removed it. The [ExactGround API](https://apify.com/dropin-apis/exactground-api) answers those questions from the published package itself: npm `.d.ts` via the TypeScript compiler, and Python wheels parsed statically, without running any code. It is an MCP server:

```sh
claude mcp add --transport http exactground https://dropin-apis--exactground-api.apify.actor/mcp --header "Authorization: Bearer $APIFY_TOKEN"
```

| Tool | Price |
|---|---|
| `check_symbols` | $0.002 per symbol |
| `check_packages` | $0.0005 per package |
| `check_diff` | $0.01 per diff (every import added by a change) |

From the CLI: `APIFY_TOKEN=… exactground api check_symbols '{"ecosystem":"pypi","package":"numpy","version":"2.1.0","symbols":["numpy.asfarray"]}'`.

## How it compares

| Tool | What it does | Blocks a hallucinated install inside the agent? | Version-exact API check? |
|---|---|---|---|
| **ExactGround** | Registry reality + typosquat signals in agent hooks (free); API checks (hosted) | **Yes**, for the install commands and manifest edits it can parse (Claude Code, Codex, Gemini CLI, Cursor hooks) | **Yes** (hosted API) |
| [Socket Firewall](https://docs.socket.dev/docs/socket-firewall-overview) | Proxy that blocks confirmed malware at install time | Malware yes; a non-existent name simply fails to install (or installs a fresh squat until it is confirmed) | No |
| [Context7](https://context7.com/) | Puts version-specific docs into the prompt | No; the agent can still invent names | No; documentation text, not a yes/no check |
| `npm audit` / `pip-audit` | Known vulnerabilities in installed packages | No; runs after install, on packages that exist | No |
| Type checkers (`tsc`, `pyright`) | Exact API checks for typed code after install | No | Yes, but only after code and environment exist |

These work together. ExactGround is the cheap gate in front of the install, and Socket and audits cover the security of real packages.

## FAQ

### How do I stop Claude Code from installing hallucinated npm or PyPI packages?

Install the ExactGround Claude Code plugin (two commands above). Its `PreToolUse` hook checks the package names in the Bash install commands it can parse and in `package.json`/`requirements.txt`/`pyproject.toml` edits, and denies the tool call if a name does not exist. Installs it cannot parse are denied too.

### What is slopsquatting?

Registering a package name that AI models hallucinate, so that agents and developers who trust the suggestion install the attacker's code. The term was coined by Seth Larson; the USENIX 2025 study measured how often models invent names.

### Does ExactGround send my code anywhere?

The local guard sends only package names to the public registries (`registry.npmjs.org`, `api.npmjs.org`, `pypi.org`), the same requests your package manager makes. The hosted API receives only what you send to it.

### Will it block my private packages?

Not if you list them in `.exactground.json` (`allow` or `privateScopes`) and approve the file with `exactground trust`. A missing name only warns when pip/uv use a custom `--index-url`.

### Does it slow the agent down?

A check is one cached HTTP request per new package name, usually 100–400 ms, and nothing for commands that do not install anything.

### Is a hook a security boundary?

No. Agent hooks are guardrails. Claude Code and Codex document that hooks can time out or be bypassed, Codex hosted tools are not hooked, and Cursor cannot block file edits before they happen. ExactGround's hooks deny on internal errors and registry outages by default. Set `EXACTGROUND_FAIL_OPEN=1` to allow on internal errors. Keep lockfiles, CI checks and an install-time scanner too.

### Which ecosystems are supported?

npm (npm, pnpm, yarn, bun, npx) and PyPI (pip, uv, poetry, pdm, pipx, uvx).

## Development

```sh
npm test        # 27 offline tests: parser, policy, cache, all four hook formats, manifests, patches
```

Popular-package lists come from [npm-high-impact](https://github.com/wooorm/npm-high-impact) (MIT) and [top-pypi-packages](https://hugovk.github.io/top-pypi-packages/) (see `data/`).

## More tools from the same team

- [DoneLatch](https://alidaram99.github.io/donelatch/): no agent "done" without fresh, fault-sensitive evidence.
- [CanaryIndex](https://alidaram99.github.io/canaryindex/): public, regularly re-run scorecards for agent tools.
- [Waraq](https://alidaram99.github.io/waraqmd/): a free offline Markdown reader and editor for agent files, on laptop and phone.
- All tools: https://alidaram99.github.io/

## License

MIT. Not affiliated with npm, PyPI, Anthropic, OpenAI, Google or Cursor.
