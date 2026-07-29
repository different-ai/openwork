# org-connection-lifecycle-desktop — connect, reconnect, and disconnect an org connection from the desktop

An organization admin has shared a per-member MCP connection (a Granola-style
OAuth service) with the team. Until now the desktop Extensions detail page
showed the connection but offered no lifecycle actions — members had to fall
back to the cloud dashboard to connect, and could not disconnect or
re-authorize an external connection at all.

1. Jordan opens Extensions and filters to Connections — the org-shared connection is sitting under "Needs your sign-in", and opening it shows an honest status: Not connected, OAuth required, with a Connect your account button right in the details.

2. Jordan clicks Connect — the desktop hands off to the browser for the real OAuth sign-in and waits, no config files, no dashboard round-trip.

3. The moment the sign-in completes, the detail page flips to Connected on its own — no reload — and the connection now shows exactly who it's connected as: Jordan's own account.

4. Because things go stale in the real world, the connected view now offers both Reconnect and Disconnect, so Jordan controls the whole lifecycle from the desktop.

5. Jordan hits Reconnect — one more browser round trip and the connection is re-authorized fresh, which is the fix for expired tokens or newly requested permissions.

6. Finally Jordan clicks Disconnect — the connection drops back to "Connect your account", the cloud confirms Jordan's credential is gone, and Jordan can sign back in whenever they want. Full connect, reconnect, disconnect — without ever leaving the app.
