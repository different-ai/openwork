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
