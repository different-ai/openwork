---
name: get-env-var
description: "get an env var, fetch a secret, missing env var, missing token/API key, load secrets from Infisical, infisical. Fetch secrets from the team's Infisical workspace into the shell environment so subsequent commands can use them."
---

# get-env-var

Load a secret from the team's Infisical workspace for the next command. Follow **Scope Secrets** throughout.

## Setup (once per machine)

- Install with `brew install infisical/get-cli/infisical`. Upgrade with `brew upgrade infisical`. CLI 0.28.x has no `user get` and no `--output json`, and fails silently behind `2>/dev/null`.
- Check auth with `infisical user get`. If it fails, run `infisical login`.
- CI uses `INFISICAL_TOKEN` from a machine identity and skips login.
- The repo is linked by tracked `.infisical.json`. From the repo root, `--env` defaults to `dev`. Outside the root, `infisical` prints an empty stdout that a downstream consumer will happily store.

## Fetch

```bash
NAME="$(infisical secrets get NAME --plain --silent)" <command>        # preferred: one command
export NAME="$(infisical secrets get NAME --plain --silent)"           # when several commands need it
```

Add `--env <slug>` for another environment and `--path /folder` for foldered secrets. Folder secrets do not appear at the root.

## Known locations

| Secret | Env | Path | Used by |
|---|---|---|---|
| `FREESTYLE_API_KEY` | `dev` | `/openwork-ops` | Freestyle placements of `pnpm world` and the core journey |
| `DAYTONA_API_KEY` | `dev` | `/openwork-ops` | Daytona placements in the team org. Needs `DAYTONA_API_URL=https://app.daytona.io/api` (not a secret) or the CLI ignores it |

```bash
DAYTONA_API_URL=https://app.daytona.io/api DAYTONA_API_KEY="$(infisical secrets get DAYTONA_API_KEY --env dev --path /openwork-ops --plain --silent)" pnpm world up <world> --place daytona --stage <stage> --detach
```

`pnpm world plan <world> --place <place>` reports a missing world secret before anything is created.

`infisical run -- <command>` injects every project secret into one process. Never use it for `pnpm world`.

## Discover, check, forward without seeing a value

```bash
infisical secrets --env dev --output json --silent 2>/dev/null | jq -r '.[].secretKey'                 # names only
infisical export --env dev --path <path> --format json --silent 2>/dev/null | jq -r '.[].key'          # names on 0.28.x
infisical secrets get NAME --plain --silent 2>/dev/null | wc -c                                        # 12 = "*not found*"
infisical secrets get NAME --plain --silent 2>/dev/null | gh secret set NAME --repo <owner>/<repo>     # forward
```

Every other `infisical secrets ...` form prints values. A missing secret: stop and tell the user the exact name and environment to add.
