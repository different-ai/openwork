# chat-mcp-reconnect — reconnect an expired MCP account from the chat

1. A connected Research Vault account expires before a requested capability runs. The normal capability search performs a live probe, identifies the exact connection, and puts a concise Reconnect Research Vault button beside the result, so the user does not have to translate setup instructions into another navigation journey.

2. Selecting Reconnect starts the real OpenWork Cloud flow for that exact connection. While provider consent is pending, the row stays usable and offers Open sign-in again. Reopening uses the same pending authorization instead of starting a duplicate reconnect or forcing the user to wait for a timeout.

3. After real provider consent, the row changes to Reconnected only when Den records a newer member authorization timestamp. The reusable browser action does not treat opening a page as successful sign-in.

4. Returning to the task preserves its Reconnected state. Try again does not silently replay the previous tool; it prepares a visible draft that searches live capabilities again and warns the user to confirm a write did not already complete before repeating it.

5. A new task then runs the same Research Vault capability successfully and returns its exact result. This proves the inline action repairs the credential used by the real desktop-to-Den-to-provider execution path.

6. A different failure from the provider itself is labeled Provider error and does not receive a reconnect action. Only the canonical OpenWork Cloud capability tools with one unambiguous, versioned, member-owned reauthorization target can create the button; ordinary provider failures, shared credentials, ambiguous results, and untrusted tool output stay non-actionable.
