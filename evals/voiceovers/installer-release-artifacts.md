# installer-release-artifacts — The generic installer ships with every release and downloads stay signed

PR-3 of the invite-to-desktop track: a release-pipeline job publishes the one
generic (unbranded) installer as public release assets, and den-api learns to
serve org-stamped downloads straight from those published artifacts — no
local artifact directory, no per-org builds. The Mac stamped zip keeps the
signed, notarized .app byte-identical, so Gatekeeper stays quiet.

1. Every OpenWork release now ships one more thing: the generic installer — a single signed binary per platform, published right next to the app, ready to be stamped for any org.

2. A production-shaped server with no local files configured serves the Mac download anyway — it pulls the published release asset, stamps Acme's config into it on the fly, and caches it for next time.

3. The download that arrives still opens like it came straight from Apple: the app inside is untouched, its signature checks out, and it announces Acme before touching anything.

4. And the very same link keeps working for the whole fleet — Windows gets the tagged installer, Linux gets the setup script, all from one published release and one org toggle.
