# org-capability-flags — Install links are default-on, with an org kill switch

Per-organization capability flags. Platform admins control them from the
/admin backoffice; install links now default ON for every org, and the stored
`metadata.capabilities.installLinks: false` value is the org-level kill switch.
The old `DEN_INSTALL_LINKS_GATING_ENABLED` deployment flag is inert. Each org
reads the effective state from the /v1/org payload, so `/admin` and workspace
surfaces agree.

1. Priya clears Acme's stored override, opens /admin, and the Install links checkbox is already checked — the admin API and Acme's own /v1/org payload both say install links are on by default.

2. She unchecks Install links for Acme — one org-level kill switch, no deploy — and the admin API shows Acme off while every other organization's effective state stays exactly as it was.

3. Acme's own workspace reads the same dark state through /v1/org while the kill switch is on, so workspace admins stop seeing install-link affordances without changing anyone else.

4. She checks Install links again and Acme immediately reports on through both /admin and /v1/org — the kill switch is reversible and scoped to one organization.
