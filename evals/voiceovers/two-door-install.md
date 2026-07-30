# two-door-install — Every download door has exactly one honest outcome

Refines the first-connection work into the two-door model: the landing page
always hands out the normal app (with the first-run join fork as option
cards), the org install page always hands out the paste-gated installer, and
nothing is stamped into artifacts anymore — the link is the only carrier. The
den server never touches installer bytes (it redirects), so a semi-airgapped
server with zero egress serves the whole flow. No env vars, no zip envelopes,
no filename tags.

1. From the landing page you get the normal OpenWork app, and on first run it offers a calm choice — three option cards: use OpenWork Cloud, join your organization with your link, or just get started locally.

2. From your team's install page the download is different on purpose: a small installer whose only job is connecting this computer to your team — and the page keeps your install link pinned right next to the steps.

3. The installer asks for exactly one thing, the link — until it gets one nothing installs, so there is no wrong server you can possibly end up on.

4. Paste the link and it confirms your team and server, installs the version your organization supports, and launches OpenWork straight into your team's sign-in — never a default.

5. The den server never fetched a byte to make that happen — it only redirected the download — so even with every outbound connection blocked on the server, setup still completes.

6. Sign in from the browser and the install page flips to Connected — proof on your team's own page that this desktop landed on the right server.

7. And when a link has expired or been replaced, both the page and the installer say so plainly and point at the fix — ask your admin for a fresh link.
