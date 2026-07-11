# client-connect-link — The enterprise installer becomes your org's with one signed link

Continuation of the invite-to-desktop track: the network-neutral enterprise
installer plus signed connect links. Den stays remote; it was never bundled.
The enterprise flavor ships no local engine — no embedded
openwork-server, no sidecar binaries — a clean client for fleets whose
execution lives on company infrastructure. Pairing it is a new convention: the
Den mints an `openwork://connect?token=<JWT>` deep link (EdDSA, vendor key held
outside the repo), the app verifies it offline against the public key baked
into the build, and the user confirms the organization's name, branding, and
server before anything is written. The link is configuration provenance, not
authentication — SSO still gates access. It writes through the same app-name,
wordmark, icon, and server fields as managed desktop-bootstrap.json. Evals
drive the enterprise mode with a dev-gated test key and the dev email outbox.

1. A teammate installs OpenWork Enterprise, and it opens without contacting OpenWork Cloud: ready to connect — check your email for your organization's connection link.

2. Acme's admin sends her a connect link, and the "Connect your desktop" email is on its way — org name, logo, and a single button.

3. She clicks it and the app wakes, checking the link's signature against the OpenWork key it shipped with before trusting a byte of it.

4. Verified, the app shows exactly what's about to happen — set up Acme Work for Acme Robotics on Acme's own server — and until she confirms, nothing is written.

5. One confirm and it's Acme's app: the existing bootstrap JSON now carries Acme's app name, wordmark, icon, and server, then familiar sign-in takes over.

6. A tampered token or an expired one gets the same calm refusal with a reason, and the app stays exactly as it was.
