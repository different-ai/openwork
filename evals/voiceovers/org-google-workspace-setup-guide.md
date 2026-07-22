# org-google-workspace-setup-guide — The Google Workspace setup walks admins through creating the OAuth client

Setting up the org Google Workspace connection requires a Google Cloud OAuth
client. The setup dialog now teaches the admin exactly how to create one:
which console pages to visit, which APIs to enable, and the exact authorized
redirect URI to register — with one-tap copy. The same redirect URI is
available through the API even before anything is configured, and it is
exactly where member sign-ins return.

1. As the workspace admin, I open the Google Workspace setup and the dialog now walks me through creating the OAuth client — where to go in the Google Cloud console and which APIs to enable.

2. The exact redirect URL my org needs is right there — one tap copies it, ready to paste into my Google OAuth client's authorized redirect URIs.

3. The setup links take me straight to the right Google console pages, so I never hunt through Google's settings.

4. The redirect URL shown is exactly where my teammates' sign-ins will return — the API reports the same URL, and a member's Google sign-in round trip uses it verbatim.
