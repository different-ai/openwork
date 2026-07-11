# mcp-diagnostic-mock-server — Prove an enterprise MCP connection without a customer tenant

Cast is Alex, the Acme Robotics admin, in OpenWork Cloud. A deterministic
ServiceNow-style MCP server is running beside the isolated EE Den. It uses
synthetic records and real OAuth, MCP lifecycle, session, and pagination
contracts, so support can reproduce a connection without touching a customer.

1. Alex opens Connections while the diagnostic server is running on the local reserved port. The server is a distinct ServiceNow profile with the exact quickstart-style MCP path; no production provider or customer data is involved.

2. He adds the diagnostic URL as one org account. This is the same Connections form used for a real remote MCP, not a hidden test configuration.

3. ServiceNow production fixtures default to the documented manually registered client. For this isolated UI proof only, the mock enables its explicit DCR override so Den can exercise protected-resource discovery, registration, PKCE, token exchange, and the real callback without customer credentials. The success page confirms the org credential was stored by Den.

4. Back on Connections, the row becomes Connected through the normal polling path and now offers Test connection. The test is deliberately read-only: it initializes MCP and lists tools but never invokes one.

5. The result shows exactly what passed: protocol 2025-06-18, a stateful session, all four documented Quickstart-style ServiceNow tools across two pages, and a catalog fingerprint. Tokens and session identifiers never appear in the UI.
