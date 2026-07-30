# enterprise-mcp-terminal-401-guard — A transient 401 no longer signs you out of your connections

This is an internal proof: the protagonist is the stored connection credential inside OpenWork Cloud's MCP client, driven through real provider scenarios at the terminal.

1. Here is the new rule in the client itself: a connection credential may only be destroyed during a real tool call the user asked for, and only when the provider proves the token itself is bad with an explicit invalid_token challenge. A plain 401 blip is no longer a death sentence.

2. First scenario: the user runs a tool and the provider hiccups with a bare 401, the kind a gateway redeploy or a VPN change produces. The call fails, but the stored credential survives untouched — no reconnect prompt will greet the user afterwards.

3. Second scenario: a background capability search probes the same connection and the provider even claims invalid_token. Background probes are never allowed to destroy credentials, so the stored tokens survive this too.

4. Third scenario: the user runs a tool and the provider genuinely rejects the token with an invalid_token challenge. Now the client does invalidate the credential, exactly once, and for the first time it emits a diagnostic that operators can see in the logs — and the full test suite confirms nothing else regressed.
