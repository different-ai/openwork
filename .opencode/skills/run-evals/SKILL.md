---
name: run-evals
description: Run OpenWork UI evals on a Daytona sandbox or local Electron instance. Handles sandbox creation, service startup, and eval execution via CDP browser tools.
---

# Skill: Run Evals

Run the OpenWork UI evaluation flows against a real Electron app — either on a Daytona cloud sandbox or a local instance.

## When to use

- User says "run evals on Daytona" or "run this flow on Daytona"
- User wants to verify a UI change end-to-end
- User wants to test the onboarding, session, or settings flows

## Prerequisites

- `daytona` CLI installed and logged in (`daytona login`)
- Using the "Different AI" org (`daytona organization use "Different AI"`)
- The `.devcontainer/` files exist in the repo

## Workflow

### Step 1: Create sandbox (if not running)

Check for existing sandbox first:

```bash
daytona list
```

If no `openwork-test` sandbox, create one:

```bash
daytona create \
  --name openwork-test \
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

### Step 2: Start services

```bash
daytona exec openwork-test 'bash /workspace/.devcontainer/start-services.sh'
```

Wait for it to start (this runs in background, may timeout — that's OK).

### Step 3: Verify

```bash
# Get CDP URL
daytona preview-url openwork-test -p 9825
```

Then use the browser tools to verify:

```
browser_list({ browser_url: "<CDP_URL>" })
→ should show "OpenWork" page target
```

### Step 4: Create a workspace (if on welcome page)

If the app shows the Welcome page, create a workspace:

1. Create directory on sandbox:
   ```bash
   daytona exec openwork-test 'mkdir -p /workspace/hello'
   ```

2. Follow the workspace creation flow from `evals/daytona-flows.md` Flow 1:
   - Click "Get started" → "Local workspace"
   - Inject path via React fiber dispatch: `{ key: "selectedFolder", value: "/workspace/hello" }`
   - Click "Create Workspace"
   - Wait 10s for opencode sidecar to boot

### Step 5: Run the requested eval

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

### Teardown

```bash
daytona stop openwork-test    # preserves state for re-runs
daytona delete openwork-test  # full cleanup
```
