---
name: run-evals
description: do e2e tests, run e2e, validate feature, prove it works, PR proof, frame proof, pnpm evals. Launches OpenWork on Daytona or local Electron and runs the coded eval flows via CDP. Launch + run mechanics; the proof loop itself is the fraimz skill.
---

# Skill: Run Evals

Launch a real OpenWork app and run coded eval flows against it. This skill owns
**launch + run**; the prove/repair/verdict loop and evidence standard live in
the **`fraimz` skill** — load that too for anything that ends in a verdict.
`pnpm evals` runs automation mode; use `pnpm fraimz` for demo/voiceover mode.

## Prerequisites

- `daytona` CLI installed and logged in (`daytona login`), right org selected
  (`daytona organization use "<org-name>"`)
- `.devcontainer/` files present in the repo
- Optional provider coverage: reusable secrets volume populated once with
  `bash .devcontainer/setup-daytona-secrets-volume.sh .newtoken` (never print
  keys; sandboxes source every `/daytona-secrets/*.env` before Electron starts)

## Preferred path: Daytona sandbox

```bash
daytona organization use "<org-name>"
bash .devcontainer/test-on-daytona.sh <branch-or-commit> --artifacts-volume
```

The helper creates a fresh VNC-capable sandbox from the `openwork-eval-vnc`
snapshot, mounts the secrets + pnpm-store volumes, starts XFCE/noVNC, Vite, and
Electron with Daytona-safe flags, waits for CDP, then prints the CDP and noVNC
URLs. `--artifacts-volume` mounts `/daytona-artifacts` served on port 8090 for
published frame proof. Refresh the snapshot when dependencies change:
`bash .devcontainer/create-daytona-openwork-snapshot.sh`.

Verify the endpoint before running flows:

```
browser_list({ browser_url: "<CDP_URL>" })   # must show an "OpenWork" target
```

If it fails, inspect `/tmp/electron.log` — the real success marker is
Chromium's `DevTools listening on ws://127.0.0.1:9825/...`.

If the app shows the Welcome page, create a workspace first (see
`evals/daytona-flows.md` Flow 1: create `/workspace/hello` on the sandbox,
"Get started" → "Local workspace" → inject the path → "Create Workspace").

## Run the flows

```bash
pnpm evals --list
pnpm evals --flow <flow-id> --cdp-url <printed-electron-cdp-url>
pnpm evals --all --stack den     # brings up MySQL + den-api + seed for cloud flows
```

The runner produces machine-checkable assertions, validated screenshots, and
writes `fraimz.html` + `report.md` / `report.json` under
`evals/results/<run-id>/`. If no coded flow exists for the behavior, add one in
`evals/flows/<id>.flow.mjs` (see the `fraimz` skill and `evals/README.md` for
the `ctx.*` API); use manual browser tools only to debug or prototype — a coded
flow is the PR evidence.

## Recording (motion only)

Frame proof is the default deliverable; record video only when motion matters
(streaming, animations). Start with
`bash .devcontainer/test-on-daytona.sh <branch> --record-video --recording-name <name>`,
stop with `daytona exec "$SANDBOX" -- 'bash .devcontainer/stop-daytona-recording.sh'`,
download via the port-8090 artifacts URL. Details: `daytona-recording-artifacts`.

## Local fallback

When Daytona is down or quota-limited:

```bash
pnpm install
pnpm --filter @openwork/app typecheck
OPENWORK_ELECTRON_REMOTE_DEBUG_PORT=9826 pnpm dev   # then:
pnpm evals --flow <flow-id> --cdp-url http://127.0.0.1:9826
```

Report clearly whether the result came from Daytona or the local fallback — a
local run is not a Daytona validation.

## Teardown

```bash
daytona delete "$SANDBOX"
```
