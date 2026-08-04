# hostile-gateway-mcp — hostile MCP gateway diagnostics

1. First, the real OpenWork connect path builds the authorization URL and shows the exact callback it will send. The product diagnostic for a redirect-whitelist callback error is still generic, so the frame captures that gap honestly.

2. Next, the real callback path reaches token exchange for a per-connector redirect mismatch. Today Den reports a token-exchange failure, but it drops the provider's more specific per-connector wording.

3. When the provider advertises dynamic client registration, OpenWork really does attempt it. If the authorization step still returns a DCR-required error, the current product surface is a generic authorization rejection.

4. A hostile endpoint that only fails GET with HTTP 405 is not touched by this connect flow. The frame proves the real client uses POST for MCP initialize and proceeds to OAuth without a GET.

5. For duplicate amplification, one user tool action creates exactly one OpenWork tools/call request. The provider's duplicate-request signal is currently collapsed to a generic provider tool error.

6. For refresh expiry, the runtime loads the expired credential and performs a refresh-token grant. The current product message points at token or refresh exchange, not the exact expired-refresh-token wording.

7. If discovery publishes a stray trailing-dot URL, the real client canonicalizes the authority before issuer discovery. The frame verifies that no trailing-dot fetch is sent and authorization still starts.

8. Finally, a per-user provider 403 is classified as provider authorization during callback validation. The current message points to permissions, but it still does not name the member subject.
