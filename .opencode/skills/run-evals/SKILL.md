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
- Using the right Daytona organization for your workspace (`daytona organization use "<org-name>"`)
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

### Preferred path: helper script + coded eval runner

Use the repo helper unless you need to debug a specific Daytona step manually:

```bash
daytona organization use "<org-name>"
bash .devcontainer/test-on-daytona.sh <branch-or-commit> --artifacts-volume
```

The helper creates a fresh VNC-capable Daytona sandbox from the reusable
`openwork-eval-vnc` snapshot, mounts the reusable
`openwork-eval-secrets:/daytona-secrets` volume, mounts the reusable
`openwork-eval-pnpm-store` pnpm cache volume, starts XFCE/noVNC, Vite, and
Electron with Daytona-safe graphics flags, waits for CDP, then prints the CDP
and noVNC URLs. `--artifacts-volume` mounts `/daytona-artifacts` and serves it
on port 8090 so UI validation can publish frame proof. If the snapshot is
missing, create it before rerunning.

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

Prefer coded flows under `evals/flows/` and run them through the eval runner:

```bash
pnpm evals --list
pnpm evals --flow <flow-id> --cdp-url <printed-electron-cdp-url>
```

The runner uses CDP directly, produces machine-checkable assertions, and writes
`report.json`, `report.md`, screenshots, and a browseable `index.html` frame
proof under `evals/results/<run-id>/`.

If no coded flow exists yet for the UI behavior under test, add or adapt a
`evals/flows/*.flow.mjs` file and use the runner helpers:

- `ctx.clickText("Button label")`
- `ctx.fill("input-or-textarea-selector", "value")`
- `ctx.waitFor("JavaScript condition")`
- `ctx.waitForText("Visible text")`
- `ctx.control("action.id", args)`
- `ctx.screenshot("checkpoint-name")`

Use manual browser tools only to debug/prototype a flow or when product UI
cannot expose the needed state yet. Do not report ad hoc browser calls as the
preferred PR evidence when a coded flow can be created.

When manually replaying a markdown-only eval, execute each step using the
browser tools and convert the flow to `evals/flows/` if it becomes repeated PR
coverage.

For each step:
1. Observe the current state with `browser_snapshot` or `browser_eval`.
2. Execute the `browser_eval`, `browser_click`, `browser_fill`, or screenshot call.
3. Observe again.
4. Assert the expected URL, text, state, process, log, or API result.
5. Capture screenshot/recording evidence when the visible state matters.

Use the `daytona-flow-validator` skill for pass/fail decisions. If there is no
post-action assertion, report `Incomplete`, not `Passed`.

### Manual browser-tool fallback techniques

Use these only when debugging, prototyping a flow, or bridging a product gap.
For repeatable UI proof, prefer `pnpm evals` and `ctx.*` helpers above.

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
