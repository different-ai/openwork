# first-connection — An invited teammate cannot end up on the wrong server

Org install links already exist, but the web → download → installer → desktop →
web handoff has silent failure modes: the dashboard download card serves the
generic GitHub build, a lost sidecar or renamed installer dead-ends, a plain
install silently defaults to OpenWork Cloud, and nobody ever learns whether the
desktop actually connected. This flow closes the loop: every step shows the one
install link, every failure asks instead of guessing, and the install page
confirms the connection. Works identically for self-hosted servers.

1. On the OpenWork dashboard home, the admin clicks Download for this workspace — right on the overview, not buried in Members — and gets the workspace install page with a link ready to share with teammates.

2. The invitee opens that link and sees a three-step checklist — download, open the installer, sign in — with the install link pinned in a copy box the whole time, and a promise that this page will confirm once their desktop is connected.

3. They download and open the installer, and it already knows the team: "This sets up OpenWork for Acme Robotics", with the server address right there — one click installs.

4. And if the installer ever can't read its stamp — say the file got renamed — it doesn't guess: it asks for the install link, the same one still sitting in the checklist, and pasting it continues exactly the same way.

5. Suppose someone skips all that and installs the plain OpenWork app instead: on first run it asks — use OpenWork Cloud, or join your organization by pasting your link — so the invitee pastes the same link and the app binds to their team's server; nothing ever defaults silently.

6. The desktop opens sign-in for Acme Robotics with the browser handling the handoff — and if a sign-in link ever points at a different server than this device is set up for, OpenWork asks before switching.

7. Back on the install page, step three flips to Connected — OpenWork is set up for Acme Robotics — proof, on the org's own page, that the desktop landed on the right server; and when nothing arrives, the page offers a sign-in code to paste into the app instead.
