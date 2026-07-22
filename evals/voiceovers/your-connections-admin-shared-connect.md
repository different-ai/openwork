# your-connections-admin-shared-connect — Connect a shared tool right where you found it

Cast is Alex, the Acme Robotics admin, in OpenWork Cloud on the web. His org
published Notion-style tooling as a shared-account connection, but nobody ever
finished authorizing it — so until now the member-facing Your Connections page
showed a dead-end "Not connected yet" badge with nothing to click, and the only
way to get connected was outside the browser. This demo shows the fix: an admin
can complete the connection right on Your Connections.

1. Alex opens Your Connections and sees the tool his org made available. It is not connected yet — but because Alex is an admin, the row now says Connect the org account and offers a real Connect button right here, instead of a dead end.

2. Clicking Connect opens the service's own authorization page in a new tab. Alex approves once, the standard OAuth handshake completes for real, and the tab confirms the account is connected.

3. Back on Your Connections, nothing needed a refresh: the page's own polling flips the row to Connected on its own. From this moment, everyone granted access — and their AI coworkers — can use the tool.
