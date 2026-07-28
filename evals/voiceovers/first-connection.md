# first-connection — An invited teammate cannot end up on the wrong server

Org install links already exist, but the web → download → desktop → web handoff
has silent failure modes: the dashboard download card can point at the wrong
build, a plain install can silently default to OpenWork Cloud, and nobody ever
learns whether the desktop actually connected. This flow closes the loop: every
step shows the one install link, every failure asks instead of guessing, and the
install page confirms the connection. Works identically for self-hosted servers.

1. On the OpenWork dashboard home, the admin clicks Download for this workspace — right on the overview, not buried in Members — and gets the workspace install page with a link ready to share with teammates.

2. The invitee opens that link and sees a three-step checklist — download, open the installer, sign in — with the install link pinned in a copy box the whole time, and a promise that this page will confirm once their desktop is connected.

3. The download itself is just the standard desktop app for Acme's approved version. Den redirects to that exact release asset instead of stamping or mutating the binary, while the install page keeps the organization link pinned for setup.

4. Suppose someone installs the plain OpenWork app: on first run it asks — use OpenWork Cloud, or join your organization by pasting your link — so the invitee pastes the same link and the app binds to their team's server; nothing ever defaults silently.

5. The desktop opens sign-in for Acme Robotics with the browser handling the handoff — and if a sign-in link ever points at a different server than this device is set up for, OpenWork asks before switching.

6. Back on the install page, step three flips to Connected — OpenWork is set up for Acme Robotics — proof, on the org's own page, that the desktop landed on the right server; and when nothing arrives, the page offers a sign-in code to paste into the app instead.
