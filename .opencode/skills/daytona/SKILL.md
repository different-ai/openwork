---
name: daytona
description: Daytona CLI setup, sandbox debugging, keep a sandbox alive, secrets volume, snapshot refresh. Use when Daytona itself is the problem, not for running tests (see run-tests).
---

# Daytona

Use this skill for Daytona infrastructure, not test placement.

## Setup

Install the Daytona CLI with `brew install daytonaio/cli/daytona`, then authenticate:

```bash
daytona login
```

### Which identity the CLI uses

- **Environment key.** The CLI uses `DAYTONA_API_KEY` only when
  `DAYTONA_API_URL=https://app.daytona.io/api` is also set; with the key alone
  it silently falls back to the saved profile. Scope the team key (Infisical
  `dev`, `/openwork-ops`) to one command:
  `DAYTONA_API_URL=https://app.daytona.io/api DAYTONA_API_KEY="$(infisical secrets get DAYTONA_API_KEY --env dev --path /openwork-ops --plain --silent)" <command>`.
- **Saved profile.** Otherwise the active profile in
  `$DAYTONA_CONFIG_DIR/config.json` (default: macOS
  `~/Library/Application Support/daytona/`, Linux `~/.config/daytona/`,
  Windows `%APPDATA%\daytona\`). Point `DAYTONA_CONFIG_DIR` at an empty
  directory to test the not-logged-in path without touching the real profile.
- **Never run `daytona login --api-key` on someone's machine for a one-off
  task.** It overwrites their profile, and with it their browser login, for
  every tool. A key printed as `*not found*` (Infisical CLI 0.28.x exits 0 on a
  missing secret) is not a key.
- **Personal-organization trap.** A browser login may default to the person's
  personal organization: a 10 GiB total memory cap and none of the team's warm
  snapshots, so multi-sandbox previews fail with a memory-limit error.
  `pnpm world plan <world> --place daytona` prints the identity and
  organization in use and warns on a personal one.
- **Version warning.** "Daytona CLI is on vX and API is on vY" on every call is
  a warning, usually not the cause of a failure; fix it with
  `brew upgrade daytonaio/cli/daytona`.

To run tests, just use `pnpm evals:e2e <slug>` — it picks Daytona automatically
when the CLI is authenticated. `--local` forces local; `--daytona` requires
Daytona and fails when it is unavailable.

For a PR preview that should open inside Codex and support named scenarios,
use [preview-my-work](../preview-my-work/SKILL.md). It composes the same maintained
world and Daytona primitives with scoped ownership and teardown.

## Long-lived manual Electron sandbox

Run `bash .devcontainer/test-on-daytona.sh <ref>`. The maintained helper uses
the reusable desktop snapshot, starts XFCE/noVNC, Vite, and Electron, and prints
the sandbox and preview URLs. Keep that sandbox for exploration or debugging
instead of reproducing its provisioning commands.

## Long-lived manual server sandbox

Run `bash .devcontainer/test-server-on-daytona.sh <ref>`. It starts the separate
MySQL, Den API, and Den Web sandbox and prints public URLs for a desktop sandbox
to consume. Use this helper rather than assembling the server manually.

## Debugging

Inspect `/tmp/start-vnc.log`, `/tmp/vite.log`, `/tmp/electron.log`, and
`/tmp/den-api.log` in the relevant sandbox. Electron CDP is port `9825`; get CDP
and noVNC URLs with:

```bash
daytona preview-url <sandbox> -p 9825
daytona preview-url <sandbox> -p 6080
```

## Secrets

```bash
bash .devcontainer/setup-daytona-secrets-volume.sh <local-env> <name>.env
```

Electron sandboxes mount the reusable secrets volume at `/daytona-secrets`.

## Snapshot refresh

```bash
bash .devcontainer/create-daytona-openwork-snapshot.sh
bash .devcontainer/create-daytona-openwork-server-snapshot.sh
```

## Teardown

```bash
daytona delete <sandbox>
```
