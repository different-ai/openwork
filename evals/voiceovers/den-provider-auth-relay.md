# den-provider-auth-relay — Den relays downstream provider sign-in links safely

This internal proof follows a live Den server and two gateway-style MCP servers in the same isolated Daytona sandbox. The reviewer sees the health evidence, the raw gateway authorization payload, the agent-facing response, and the host-binding safety check.

1. The opening frame shows a live Den API in an isolated Daytona sandbox. The health check answers from the public URL, and the service's build version is displayed so the reviewer can tell which server is responding.

2. Next, the admin creates a workspace and publishes a Salesforce gateway connection. Beside it, the gateway's own raw response shows HTTP 200 with JSON-RPC -32001, authorization required, and a provider connect link on the same gateway host.

3. Now the agent uses the Cloud Control surface just like a real worker would. Search finds the Salesforce tool, execute returns needs_connection, the downstream-provider status carries the exact sign-in link, and the old latency or timeout wording is nowhere in the answer.

4. The final frame checks the safety rail. A second gateway asks for connection too, but because its link points at a different host, Den still reports needs_connection while removing the untrusted URL from both the diagnostic and the action.
