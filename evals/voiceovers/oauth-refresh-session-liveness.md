# oauth-refresh-session-liveness — Signed-out sessions stop pretending to refresh, and infra blips stop pretending to be sign-outs

This is an internal proof: the protagonist is the OAuth grant behind an MCP connection, driven through OpenWork's real token endpoint and resource handler at the wire level.

1. Here is the new contract in the code itself: the token endpoint now checks that the session behind a refresh grant is still alive before minting tokens, and the resource endpoint now tells the truth when it merely could not check — a missing session means invalid grant, a failed check means try again shortly, and only a real rejection carries an authentication challenge.

2. Now the whole contract runs against the real server: a signed-out session's refresh is refused with invalid grant and its leftover tokens are swept away, a live session keeps refreshing exactly as before, machine-to-machine grants without sessions are untouched, and when the database check itself fails the refresh proceeds, the resource answers with a retryable 503 instead of revoking anything, and a loud marker lands in the logs.

3. And nothing around it moved: the external connector diagnostics and the provider refresh flow still pass every test they passed before this change.
