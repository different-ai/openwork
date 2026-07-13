# google-slack-oauth-ux — Clear OAuth setup, reauth recovery, and safe credential edits

1. “I open Connections and choose Google Workspace. OpenWork shows exactly how to create the Google OAuth app, including the redirect URI I need to copy, so I’m not guessing between Cloud Console tabs.”

2. “When I save Google Workspace settings and OpenWork needs a fresh security check, the dialog gives me one obvious next step: Continue with Google. After I confirm, OpenWork retries the save automatically.”

3. “Later I reopen Google Workspace to make a permissions-only edit. The app shows that credentials are already saved, and I can save the edit without pasting the client ID or secret again.”

4. “If I really need to rotate the Google credentials, I choose Replace credentials. Only then do the client ID and client secret fields become editable and required again.”

5. “I add Slack from quick add, and OpenWork explains Slack’s requirement up front: Slack MCP needs a pre-registered Slack app because Slack does not support automatic app registration.”

6. “After I create the Slack connection, OpenWork shows the exact redirect URL to add to the Slack app and gives me a copy button. I know which URL to whitelist before teammates connect.”
