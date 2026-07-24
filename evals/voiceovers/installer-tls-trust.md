# OpenWork Installer trusts your company network

New teammates at organizations that inspect secure traffic (GlobalProtect and
similar) could open their workspace in the browser, yet the installer said
"Could not reach your workspace. Check your internet or VPN connection." The
installer now extends its trust with the certificates the operating system
already trusts, and when a secure connection genuinely cannot be verified it
says so honestly instead of blaming the network.

1. A new teammate opens the OpenWork installer and lands on the paste screen — the OpenWork logo up top, one box, one job: paste the install link from your team's install page.

2. On a corporate network that inspects secure traffic, the installer used to blame your internet or VPN. Now, when a workspace certificate cannot be verified, it tells the truth: your workspace was reached, the secure connection just isn't trusted on this computer yet — and it points IT at exactly the certificate to check.

3. On a managed machine, the corporate certificate your IT team already rolled out is enough: the installer picks it up the way enterprise deployments provide it, and the very same link now resolves straight into the team's install screen.

4. And for everyone else nothing changes: paste the link, the workspace answers, and the installer shows exactly which team it is setting up.
