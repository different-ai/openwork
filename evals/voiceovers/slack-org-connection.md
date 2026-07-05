1. Slack now appears as a real OpenWork Cloud Connections preset, so an admin can find it in the same quick-add grid as Notion and Linear instead of hand-copying the server URL.

2. Because Slack's MCP server does not support automatic OAuth app registration, the Slack dialog asks for a pre-registered OAuth app up front. We stop before real Slack OAuth in CI, but this is the exact admin handoff Slack requires.

3. For the end-to-end proof, a DCR-less stand-in server plays Slack's role: the admin pastes a pre-registered client, and OpenWork returns the exact redirect URL to whitelist in that app.

4. When the admin connects their own account from Your Connections, OAuth completes without any dynamic client registration call, proving OpenWork used the org's pre-registered client path.
