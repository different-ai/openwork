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

## Workflow

### Step 1: Create sandbox

Create a new Daytona sandbox for each eval run. Avoid reusing old sandboxes unless the user explicitly asks to debug existing state.

Before creating the sandbox, explicitly point Daytona at the Different AI org:

```bash
daytona organization use "Different AI"
```

Pick a unique name:

```bash
SANDBOX="openwork-eval-$(date +%Y%m%d-%H%M%S)"
```

Create it from the repo devcontainer:

```bash
daytona create \
  --name "$SANDBOX" \
  --dockerfile .devcontainer/Dockerfile \
  --context .devcontainer/Dockerfile \
  --context .devcontainer/start-display.sh \
  --context .devcontainer/start-services.sh \
  --class large \
  --memory 8 \
  --auto-stop 60 \
  --public \
  --target us
```

If Daytona is unavailable, skip to the local fallback and still run the closest possible test.

### Step 2: Prepare repo

Use a clean checkout inside the sandbox. The devcontainer Dockerfile normally clones the repo into `/workspace`; if that is missing, clone it there. Then fetch and check out the branch or commit under test.

```bash
daytona exec "$SANDBOX" 'test -d /workspace/.git || git clone https://github.com/different-ai/openwork.git /workspace'
daytona exec "$SANDBOX" 'git -C /workspace fetch --all --prune && git -C /workspace checkout <branch-or-commit> && git -C /workspace pull --ff-only || true'
```

Install dependencies before starting services:

```bash
daytona exec "$SANDBOX" 'cd /workspace && pnpm install'
```

### Step 3: Start services

```bash
daytona exec "$SANDBOX" 'cd /workspace && bash .devcontainer/start-services.sh'
```

Wait for it to start (this runs in background, may timeout — that's OK).

### Step 4: Verify

```bash
# Get CDP URL
daytona preview-url "$SANDBOX" -p 9825
```

Then use the browser tools to verify:

```
browser_list({ browser_url: "<CDP_URL>" })
→ should show "OpenWork" page target
```

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

For UI flow verification, start the local app and attach browser tools to the local Electron or Chrome DevTools endpoint, then run the same eval steps from `evals/`.

```bash
pnpm dev
```

Report clearly whether the result came from Daytona or the local fallback.

### Teardown

```bash
daytona delete "$SANDBOX"
```
