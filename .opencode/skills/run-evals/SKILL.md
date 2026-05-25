---
name: run-evals
description: Run OpenWork UI evals on a Daytona sandbox or local Electron instance. Handles sandbox creation, service startup, and eval execution via CDP browser tools.
---

# Skill: Run Evals

Run the OpenWork UI evaluation flows against a real Electron app. Prefer a fresh Daytona sandbox for each run, with a local test fallback when Daytona is unavailable.

## When to use

- User says "run evals on Daytona" or "run this flow on Daytona"
- User wants to verify a UI change end-to-end
- User wants to test the onboarding, session, or settings flows

## Prerequisites

- `daytona` CLI installed and logged in (`daytona login`)
- Using the "Different AI" org (`daytona organization use "Different AI"`)
- The `.devcontainer/` files exist in the repo
- Optional OpenAI coverage: reusable Daytona volume `openwork-eval-secrets`
  populated once with `bash .devcontainer/setup-daytona-secrets-volume.sh .newtoken`

## Workflow

### Preferred path: helper script

Use the repo helper unless you need to debug a specific Daytona step manually:

```bash
daytona organization use "Different AI"
bash .devcontainer/test-on-daytona.sh <branch-or-commit>
```

The helper creates a fresh VNC-capable Daytona sandbox from the reusable
`openwork-eval-vnc` snapshot when present, falls back to the VNC Dockerfile when
needed, mounts the reusable `openwork-eval-secrets:/daytona-secrets` volume,
mounts the reusable `openwork-eval-pnpm-store` pnpm cache volume, starts
XFCE/noVNC, Vite, and Electron with Daytona-safe graphics flags, waits for CDP,
then prints the CDP and noVNC URLs.

Refresh the snapshot when dependencies or base setup change:

```bash
bash .devcontainer/create-daytona-openwork-snapshot.sh
```

The snapshot intentionally excludes `node_modules` to stay below Daytona's 20 GB
snapshot limit. Dependency installs reuse the pnpm store volume.

For OpenAI/provider eval coverage, create/populate the volume once before the
first run:

```bash
bash .devcontainer/setup-daytona-secrets-volume.sh .newtoken
```

Do not print the key. Future eval sandboxes reuse the same volume.

### Verify helper output

Use the Electron CDP URL printed by `test-on-daytona.sh` with the browser tools:

```
browser_list({ browser_url: "<CDP_URL>" })
→ should show "OpenWork" page target
```

If `browser_list` fails, inspect `/tmp/electron.log`. The real CDP success
marker is Chromium's `DevTools listening on ws://127.0.0.1:9825/...`, not just
OpenWork's `Electron CDP exposed` line.

### Step 5: Create a workspace

If the app shows the Welcome page, create a workspace:

1. Create directory on sandbox:
   ```bash
   daytona exec "$SANDBOX" 'mkdir -p /workspace/hello'
   ```

2. Follow the workspace creation flow from `evals/daytona-flows.md` Flow 1:
   - Click "Get started" → "Local workspace"
   - Inject path via React fiber dispatch: `{ key: "selectedFolder", value: "/workspace/hello" }`
   - Click "Create Workspace"
   - Wait 10s for opencode sidecar to boot

### Step 6: Run the requested eval

Read the eval file from `evals/` and execute each step using the browser tools.

For each step:
1. Execute the `browser_evaluate` / `browser_click` / `browser_screenshot` call
2. Verify the expected outcome
3. Report pass/fail

### Key techniques

**Clicking buttons:**
```
browser_evaluate({ browser_url: URL, expression: "(function() { var btns = document.querySelectorAll('button'); for (var i = 0; i < btns.length; i++) { if (btns[i].textContent.indexOf('BUTTON_TEXT') !== -1) { btns[i].click(); return 'clicked'; } } return 'not found'; })()" })
```

**Typing in Lexical editors:**
```
browser_evaluate({ browser_url: URL, expression: "(function() { var e = document.querySelector('[contenteditable=true]'); e.focus(); document.execCommand('insertText', false, 'YOUR TEXT'); return 'typed'; })()" })
```

**Injecting folder path (bypass native picker):**
Use the `__reactFiber$` → `CreateWorkspaceModal` reducer dispatch with `{ key: "selectedFolder", value: "/path" }`. Full code in `evals/daytona-flows.md` Flow 1 Step 5.

**Checking page state:**
```
browser_evaluate({ browser_url: URL, expression: "document.body.innerText.substring(0, 500)" })
```

**Screenshots:**
```
browser_screenshot({ browser_url: URL })
```

### Local fallback

Always include a local fallback in the result. Use it when Daytona is down, quota-limited, or the sandbox cannot expose CDP. At minimum, run the closest local verification commands and report that the Daytona path was unavailable.

```bash
pnpm install
pnpm --filter @openwork/app typecheck
pnpm --filter @openwork/app build
```

For UI flow verification, start the local app and attach browser tools to the local Electron CDP endpoint, then run the same eval steps from `evals/`.

```bash
pnpm dev
```

Report clearly whether the result came from Daytona or the local fallback.

### Teardown

```bash
daytona delete "$SANDBOX"
```
