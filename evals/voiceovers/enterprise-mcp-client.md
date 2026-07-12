# Enterprise MCP client

1. Start Den without `DEN_ENABLE_ENTERPRISE_MCP_CLIENT` and confirm startup
   identifies the current Den MCP client.
2. Connect to the same MCP test server through the existing Den connection API
   and confirm the current behavior is unchanged.
3. Restart Den with `DEN_ENABLE_ENTERPRISE_MCP_CLIENT=true` and confirm startup
   identifies `@openwork/enterprise-mcp-client`.
4. Connect without credentials, with an API key, and through OAuth; confirm the
   same Den API response shapes and credential ownership rules.
5. Discover tools and execute a successful tool through Den.
6. Trigger failures at endpoint access, OAuth discovery, token exchange, MCP
   initialization, tool discovery, and tool execution; confirm each result
   identifies the failing phase without exposing credentials.
7. Restart without the flag and confirm rollback requires no data migration.
