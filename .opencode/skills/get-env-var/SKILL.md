---
name: get-env-var
description: "get an env var, fetch a secret, missing env var, missing token/API key, load secrets from Infisical, infisical. Fetch secrets from the team's Infisical workspace into the shell environment so subsequent commands can use them."
---

# Skill: get-env-var

Fetch a secret from the team's Infisical workspace into the current shell so the next command can use it.

## When to use

- A command or script needs an env var that is not set, such as `BLOB_READ_WRITE_TOKEN`.
- A token, API key, or other secret is missing from the environment.
- The user asks to load secrets from Infisical.

## Setup (once per machine)

- Install the CLI on macOS: `brew install infisical/get-cli/infisical`.
- Check `infisical --version`. The commands below need a current CLI: 0.28.x has no `user get` and no `--output json`, and behind `2>/dev/null` those fail silently with empty output. Upgrade with `brew upgrade infisical`.
- Check auth with `infisical user get`; if it fails or a command reports you are not logged in, run `infisical login` and complete the browser flow.
- For CI or other non-interactive runs, set `INFISICAL_TOKEN` from a machine identity; the CLI skips login when it is present.
- This repo is already project-linked via tracked `.infisical.json` (`workspaceId: "e9f4542a-8714-46c3-a8fd-99d8cb370aeb"`, empty `defaultEnvironment`). From the repo root, `infisical` defaults to the `dev` environment slug when `--env` is omitted.

## Fetch one secret into the environment

Run from the repo root:

```bash
export NAME="$(infisical secrets get NAME --plain --silent)"
```

- Replace `NAME` with the secret name.
- Add `--env <slug>` for a non-default environment; this repo defaults to `dev`.
- Add `--path /some/folder` when secrets are organized in folders. A folder's secrets do not appear at the root path.

## Known locations

| Secret | Environment | Path | Used by |
|---|---|---|---|
| `FREESTYLE_API_KEY` | `dev` | `/openwork-ops` | Freestyle placements of `pnpm world` (`preview-desktop`, `preview-app-web`, `acme-web`) |
| `DAYTONA_API_KEY` | `dev` | `/openwork-ops` | Daytona placements of `pnpm world`, in the team organization. The `dev` root path has one for the same organization. Only works together with `DAYTONA_API_URL=https://app.daytona.io/api` (not a secret, not in Infisical); without it the Daytona CLI silently ignores the key. |

Scope a world secret to the one command that needs it instead of exporting it:

```bash
FREESTYLE_API_KEY="$(infisical secrets get FREESTYLE_API_KEY --env dev --path /openwork-ops --plain --silent)" pnpm world up preview-desktop --place freestyle --stage <stage> --detach
DAYTONA_API_URL=https://app.daytona.io/api DAYTONA_API_KEY="$(infisical secrets get DAYTONA_API_KEY --env dev --path /openwork-ops --plain --silent)" pnpm world up preview-desktop --place daytona --stage <stage> --detach
```

Never feed a key to `daytona login --api-key`: that replaces the person's
Daytona CLI login for every tool on the machine.

`pnpm world plan <world> --place <place>` reports a missing world secret, with this fix, before anything is created.

## Inject everything into a command

Run the command through Infisical so all project secrets are available only to that process:

```bash
infisical run -- <command>
```

Not for `pnpm world`: it injects every root secret into processes the world
starts, and omits `DAYTONA_API_URL`, so the Daytona key is ignored. Use the
scoped forms above.

## Discover, check, and forward without ever seeing a value

Always run from the repo root; outside it `infisical` errors and emits an empty stdout, which a downstream `gh secret set` will silently store.

```bash
# Which secrets exist? Names only, via structured output. Never list with
# --plain or the default table: both print values, and multi-line values
# (private keys) defeat any line-based filter such as cut or awk.
infisical secrets --env dev --output json --silent 2>/dev/null | jq -r '.[].secretKey'

# The same on CLI 0.28.x, which has no --output json (keys only, via jq):
infisical export --env dev --path <path> --format json --silent 2>/dev/null | jq -r '.[].key'

# Does NAME exist and is it non-empty? Prints a byte count, never the value.
# 12 is the "*not found*" placeholder older CLIs print (with exit 0), not a value.
infisical secrets get NAME --plain --silent 2>/dev/null | wc -c

# Forward NAME to a consumer in one pipe (e.g. a GitHub Actions secret).
infisical secrets get NAME --plain --silent 2>/dev/null | gh secret set NAME --repo <owner>/<repo>
```

## Rules

- Never echo, print, or otherwise log secret values.
- Never write secrets to files, logs, commit messages, PR bodies, or comments.
- Only use `--plain` with `secrets get NAME` inside command substitution, as in `export NAME="$(...)"`, or piped straight into a single consumer as above. Never use `--plain` to list.
- Never pass a secret-bearing stream through `grep`, `rg`, `awk`, `sed`, `cut`, `head`, or any line-based filter: multi-line values and one mismatched pattern both land values in the tool output. Listing is `--output json | jq -r '.[].secretKey'` (or, on 0.28.x, `export --format json | jq -r '.[].key'`) only.
- Treat every `infisical secrets ...` command as printing values unless it is the JSON name listing above, piped into `wc -c`, or piped into a consumer.
- If a secret does not exist, STOP and tell the user exactly which secret name and environment to add in Infisical; do not invent values.
