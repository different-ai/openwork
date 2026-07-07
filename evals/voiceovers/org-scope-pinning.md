# org-scope-pinning

1. An admin who belongs to several organizations signs in, picks one in the organization chooser, and lands on that org's Connections screen — the dashboard is now clearly operating in the org they chose.

2. While the add-connection dialog is open, the account's active organization flips to a different org behind the scenes — the same drift a second tab or the desktop app can cause. The admin finishes the dialog anyway, and the connection is created without any organization-not-found error, because every Connections request now carries the org the admin is actually looking at.

3. Back on the same org's Connections list, the new connection is right there — and the API confirms it lives in the org the admin saw on screen, not in the org the session had drifted to. The stray write and the confusing 404 are both gone.
