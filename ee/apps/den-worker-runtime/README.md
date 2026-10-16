# Den Worker Runtime Root

Render worker services use this directory as `rootDir`.

The control plane installs `openwork-server`, runs the repository's `scripts/install-opencode2.mjs` during the Render build, and then launches workers with the `openwork-server` command.

That build step vendors the pinned OpenCode engine (`constants.json` `opencodeV2Version`, integrity-checked against `apps/server/src/opencode-v2-artifacts.json`) into `./bin/opencode2`, so the runtime does not depend on a first-boot download.
