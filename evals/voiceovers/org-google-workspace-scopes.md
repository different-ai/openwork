# org-google-workspace-scopes — Org Google Workspace covers the desktop permission set, and admins can pick more

The org-level Google Workspace connection in OpenWork Cloud previously
requested only `openid email gmail.compose`. Identity is now fixed, while each
Calendar, Gmail, Drive, and Chat capability is a granular permission pick. The
desktop-parity defaults (Calendar read, Gmail drafts, selected Drive files)
start checked, and admins can add or remove individual capabilities. Picks are
stored on the org's OAuth client row and reflected in the authorize URL members
are sent to.

1. As the workspace admin, I open Connections in the OpenWork Cloud dashboard and tap Google Workspace. I now see every permission my team's AI could use across Calendar, Gmail, and Drive — with the desktop app's defaults already checked.

2. I add Read Gmail and Create calendar events on top of the defaults, paste my client ID and secret, and save.

3. Reopening the setup shows Google Workspace is configured with my extra permissions still checked — I can adjust my picks any time without retyping the client.

4. When a teammate connects their Google account, the Google consent screen asks for exactly the defaults plus my two additions — nothing more.

5. After approving, their card flips to Connected and the connection records those granted permissions — ready for Gmail, Calendar, and Drive work through OpenWork.
