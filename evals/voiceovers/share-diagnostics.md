# share-diagnostics — Sharing logs when things go wrong is one step from the command palette

OpenWork already collects runtime diagnostics — app build, engine and server
state, recent log tails — but getting them out was buried behind Developer
Mode in Settings → Debug. This demo shows the streamlined path: two
command-palette entries that produce the same sanitized bundle everywhere.

1. Something in my workspace isn't behaving. I press Cmd+K and type "logs" — the palette offers Copy diagnostics right there, no developer mode, no digging through settings.

2. I pick it, a toast confirms, and the diagnostics bundle is on my clipboard — app version, engine and server state, recent log tails — ready to paste into an issue or a support thread.

3. Back in the palette, Export diagnostics saves the same bundle as a JSON file, for when a maintainer asks for an attachment.

4. And it's safe to share by default: the bundle records whether a connection token exists — yes or no — never the value itself.
