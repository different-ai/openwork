# org-google-workspace-reconnect — Google Workspace members get a reconnect nudge when admins add scopes

When an admin expands the org Google Workspace feature set, members who already
connected should not look fully ready with an older token. This demo connects a
member with the base identity grant, expands the org permissions, and proves the
member sees a clear reconnect path before returning to the normal connected
state.

1. Jordan connected Google Workspace before any optional permissions were enabled. Their Your Connections page is calm and green: Google Workspace is connected as them, with no reconnect warning.

2. Alex enables Read Gmail and Create calendar events for the org. Jordan's row immediately changes from ready to an amber reconnect prompt, with a Reconnect button and the Disconnect escape hatch still available.

3. Jordan clicks Reconnect. The mock Google consent page now lists the newly requested Gmail read and Calendar event scopes, so the extra permissions are explicit before approval.

4. After approval, Jordan lands back in Your Connections and the row is green again. The API agrees that no reconnect is needed anymore.

5. Finally, Jordan disconnects the account. The same row falls back to Connect your account, proving the reconnect nudge did not break the normal disconnect path.
