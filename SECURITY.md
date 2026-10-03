# Security policy

## What ExactGround protects against

ExactGround is a **cooperative guardrail** that runs as a hook in an AI coding agent: Claude Code, Codex, Gemini CLI or Cursor. It stops an agent that **hallucinates or mistypes** a package name, or asks for a version that was never published, in an install command it can parse. It also:

- denies installs it cannot inspect, such as inline scripts, `$(...)`, `eval`/`iex`, encoded PowerShell, program names built at run time, loops whose program is a variable, and package names held in variables (a loop or call with a literal `npm`/`npx`/`pip` is parsed and checked like any other command);
- denies writes to its own policy, approval and cache files, including NTFS streams such as `.exactground.json::$DATA` and paths built with `Join-Path`, string concatenation or environment variables;
- ignores a project or user config until a human approves its exact content with `exactground trust`;
- denies when the registry or the checker fails.

## What is out of scope

**A same-user agent that deliberately obfuscates its commands can defeat any hook-based guard, including ExactGround.** This residual class is out of scope.

A hook sees one tool call at a time, as text, and runs with the same rights as the agent. An agent that is trying to evade it has many ways around a text check. For example, it can:

- write a script file in one step and run it in another;
- build program names or file paths from pieces at run time;
- use an interpreter or a tool the hook does not know;
- edit files through a channel the hook is not attached to.

ExactGround denies the obfuscation patterns that reviews have found (see the `re-review` tests). We will not keep extending that list to chase deliberate evasion. Every new rule adds false positives, and none of them can close the class.

**For an agent you treat as adversarial:**

- run it in an OS sandbox or a container whose network and file access you control; or
- run it as a separate OS user that cannot write your ExactGround config (`%APPDATA%\exactground`, `~/.config/exactground`) or your project's `.exactground.json`.

Also not covered: anything that runs outside the agent (CI, cron, git hooks, other programs), private registries (allow-list them), and malware in packages that do exist. For the last one, use a malware scanner such as Socket or your registry's advisories.

## Reporting a vulnerability

If ExactGround **allows** an install of a missing package from a command an agent would plausibly write in normal use, that is a bug. The same goes for an approved config being trusted after it was changed, and for the hook failing open. Please report it privately through GitHub's **Security → Report a vulnerability** on this repository. If that is not available, open an issue that describes the impact without a working exploit.

Reports that need a deliberately obfuscated command fall under the out-of-scope class above. They are still welcome, but they may be closed as such.

## Supported versions

Only the latest release receives fixes. Pin a release tag (for example `#v0.1.5` or `--ref v0.1.5`) and update when a new one is published.
