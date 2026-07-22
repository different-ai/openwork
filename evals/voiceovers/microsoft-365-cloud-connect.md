# microsoft-365-cloud-connect — Admins choose Microsoft 365 capabilities and members connect safely

This release gives administrators a progressive permission picker for organizational Microsoft accounts. Existing Outlook mail, calendar, and OneDrive reads remain the safe defaults; calendar events, Outlook drafts, OneDrive writes, and Teams chats are explicit opt-ins. App-only administration, personal Microsoft accounts, sending mail, and creating Teams chats remain out of scope.

1. I open Connections and choose Microsoft 365. OpenWork guides me through Entra setup and shows Calendar, Outlook, OneDrive, and Teams groups with exact Graph scopes. Only the existing read capabilities start selected.

2. A teammate opens Your Connections and connects their own work account. The row shows the Microsoft tenant, connected identity, and the exact capabilities they approved.

3. I ask OpenWork to summarize my three latest emails. It returns concise summaries with links to the original Outlook messages, without importing my entire mailbox.

4. Next I ask for my upcoming meetings and the Q3 plan in OneDrive. OpenWork shows the next calendar events, finds the file, and returns its source link and content.

5. As an administrator, I enable calendar event creation, Outlook drafts, OneDrive writes, and Teams chats without replacing the saved credentials. The selections persist, an already connected member gets a clear reconnect prompt, and the expanded grant successfully performs each selected operation against the deterministic Microsoft Graph mock.

6. I disconnect Microsoft 365 and ask the same question again. OpenWork reports that my account needs to be connected instead of silently using another person's credentials.
