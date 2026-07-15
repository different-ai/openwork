# Eval run 2026-07-15T02-36-45-026Z

- Started: 2026-07-15T02:36:45.026Z
- CDP: http://127.0.0.1:39723
- Result: PASSED (1 passed, 0 failed, 0 skipped)
- fraimz: fraimz.html

## ✅ mcp-oauth-conformance — URL discovery, shared callback OAuth, and MCP tool use succeed end to end
Kind: user-facing flow demo
Spec: docs/external-mcp-oauth.md

- ✅ Prepare the isolated Den and OAuth MCP server (1851ms)
  - Assertion: Visible text includes "Add a connection" (passed)
- ✅ Requirements discovery is visible and side-effect free (662ms)
  - Assertion: Visible text includes "OAuth authentication is required." (passed)
  - Assertion: Visible text includes "Registration: dynamic registration." (passed)
  - Assertion: Visible text includes "Administrator action required" (passed)
  - Assertion: Visible text includes "mcp:read" (passed)
  - Frame: mcp-oauth-conformance-01-requirements-discovered.png (passed)
    - Voiceover: An administrator enters only the MCP URL and asks OpenWork to discover requirements. Before anything is saved, the dialog explains that OAuth is required, recommends dynamic registration, shows the available scopes, and calls out the administrator checks that standards metadata cannot prove.
- ✅ DCR and PKCE return through the shared callback (479ms)
  - Assertion: Visible text includes "OAuth conformance mrlgygve" (passed)
  - Assertion: Visible text does not include "Connection failed" (passed)
  - Frame: mcp-oauth-conformance-02-shared-callback-connected.png (passed)
    - Voiceover: After the administrator chooses the least-privilege read scope, OpenWork completes dynamic registration and PKCE authorization in a real browser window. The provider returns to the deployment-wide callback and Den shows the successful connection page.
- ✅ The normalized connection contract reports the shared callback (1841ms)
  - Frame: mcp-oauth-conformance-03-dashboard-shared-callback.png (passed)
    - Voiceover: Back on the Connections screen, the normalized connection card reports Connected, Shared callback, and dynamic registration. The callback shown is deployment-wide and contains no connection identifier.
- ✅ The authorized tool is usable from UI and the agent MCP surface (526ms)
  - Assertion: Visible text includes "Tools available to your agents" (passed)
  - Assertion: Visible text includes "mock_echo" (passed)
  - Frame: mcp-oauth-conformance-04-authorized-tool-catalog.png (passed)
    - Voiceover: The connected server exposes its real Mock Echo tool in the dashboard catalog. The same connection is immediately usable through search_capabilities and execute_capability, proving the OAuth result reaches the agent-facing MCP surface end to end.
- ✅ Clean up the proof connection and mock server (17ms)
- ✅ Voice-over script coverage (0ms)
  - Assertion: Script frame 1 narrated: "An administrator enters only the MCP URL and asks OpenWork to discover requirements. Bef" (passed)
  - Assertion: Script frame 2 narrated: "After the administrator chooses the least-privilege read scope, OpenWork completes dynam" (passed)
  - Assertion: Script frame 3 narrated: "Back on the Connections screen, the normalized connection card reports Connected, Shared" (passed)
  - Assertion: Script frame 4 narrated: "The connected server exposes its real Mock Echo tool in the dashboard catalog. The same " (passed)

Screenshots: mcp-oauth-conformance-01-requirements-discovered.png, mcp-oauth-conformance-02-shared-callback-connected.png, mcp-oauth-conformance-03-dashboard-shared-callback.png, mcp-oauth-conformance-04-authorized-tool-catalog.png
