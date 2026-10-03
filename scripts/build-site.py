"""Generate docs/index.html (GitHub Pages landing page with JSON-LD SoftwareApplication + FAQPage) and docs/llms.txt."""
import html
import json
import pathlib
import re
import shutil

ROOT = pathlib.Path(__file__).resolve().parents[1]
DOCS = ROOT / 'docs'
DOCS.mkdir(exist_ok=True)

FAQ = [
    ("How do I stop Claude Code from installing hallucinated npm or PyPI packages?",
     "Install the free ExactGround Claude Code plugin: run `claude plugin marketplace add alidaram99/exactground` and `claude plugin install exactground@exactground-marketplace`. Its PreToolUse hook checks every install command and every package.json, requirements.txt or pyproject.toml edit against the npm registry and PyPI, and denies the tool call when a package name does not exist."),
    ("What is slopsquatting?",
     "Slopsquatting is registering a package name that AI models hallucinate, so that agents or developers who trust the suggestion install the attacker's code. A USENIX Security 2025 study found that 19.7% of 2.23 million AI-generated code samples referenced at least one package that does not exist, and 43% of invented names recurred on every rerun."),
    ("Does ExactGround work with Codex, Gemini CLI and Cursor?",
     "Yes. Codex uses a PreToolUse hook on Bash and apply_patch, Gemini CLI a BeforeTool hook, and Cursor a beforeShellExecution hook. Run `exactground init <agent> --write` in your project."),
    ("How do I check that a function exists in the exact version of a package?",
     "Use the hosted ExactGround API, an MCP server at https://dropin-apis--exactground-api.apify.actor/mcp. Its check_symbols tool reads npm type declarations with the TypeScript compiler and Python wheels statically, and answers exists true, false or null for a symbol in a specific version. It costs $0.002 per symbol."),
    ("How do I install ExactGround as a Gemini CLI extension?",
     "Run `gemini extensions install https://github.com/alidaram99/exactground --ref v0.1.3`. The extension adds a BeforeTool hook for run_shell_command, write_file and replace."),
    ("Is ExactGround free?",
     "The local guard (CLI and agent hooks) is free and MIT-licensed. Only the hosted version-exact API is paid per check through Apify."),
    ("Is an agent hook a security boundary?",
     "No. Hooks are guardrails: vendors document that they can time out or be bypassed, and installs inside inline scripts cannot be parsed (ExactGround denies those). ExactGround's hooks deny when the registry or the checker fails. Keep lockfiles, CI checks and an install-time scanner as well."),
]

LD = [
    {"@context": "https://schema.org", "@type": "SoftwareApplication", "name": "ExactGround",
     "applicationCategory": "DeveloperApplication", "operatingSystem": "Windows, macOS, Linux",
     "description": "Free open-source guard that stops AI coding agents from installing npm or PyPI packages that do not exist, plus a hosted MCP API for version-exact API checks.",
     "url": "https://alidaram99.github.io/exactground/", "downloadUrl": "https://github.com/alidaram99/exactground",
     "softwareVersion": "0.1.3", "license": "https://opensource.org/licenses/MIT",
     "offers": {"@type": "Offer", "price": "0", "priceCurrency": "USD"}},
    {"@context": "https://schema.org", "@type": "FAQPage",
     "mainEntity": [{"@type": "Question", "name": q, "acceptedAnswer": {"@type": "Answer", "text": a.replace('`', '')}} for q, a in FAQ]},
]


def md(s):
    parts = re.split(r'`([^`]+)`', s)
    return ''.join(f'<code>{html.escape(p)}</code>' if i % 2 else html.escape(p, quote=False) for i, p in enumerate(parts))


faq_html = '\n'.join(f'<h3>{html.escape(q)}</h3>\n<p>{md(a)}</p>' for q, a in FAQ)

PAGE = f"""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>ExactGround — stop AI coding agents installing packages that don't exist</title>
<meta name="description" content="Free guard for Claude Code, Codex, Gemini CLI and Cursor: blocks hallucinated npm/PyPI packages (slopsquatting), unpublished versions and typosquats before install. MCP API for version-exact checks.">
<link rel="canonical" href="https://alidaram99.github.io/exactground/">
<link rel="icon" href="icon.png">
<meta property="og:title" content="ExactGround — no hallucinated packages in your agent's installs">
<meta property="og:description" content="Blocks npm/PyPI installs of names that do not exist before Claude Code, Codex, Gemini CLI or Cursor runs them. Free, MIT.">
<meta property="og:image" content="https://alidaram99.github.io/exactground/icon.png">
<meta property="og:url" content="https://alidaram99.github.io/exactground/">
<meta name="twitter:card" content="summary">
<link rel="alternate" type="text/plain" href="llms.txt" title="llms.txt">
<script type="application/ld+json">{json.dumps(LD)}</script>
<style>
body{{font:16px/1.6 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;max-width:860px;margin:0 auto;padding:24px;color:#14201c;background:#fbfdfc}}
h1{{font-size:2rem;line-height:1.2;margin:.4em 0}} h2{{margin-top:2em;border-bottom:1px solid #d6e5df;padding-bottom:.2em}}
pre{{background:#0d2620;color:#e6f6ef;padding:14px;border-radius:8px;overflow:auto;font-size:14px}} code{{background:#e7f2ee;padding:1px 4px;border-radius:4px}} pre code{{background:none;padding:0}}
table{{border-collapse:collapse;width:100%;font-size:15px}} td,th{{border:1px solid #d6e5df;padding:6px 8px;text-align:left;vertical-align:top}}
.hero{{display:flex;gap:18px;align-items:center}} .hero img{{width:84px;height:84px;border-radius:18px}} a{{color:#0b6b52}}
.cta a{{display:inline-block;margin:6px 8px 6px 0;padding:8px 14px;border-radius:8px;background:#0b6b52;color:#fff;text-decoration:none}}
</style>
</head>
<body>
<div class="hero"><img src="icon.png" alt="ExactGround logo"><div><h1>Stop AI coding agents from installing packages that don't exist</h1></div></div>
<p><strong>To stop an AI coding agent from installing packages that don't exist, put a check in front of its install commands.</strong> ExactGround is a free, open-source hook for Claude Code, Codex, Gemini CLI and Cursor that does exactly that. It checks the <code>npm</code>/<code>pnpm</code>/<code>yarn</code>/<code>bun</code>/<code>npx</code> and <code>pip</code>/<code>uv</code>/<code>poetry</code> install commands it can parse, and new dependencies written into a manifest, against the public npm registry and PyPI <em>before the command runs</em>. It blocks hallucinated package names (the root of slopsquatting), versions that were never published, young look-alikes of popular packages and npm security placeholders.</p>
<p><strong>Threat model:</strong> ExactGround stops an agent that hallucinates or mistypes a package name in a normal install command. It is a cooperative guardrail, not a sandbox: an agent deliberately evading it can get around it, so use OS or container sandboxing to contain an agent you do not trust.</p>
<p><strong>Limits, up front:</strong> installs hidden in <code>node -e</code>/<code>python -c</code>, <code>$(...)</code> or <code>eval</code> cannot be checked, so they are denied; only shell, file-edit and patch tools are inspected; if the registry or the checker fails, the hook denies. Hooks are guardrails, not a sandbox.</p>
<p class="cta"><a href="https://github.com/alidaram99/exactground">GitHub (MIT)</a><a href="https://apify.com/dropin-apis/exactground-api">Hosted MCP API</a></p>
<pre><code>$ npx -y github:alidaram99/exactground#v0.1.3 check pypi:requests pypi:reqeusts react@99.0.0
OK      pypi:requests
BLOCK   pypi:reqeusts — "reqeusts" does not exist on PyPI; did you mean "requests"? (it is 1 edit away)
BLOCK   react@99.0.0 — version 99.0.0 of "react" was never published (latest is 19.3.0)</code></pre>
<h2>Why</h2>
<p>A USENIX Security 2025 study generated 2.23 million code samples with 16 models: <strong>19.7% referenced at least one package that does not exist</strong>, and 43% of invented names reappeared on every rerun of the same prompt (<a href="https://www.usenix.org/conference/usenixsecurity25/presentation/spracklen">paper</a>). Attackers register those names (<a href="https://en.wikipedia.org/wiki/Slopsquatting">slopsquatting</a>). Coding agents run installs without a human reading the name, and a rule in <code>CLAUDE.md</code> is text the model may ignore. A hook runs every time.</p>
<h2>Install in your agent</h2>
<table>
<tr><th>Agent</th><th>How</th><th>Hook</th></tr>
<tr><td>Claude Code</td><td><code>claude plugin marketplace add alidaram99/exactground</code><br><code>claude plugin install exactground@exactground-marketplace</code></td><td>PreToolUse on Bash, Write, Edit, MultiEdit</td></tr>
<tr><td>Codex</td><td><code>codex plugin marketplace add alidaram99/exactground --ref v0.1.3</code> then trust it in <code>/hooks</code></td><td>PreToolUse on Bash and apply_patch</td></tr>
<tr><td>Gemini CLI</td><td><code>gemini extensions install https://github.com/alidaram99/exactground --ref v0.1.3</code></td><td>BeforeTool</td></tr>
<tr><td>Cursor</td><td><code>exactground init cursor --write</code></td><td>beforeShellExecution</td></tr>
</table>
<h2>Version-exact API checks (MCP)</h2>
<p><strong>Status:</strong> awaiting publication on the Apify Store. Until <a href="https://apify.com/dropin-apis/exactground-api">its Store page</a> loads, the MCP URL below answers only its owner. The free local guard works now.</p>
<p>Real packages are also used wrongly: <code>useActionState</code> in a React 18 project, <code>numpy.asfarray</code> after NumPy 2.0 removed it. The hosted ExactGround API reads the published package (npm <code>.d.ts</code> via the TypeScript compiler, Python wheels parsed statically, never executed) and answers per symbol. <code>check_symbols</code> $0.002/symbol · <code>check_packages</code> $0.0005/package · <code>check_diff</code> $0.01/diff.</p>
<pre><code>claude mcp add --transport http exactground https://dropin-apis--exactground-api.apify.actor/mcp \\
  --header "Authorization: Bearer $APIFY_TOKEN"</code></pre>
<h2>FAQ</h2>
{faq_html}
<footer style="margin-top:3em;border-top:1px solid #d6e5df;padding-top:1em;font-size:14px;color:#5b6e67">
<p><strong>More tools from the same team:</strong> <a href="https://alidaram99.github.io/donelatch/">DoneLatch</a> (no agent “done” without evidence) · <a href="https://alidaram99.github.io/canaryindex/">CanaryIndex</a> (live scorecards for agent tools) · <a href="https://alidaram99.github.io/waraqmd/">Waraq</a> (offline Markdown reader/editor) · <a href="https://alidaram99.github.io/">all tools</a></p>
<p>MIT · Not affiliated with npm, PyPI, Anthropic, OpenAI, Google or Cursor · <a href="https://github.com/alidaram99/exactground">GitHub</a> · <a href="llms.txt">llms.txt</a></p>
</footer>
</body>
</html>
"""

(DOCS / 'index.html').write_text(PAGE, encoding='utf8')
shutil.copyfile(ROOT / 'llms.txt', DOCS / 'llms.txt')
(DOCS / '.nojekyll').write_text('', encoding='utf8')
(DOCS / 'robots.txt').write_text('User-agent: *\nAllow: /\nSitemap: https://alidaram99.github.io/exactground/sitemap.xml\n', encoding='utf8')
(DOCS / 'sitemap.xml').write_text('<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n'
                                  '  <url><loc>https://alidaram99.github.io/exactground/</loc><lastmod>2026-10-03</lastmod></url>\n'
                                  '  <url><loc>https://alidaram99.github.io/exactground/llms.txt</loc><lastmod>2026-10-03</lastmod></url>\n</urlset>\n', encoding='utf8')
print('site written', len(PAGE))
