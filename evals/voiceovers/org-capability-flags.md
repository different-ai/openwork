# org-capability-flags — Features ship dark, then light up one org at a time

Per-organization capability flags. Platform admins control them from the
/admin backoffice; every capability defaults to OFF for every org. Flags
live in the org metadata JSON — no schema change, no deploy. Each org reads
its own flags from the /v1/org payload, so a feature can check its flag the
moment it ships. The first key, `installLinks`, ships dark: nothing reads
it until the install-links PR lands.

1. Priya, a platform admin, opens the /admin backoffice and right on Acme's card there's a new Capabilities section — every flag starts off, for every org.

2. She flips Install links on for Acme — just Acme. No deploy, no environment variable, one checkbox in the backoffice.

3. Acme's own workspace now reports the capability as on — the /v1/org payload Acme's admins already read carries the flag, so any feature can read it the moment it ships.

4. She flips it back off and Acme reports dark again — org-by-org control of shipped-but-dark features, all from one screen.
