# mcp-live-diagnostic-tracing — See the first failing enterprise MCP layer from the Den server

1. I open an enterprise MCP connection and choose Diagnose. OpenWork makes clear that this test runs from the Den server, not my laptop.

2. The timeline updates as configuration, Den networking, endpoint routing, OAuth discovery, and client registration complete, with an elapsed time beside every check.

3. After I authorize, the test reaches the MCP resource but the mock server rejects the negotiated version. OpenWork preserves Authorized as the highest passing level and identifies MCP Version as the first failure.

4. The panel tells me who must act and shows a support-ready evidence summary. Tokens, authorization codes, session IDs, provider content, and raw responses are absent.

5. After the server configuration is corrected, I retry from the same panel. Initialization and the complete tool catalog pass, and OpenWork reports Catalog Ready without pretending that a provider operation or mutation was tested.
