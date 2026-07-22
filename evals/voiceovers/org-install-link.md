# org-install-link — A shared install link yields an app that's already your org's

PR-2 of the invite-to-desktop track: org install links. An admin mints a
shareable link; the installer it serves is the one generic signed binary,
stamped per org at serve time (zip sidecar on macOS, Content-Disposition
filename tag on Windows, install script on Linux). The installer writes
`desktop-bootstrap.json` with the org's server and `requireSignin: true`, so
the app's first boot is the forced sign-in against the right deployment — no
per-org builds anywhere. The generic release asset ships in PR-3; evals point
the artifact source at a locally compiled binary.

1. Alex wants the whole team on OpenWork, so from the team page he copies Acme's install link — one button, and it's ready to paste into Slack, an email, anywhere.

2. A new teammate opens the link and the download that arrives isn't a generic app — the installer itself is Acme's, org baked into the file they just downloaded.

3. They run it, and before touching anything it says exactly what it's about to do: set up OpenWork for Acme Robotics, on Acme's workspace — one click to continue.

4. The installer fetches the right app version and writes Acme's configuration, so when OpenWork opens for the first time it isn't an empty app asking them to pick a folder — it's Acme's app, asking them to sign in.

5. One click on Sign in with OpenWork Cloud, a browser flash, and they're standing in Acme's workspace — nobody typed a server URL, ever.

6. And if someone ends up with the bare installer instead — forwarded file, renamed download — it doesn't refuse to run; it just asks for the install link, and a paste gets them to the same place.
