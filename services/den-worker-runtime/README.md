# Den Worker Runtime Root

Render worker services use this directory as `rootDir`.

The control plane installs `openwork-orchestrator`, runs `scripts/install-opencode.mjs` during the Render build, and then launches workers with the `openwork` command.

That extra build step vendors the matching `opencode` release asset into `./bin/opencode` so the runtime does not depend on a first-boot GitHub download.
