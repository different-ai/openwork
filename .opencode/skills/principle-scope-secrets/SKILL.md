---
name: principle-scope-secrets
description: "Apply whenever a command needs a key or token. Load it from Infisical inside a command substitution on the one command that needs it; never print, list with values, write to disk, or replace someone's CLI login."
metadata:
  opencode/autoinvoke: "false"
  opencode/slash: "true"
---

# Scope Secrets

A secret lives for one command and is never seen.

**Why:** Printed, exported, or injected-everywhere secrets leak into logs, PR text and child processes. Overwritten logins break the person's other tools.

- Shape: `NAME="$(infisical secrets get NAME --env dev --path <path> --plain --silent)" <command>`, from the repo root.
- Never echo, grep, or line-filter a secret stream. List names only via `--output json | jq -r '.[].secretKey'`.
- Never `daytona login --api-key` on someone's machine. `DAYTONA_API_KEY` works only with `DAYTONA_API_URL=https://app.daytona.io/api`.
- Do not wrap worlds in `infisical run`; it injects every root secret into every process the world starts.
- `*not found*` (old CLIs exit 0) is not a value. Stop and name the missing secret and environment. See `get-env-var`.
