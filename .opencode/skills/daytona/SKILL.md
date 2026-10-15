---
name: daytona
description: Daytona CLI setup, sandbox debugging, keep a sandbox alive, secrets volume, snapshot refresh. Use when Daytona itself is the problem, not for running tests (see run-tests).
---

# Daytona

Infrastructure only. To run tests use `pnpm evals:e2e <slug>` (`run-tests`). For PR previews use `preview-my-work`. Per **Use the Maintained Lever**, use the `.devcontainer` helpers below instead of rebuilding their steps.

## Setup and identity

- Install with `brew install daytonaio/cli/daytona`, then `daytona login`.
- Team key: per **Scope Secrets**, `DAYTONA_API_URL=https://app.daytona.io/api DAYTONA_API_KEY="$(infisical secrets get DAYTONA_API_KEY --env dev --path /openwork-ops --plain --silent)" <command>`. Without the URL the CLI silently uses the saved profile.
- Saved profile: `$DAYTONA_CONFIG_DIR/config.json` (macOS `~/Library/Application Support/daytona/`, Linux `~/.config/daytona/`, Windows `%APPDATA%\daytona\`). Point `DAYTONA_CONFIG_DIR` at an empty dir to test logged-out paths.
- Never `daytona login --api-key` on someone's machine (**Touch Only What You Own**).
- A browser login may land in a personal org: 10 GiB memory cap, no warm snapshots, so multi-sandbox previews fail. `pnpm world plan <world> --place daytona` prints the identity and warns.
- "CLI is on vX and API is on vY" is a warning. Fix with `brew upgrade daytonaio/cli/daytona`.

## Helpers

| Need | Command |
|---|---|
| Manual Electron sandbox (XFCE/noVNC, Vite, Electron) | `bash .devcontainer/test-on-daytona.sh <ref>` |
| Manual server sandbox (MySQL, Den API, Den Web) | `bash .devcontainer/test-server-on-daytona.sh <ref>` |
| Secrets volume (mounted at `/daytona-secrets`) | `bash .devcontainer/setup-daytona-secrets-volume.sh <local-env> <name>.env` |
| Refresh snapshots | `bash .devcontainer/create-daytona-openwork-snapshot.sh` and `...-server-snapshot.sh` |
| Teardown | `daytona delete <sandbox>` |

## Debugging

- Logs: `/tmp/start-vnc.log`, `/tmp/vite.log`, `/tmp/electron.log`, `/tmp/den-api.log`.
- CDP is port `9825`, noVNC `6080`: `daytona preview-url <sandbox> -p 9825`.
