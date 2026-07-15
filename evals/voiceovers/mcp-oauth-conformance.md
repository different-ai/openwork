# MCP OAuth conformance

1. An administrator enters only the MCP URL and asks OpenWork to discover requirements. Before anything is saved, the dialog explains that OAuth is required, recommends dynamic registration, shows the available scopes, and calls out the administrator checks that standards metadata cannot prove.

2. After the administrator chooses the least-privilege read scope, OpenWork completes dynamic registration and PKCE authorization in a real browser window. The provider returns to the deployment-wide callback and Den shows the successful connection page.

3. Back on the Connections screen, the normalized connection card reports Connected, Shared callback, and dynamic registration. The callback shown is deployment-wide and contains no connection identifier.

4. The connected server exposes its real Mock Echo tool in the dashboard catalog. The same connection is immediately usable through search_capabilities and execute_capability, proving the OAuth result reaches the agent-facing MCP surface end to end.
