# mcp-connection-diagnostics — A failed MCP names its exact layer

Cast is Alex, the Acme Robotics admin, in OpenWork Cloud. Alex is adding an
enterprise MCP endpoint that cannot be reached from Den. The goal is to see a
safe, actionable failure in the ordinary Connections workflow—not a generic
`fetch failed` exception or a secret-bearing provider response.

1. Alex opens Connections and starts the same custom MCP form used for Microsoft 365, ServiceNow, and other remote Streamable HTTP servers.

2. He enters an intentionally unreachable endpoint with no authentication. OpenWork validates it through the full MCP initialize path; this is a real server-side probe, not client-side URL validation.

3. The form remains open and identifies the TCP layer, explains that Den resolved the host but could not connect, and gives a correlation reference. No token, query value, provider body, or stack trace is shown.
