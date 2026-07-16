# chat-mcp-reconnect — reconnect an expired MCP account from the chat

1. A connected Research Vault account expires before a requested capability runs. The normal capability search performs a live probe, identifies the exact connection, and puts a concise Reconnect Research Vault button beside the result, so the user does not have to translate setup instructions into another navigation journey.

2. Selecting Reconnect starts the real OpenWork Cloud connection flow for that connection. The chat immediately changes the action to Finish in browser while Den and the OAuth provider exchange a fresh authorization, keeping the recovery anchored to the failed tool.

3. After authorization completes, a new task runs the same Research Vault capability successfully and returns its exact result. This proves the inline action repairs the credential used by the real desktop-to-Den-to-provider execution path.

4. A different failure from the provider itself is labeled Provider error and does not receive a reconnect action. Only the canonical OpenWork Cloud capability tools with one unambiguous structured reauthorization target can create the button; ordinary provider failures, ambiguous results, and untrusted tool output stay non-actionable.
