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
- Optional provider coverage: reusable Daytona volume `openwork-eval-secrets`
  populated with `.env` files using `bash .devcontainer/setup-daytona-secrets-volume.sh .newtoken`

## Workflow

Use these Daytona skills when an eval touches a specific area:

- `daytona-electron-test` for launching and driving the real Electron app.
- `daytona-flow-validator` for the observe -> act -> observe/assert -> evidence loop.
- `daytona-cloud-server` for Den server sandbox startup and health checks.
- `daytona-electron-den` for two-sandbox Electron + Den cloud flows.
- `daytona-chrome-cdp` for standalone Chrome in Daytona, separate from Electron.
- `daytona-secrets-volume` for adding or checking provider keys and eval secrets.
- `daytona-recording-artifacts` for screenshots, recordings, before/after videos, and PR evidence.

### Preferred path: helper script

Use the repo helper unless you need to debug a specific Daytona step manually:

```bash
daytona organization use "Different AI"
bash .devcontainer/test-on-daytona.sh <branch-or-commit>
```

The helper creates a fresh VNC-capable Daytona sandbox from the reusable
`openwork-eval-vnc` snapshot, mounts the reusable
`openwork-eval-secrets:/daytona-secrets` volume, mounts the reusable
`openwork-eval-pnpm-store` pnpm cache volume, starts XFCE/noVNC, Vite, and
Electron with Daytona-safe graphics flags, waits for CDP, then prints the CDP
and noVNC URLs. If the snapshot is missing, create it before rerunning.

Refresh the snapshot when dependencies or base setup change:

```bash
bash .devcontainer/create-daytona-openwork-snapshot.sh
```

The snapshot intentionally excludes `node_modules` to stay below Daytona's 20 GB
snapshot limit. Dependency installs reuse the pnpm store volume.

For provider eval coverage, create/populate the volume once before the
first run:

```bash
bash .devcontainer/setup-daytona-secrets-volume.sh .newtoken
bash .devcontainer/setup-daytona-secrets-volume.sh .anthropic anthropic.env
```

Do not print keys. Future eval sandboxes reuse the same volume and source every
`/daytona-secrets/*.env` file before Electron starts.

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
1. Observe the current state with `browser_snapshot` or `browser_eval`.
2. Execute the `browser_eval`, `browser_click`, `browser_fill`, or screenshot call.
3. Observe again.
4. Assert the expected URL, text, state, process, log, or API result.
5. Capture screenshot/recording evidence when the visible state matters.

Use the `daytona-flow-validator` skill for pass/fail decisions. If there is no
post-action assertion, report `Incomplete`, not `Passed`.

### Key techniques

**Clicking buttons:**
```
browser_eval({ browser_url: URL, expression: "(function() { var btns = document.querySelectorAll('button'); for (var i = 0; i < btns.length; i++) { if (btns[i].textContent.indexOf('BUTTON_TEXT') !== -1) { btns[i].click(); return 'clicked'; } } return 'not found'; })()" })
```

**Typing in Lexical editors:**
```
browser_eval({ browser_url: URL, expression: "(function() { var e = document.querySelector('[contenteditable=true]'); e.focus(); var d = new DataTransfer(); d.setData('text/plain', 'YOUR TEXT'); e.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: d })); return e.innerText; })()" })
```

**Injecting folder path (bypass native picker):**
Use the `__reactFiber$` → `CreateWorkspaceModal` reducer dispatch with `{ key: "selectedFolder", value: "/path" }`. Full code in `evals/daytona-flows.md` Flow 1 Step 5.

**Checking page state:**
```
browser_eval({ browser_url: URL, expression: "document.body.innerText.substring(0, 500)" })
```

**Screenshots:**
```
browser_screenshot({ browser_url: URL })
```

Also capture persistent Daytona screenshots at critical checkpoints when the
artifacts volume is mounted:

```bash
daytona exec "$SANDBOX" -- 'bash .devcontainer/capture-daytona-screenshot.sh'
```

Use browser snapshots/assertions for AI validation, screenshots for visual
checkpoints, and recordings for human PR evidence.

### Recording eval runs

Record eval runs when the user asks for PR evidence or the change is visual.
Use the built-in Daytona recording mechanism:

**Start with recording from the beginning:**
```bash
bash .devcontainer/test-on-daytona.sh <branch> --record-video --recording-name <eval-name>
```

**Start a new recording mid-sandbox** (e.g. after switching branches):
```bash
daytona exec "$SANDBOX" -- "bash -lc 'cd /workspace && DISPLAY=:99 .devcontainer/start-daytona-recording.sh --detach --output /daytona-artifacts/recordings/<name>.mp4'"
```

**Stop recording:**
```bash
daytona exec "$SANDBOX" -- 'bash .devcontainer/stop-daytona-recording.sh'
```

**Get the download URL:**
```bash
ARTIFACTS_URL=$(daytona preview-url "$SANDBOX" -p 8090 2>/dev/null | grep -v "^time=")
echo "${ARTIFACTS_URL}/recordings/<name>.mp4"
```

Recordings are saved to the persistent `openwork-eval-artifacts` volume and
survive sandbox deletion. Always use `stop-daytona-recording.sh` (not
`kill -9`) so ffmpeg finalizes the mp4 properly.

Screenshots are saved to `/daytona-artifacts/screenshots` and are served by the
same port 8090 artifacts URL.

For before/after comparison recordings, see the "Recording before/after
comparisons" section in the `daytona-electron-test` skill.

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

Report clearly whether the result came from Daytona or the local fallback. A
local fallback cannot be reported as a successful Daytona validation.

### Teardown

```bash
daytona delete "$SANDBOX"
```
