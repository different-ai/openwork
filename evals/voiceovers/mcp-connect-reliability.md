# MCP connect reliability

1. Alex creates a fresh Den workspace in a real Chrome profile so this MCP reliability run starts from an isolated organization.

2. Alex publishes the mock MCP server as a no-auth, org-wide connection and Den Web shows the connection as Connected.

3. Alex reloads the Den Web connectors page, sees the same Connected state, and the live tool call still echoes through the saved connection.

4. Alex disconnects the connector, the row remains visible as Not connected, and a live mock_echo call fails instead of silently using stale credentials.

5. Alex reconnects the same no-auth MCP setup, Den Web returns to Connected, and the live tool call succeeds again.

6. Alex adds a never-connected OAuth MCP row and confirms it asks for first-time Connect, not a misleading reconnect or sign-in prompt.

7. The live Den MCP connection catalog exposes mock_echo, and the admin diagnostic runner executes it through the saved connection.

8. The agent-facing search_capabilities and execute_capability loop finds that same connection and echoes the proof text through the mock server.

9. The eval removes the temporary MCP connections and records that the Electron desktop cell is intentionally skipped for this web-only reliability check.
