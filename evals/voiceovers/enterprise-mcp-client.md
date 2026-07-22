# Enterprise MCP client

1. Start Den and confirm startup identifies `@openwork/enterprise-mcp-client`.
2. Reconnect an existing OAuth connection and confirm it uses the callback URL
   stored on that connection.
3. Create a new OAuth connection and confirm it uses the deployment-wide
   shared callback.
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
9. Confirm both the shared callback and the per-connection compatibility route
   reject state created for the other callback mode.
