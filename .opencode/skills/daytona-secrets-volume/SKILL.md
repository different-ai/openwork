---
name: daytona-secrets-volume
description: Daytona secrets volume setup. Use when the user says Daytona secrets, add provider key, OpenAI key, Anthropic key, eval secrets, /daytona-secrets, or openwork-eval-secrets.
---

# Daytona Secrets Volume

Use this skill when Daytona tests need provider keys or other eval-only secrets.
Never commit secrets to the repo and never print secret values.

## The Volume

The reusable Daytona volume is:

```text
openwork-eval-secrets:/daytona-secrets
```

Electron sandboxes mount it automatically through `.devcontainer/test-on-daytona.sh`.
The Electron starter sources every file matching:

```text
/daytona-secrets/*.env
```

This is a Daytona reusable volume, not a host directory. You cannot inspect it
directly from the local filesystem. To add, list, or test files, mount it into a
temporary Daytona sandbox or use an existing sandbox that mounted the volume.

## Add A Secret File

Create a local env file, then copy it into the volume:

```bash
bash .devcontainer/setup-daytona-secrets-volume.sh <local-env-file> <name>.env
```

Examples:

```bash
bash .devcontainer/setup-daytona-secrets-volume.sh .newtoken openai.env
bash .devcontainer/setup-daytona-secrets-volume.sh .anthropic anthropic.env
bash .devcontainer/setup-daytona-secrets-volume.sh .google google.env
```

The destination must be a simple `.env` filename such as `openai.env`. The
script copies the file without printing secret values and sets restrictive
permissions. Do not pass secrets as command-line arguments; put them in a local
env file and pass only the filename.

## Expected Env File Shape

Use normal shell env format:

```bash
OPENAI_API_KEY=...
ANTHROPIC_API_KEY=...
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...
```

Only include variables needed by evals. Keep files small and purpose-specific.

## Reload Existing Sandbox

If the sandbox is already running, restart Electron so it reloads `/daytona-secrets/*.env`:

```bash
daytona exec "$SANDBOX" -- "bash -lc 'pkill -f electron || true; pkill -f electron-dev || true; pkill -f opencode || true'"
sleep 3
daytona exec "$SANDBOX" -- "bash -lc 'cd /workspace && bash /opt/openwork-daytona/start-daytona-electron.sh --detach'"
```

Do not chain the kill and restart in one `daytona exec` command. The `pkill`
pattern can terminate the exec wrapper itself.

## Verify Without Printing Secrets

Check only filenames or whether expected variables are present:

```bash
daytona exec "$SANDBOX" -- 'ls -la /daytona-secrets'
daytona exec "$SANDBOX" -- "bash -lc 'set -a; source /daytona-secrets/openai.env; test -n \"${OPENAI_API_KEY:-}\"'"
```

Never run commands that print token values.

## Common Gotchas

- Updating the volume does not update a running Electron process. Restart
  Electron so `/daytona-secrets/*.env` is sourced again.
- Server sandboxes do not automatically use Electron provider secrets unless the
  server helper explicitly mounts and sources them.
- `test -n "$OPENAI_API_KEY"` is safe; `env`, `printenv`, or `cat` is not.
- Secrets in this volume are for evals only. Do not copy them into repo files or
  workspace config unless the flow is explicitly testing UI-based provider save.
