# ExactGround

ExactGround checks package installs before they run. Its BeforeTool hook inspects `run_shell_command`, `write_file` and `replace` calls. It denies any that would install an npm or PyPI package that does not exist, a version that was never published, an npm security placeholder, or a young look-alike of a popular package.

When an install is denied:
- Read the reason. It names the package and often suggests the real one ("did you mean requests?").
- Do not retry with a different spelling you are guessing. Check the package's official documentation or registry page first.
- If the package is private or intentionally new, the user can add it to `.exactground.json` (`"allow": ["name"]` or `"privateScopes": ["@org"]`).

Version-exact API checks ("does `useActionState` exist in react 18.2.0?") are available from the hosted MCP server described in the README.
