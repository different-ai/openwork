# MCP diagnostics integration rehearsal — one understandable enterprise journey

Cast is Jalil reviewing the MCP diagnostics release from the ordinary Den
Connections screen. Every provider record is synthetic, and the goal is to
understand what each level adds before anything is accepted into the parent
release branch.

1. Jalil first sees a deliberately unreachable MCP connection fail with a
   named network phase, the correct owner, and a safe reference. The product
   never falls back to `fetch failed`, a stack trace, or a provider secret.

2. He starts the deterministic ServiceNow-style server and connects through
   the realistic confidential-client OAuth path. The callback returns to Den
   API, and its credentials and Connected state are stored only after token
   acquisition and MCP initialization succeed.

3. He selects Test connection. OpenWork performs a read-only initialize,
   initialized notification, complete paginated tool listing, and session
   shutdown. The result shows protocol and catalog readiness without invoking
   a provider tool.

4. He selects Diagnose and watches the Den-side phases update live. After
   authorization, an injected MCP version fault preserves Authorized as the
   highest proven health and identifies MCP Version as the first failure.

5. He repairs the mock and retries. The same panel reaches Catalog Ready and
   explicitly states that no provider operation or mutation has been proven.

6. Finally, he injects a provider authorization denial. Catalog readiness
   remains true, while a separate safe read operation reports the provider
   denial with its correct owner. This proves the three levels work together
   without conflating connection, catalog, and operation health.
