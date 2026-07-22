# org-google-workspace-demo — Your company's Google, one admin setup, every employee signs in as themselves

Cast reuses the org MCP demo — Alex (org admin, OpenWork Cloud) and Jordan
(member, desktop only). Google Workspace is not an MCP server: it rides the
existing org connections surface as a native provider — the same card,
consent copy, and poll-to-Connected the desktop already ships — while
execution is a Den capability route calling Google's REST APIs with the
member's own Den-brokered credential. The Google consent screen and Gmail
API are played by the protocol-identical mock IdP (env-overridden provider
URLs, eval only) so the round trip is real and externally witnessed without
a live Google account in CI. The chat frame stars a Gmail draft because
that matches the launch scopes. The pre-existing local/solo Google
Workspace extension is untouched — the final frame proves it.

1. Alex runs IT for Acme. In OpenWork Cloud, he sets up Google Workspace once for the whole company — pasting in the Google app Acme already owns and trusts. No employee will ever see this screen.

2. Jordan just has the desktop app. In Extensions, Google Workspace now shows up marked "Shared by your organization" — with one action: Connect your Google account. Nobody handed her a shared password; she signs in as herself.

3. She clicks it, and her real browser opens Google's consent screen for Acme's own app. One approve, and she's back in OpenWork — her sign-in kept safely in the company cloud, not in a file on her laptop.

4. She doesn't reload anything. The same card just flips to Connected.

5. Now she asks the agent to draft the follow-up email to her customer. It finds her company's Google connection on its own, writes the draft as her — and the draft is really sitting in her Gmail.

6. Meanwhile at a company that hasn't been enrolled yet, nothing changed — no Google card, no surprises. Admins decide when their org gets this, and rolling it back is just as instant.

7. And for solo users who set up Google Workspace on their own machine before today: still there, still local, still theirs. The company path is an addition, not a replacement.
