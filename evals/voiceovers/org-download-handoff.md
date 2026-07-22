# org-download-handoff — Joining an org hands you the org's guided install: download, open, connect, sign in — no dead ends

Today an invited member lands on a success screen whose primary button
("Open OpenWork", an auth handoff) assumes the app is already installed, next
to a generic public download. This PR routes the join hand-off into the
existing guided org install experience (a member-minted install link opens
the `/install` guide), whose connect step configures the app for the org with
`requireSignin: true` — the exact same app, forced sign-in, only when the
download came from inside the org. It also gives the guide's open step a
recovery affordance (copy the connection link) so a failed deep link is never
a dead end. Bundling sign-in into the connect deep link stays deliberately
out of scope: the deep link connects, the app's sign-in screen signs in.

1. Maya accepts her invite to Acme, and the welcome screen doesn't throw three equal buttons at her — it offers one clear next step: get the desktop app.

2. One click and she's on Acme's guided setup — download, open, sign in, in that order — and the download comes from inside her org, the exact build Acme approved.

3. The guide waits with her while she installs, and says it plainly: only continue once OpenWork is installed and running on this computer — and if she already has the app, one click says so.

4. She clicks Open OpenWork, and the app jumps to the front asking exactly what's about to happen: connect this copy to Acme Robotics, on Acme's server — nothing changed yet.

5. She hits Connect, and the app becomes Acme's on the spot — and because it came from her org, there's no way around sign-in: it lands straight on the sign-in screen, her workspace already filled in.

6. One click on Sign in with OpenWork Cloud, and she's standing in Acme's workspace — nobody typed a server URL, ever.

7. And if the hand-off doesn't fire — locked-down browser, whatever — the guide doesn't shrug: it hands her the connection link itself; copy it, drop it anywhere that opens links, and the same confirmation appears.
