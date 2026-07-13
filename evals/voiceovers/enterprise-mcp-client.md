# Enterprise MCP client

1. Start Den without `DEN_ENABLE_ENTERPRISE_MCP_CLIENT` and confirm startup
   identifies the current Den MCP client.
2. Connect to the same MCP test server through the existing Den connection API
   and confirm the current behavior is unchanged.
3. Restart Den with `DEN_ENABLE_ENTERPRISE_MCP_CLIENT=true` and confirm startup
   identifies `@openwork/enterprise-mcp-client`.
4. Connect without credentials, with an API key, and through OAuth; confirm the
   same Den API response shapes and credential ownership rules.
5. Start two OAuth authorizations for one connection and confirm their signed
   PKCE transactions remain isolated; complete one and deny the other.
6. Confirm callback token commit, authorization consumption, client revision,
   member/shared identity, connection existence, and deadline are one atomic
   persistence decision.
7. Discover tools and execute a successful tool through Den.
8. Trigger failures at endpoint access, OAuth discovery, expired authorization,
   expired client secret, expired token without refresh, token exchange, MCP
   initialization, tool discovery, and tool execution; confirm each result
   identifies the failing phase without exposing credentials.
9. Drain in-flight browser authorizations, restart without the flag, and confirm
   rollback requires no schema or credential migration.
