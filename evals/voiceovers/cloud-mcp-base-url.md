# cloud-mcp-base-url — Cloud MCP tokens follow the desktop base URL

1. I sign in to OpenWork Cloud, and the desktop automatically prepares its cloud-agent connection.

2. The minted token advertises the desktop's configured base URL through `/api/den/mcp`, never the separate direct API origin.

3. After refreshing the connection, `openwork-cloud` uses `<baseUrl>/api/den/mcp/agent`, replacing any prior `api.` endpoint.

4. The cloud tools connect successfully through that URL, including custom and self-hosted base URLs.
