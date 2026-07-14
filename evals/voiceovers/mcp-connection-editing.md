# mcp-connection-editing — Admins safely edit existing MCP connections

1. An organization admin opens an existing MCP connection and clicks Edit. The form shows its name, server URL, authentication type, account mode, and assignments, but never reveals saved secrets.

2. The admin renames the connection or changes who can use it. After saving, the MCP remains connected and its existing credentials continue working.

3. The admin changes the server URL, authentication type, or account mode. OpenWork clearly warns that this changes the connection’s identity and will require reconnection. After confirmation, old credentials and sessions are cleared before the new server can be used.

4. For an MCP managed by a marketplace plugin, OpenWork allows assignment changes but prevents changing server/authentication fields owned by the marketplace definition and explains where those values come from.
