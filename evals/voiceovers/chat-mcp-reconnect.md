# chat-mcp-reconnect — reconnect an expired MCP account from the chat

1. A connected Research Vault account expires before a requested capability runs. The normal capability search performs a live probe, identifies the exact connection, and puts a concise Reconnect Research Vault button beside the result, so the user does not have to translate setup instructions into another navigation journey.

2. Selecting Reconnect starts the real OpenWork Cloud flow for that exact connection. The row says Finish in browser while authorization is pending, then changes to Reconnected only after Den records a newer member authorization timestamp.

3. Returning to the task preserves its Reconnected state. Try again does not silently replay the previous tool; it prepares a visible draft that searches live capabilities again and warns the user to confirm a write did not already complete before repeating it.

4. A new task then runs the same Research Vault capability successfully and returns its exact result. This proves the inline action repairs the credential used by the real desktop-to-Den-to-provider execution path.

5. A different failure from the provider itself is labeled Provider error and does not receive a reconnect action. Only the canonical OpenWork Cloud capability tools with one unambiguous, versioned, member-owned reauthorization target can create the button; ordinary provider failures, shared credentials, ambiguous results, and untrusted tool output stay non-actionable.
