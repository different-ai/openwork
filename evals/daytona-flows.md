# Daytona sandbox flows

End-to-end scenarios that run against a real Electron OpenWork instance in a
Daytona cloud sandbox. The agent drives the app through CDP browser tools
(`browser_list`, `browser_evaluate`, `browser_screenshot`, etc.) over the
Daytona proxy.

## Preflight

### 1. Create the sandbox

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

### 2. Start services

```bash
daytona exec openwork-test 'bash /workspace/.devcontainer/start-services.sh'
```

Wait ~30s for Xvfb + Vite + Electron + opencode sidecar to boot.

### 3. Get the CDP proxy URL

```bash
daytona preview-url openwork-test -p 9825
```

This returns something like `https://9825-xxx.daytonaproxy01.net`.

### 4. Verify connectivity

Use the `browser_list` tool:

```
browser_list({ browser_url: "https://9825-xxx.daytonaproxy01.net" })
```

Should return the OpenWork page target.

### 5. Verify opencode sidecar

```bash
daytona exec openwork-test 'ps aux | grep opencode | grep -v grep'
```

If no opencode process, the workspace hasn't been created yet (expected on fresh sandbox).

---

## Flow 1: Create a local workspace

**Goal:** Create a workspace named "hello" from the Welcome page.

### Steps

1. Create the workspace directory on the sandbox:
   ```bash
   daytona exec openwork-test 'mkdir -p /workspace/hello'
   ```

2. Verify we're on the Welcome page:
   ```
   browser_evaluate({ browser_url: CDP_URL, expression: "window.location.hash" })
   → "#/welcome"
   ```

3. Click "Get started" to expand options:
   ```
   browser_evaluate({ browser_url: CDP_URL, expression: "(function() { var btns = document.querySelectorAll('button'); for (var i = 0; i < btns.length; i++) { if (btns[i].textContent.indexOf('Get started') !== -1) { btns[i].click(); return 'clicked'; } } return 'not found'; })()" })
   ```

4. Click "Local workspace":
   ```
   browser_evaluate({ browser_url: CDP_URL, expression: "(function() { var btns = document.querySelectorAll('button'); for (var i = 0; i < btns.length; i++) { if (btns[i].textContent.indexOf('Local workspace') !== -1) { btns[i].click(); return 'clicked'; } } return 'not found'; })()" })
   ```

5. Wait 2s, then inject the folder path into the CreateWorkspaceModal React reducer:
   ```
   browser_evaluate({ browser_url: CDP_URL, expression: "JSON.stringify((function() { function findFiber(el) { var key = Object.keys(el).find(function(k) { return k.startsWith('__reactFiber$'); }); return key ? el[key] : null; } var spans = document.querySelectorAll('span'); var p = null; for (var i = 0; i < spans.length; i++) { if (spans[i].textContent.indexOf('No folder') !== -1) { p = spans[i]; break; } } if (!p) return {err: 'no placeholder'}; var fiber = findFiber(p); while (fiber) { var name = (fiber.elementType && fiber.elementType.name) || (fiber.type && fiber.type.name) || ''; if (name === 'CreateWorkspaceModal') break; fiber = fiber.return; } if (!fiber) return {err: 'no fiber'}; var hook = fiber.memoizedState; while (hook) { if (hook.queue && hook.queue.dispatch) { hook.queue.dispatch({ key: 'selectedFolder', value: '/workspace/hello' }); hook.queue.dispatch({ key: 'pickingFolder', value: false }); return {ok: true}; } hook = hook.next; } return {err: 'no dispatch'}; })())" })
   ```

   **Key:** The reducer uses `{ key, value }` action format, NOT direct state replacement.

6. Verify "Create Workspace" is enabled (not disabled):
   ```
   browser_evaluate({ browser_url: CDP_URL, expression: "(function() { var btns = document.querySelectorAll('button'); for (var i = 0; i < btns.length; i++) { if (btns[i].textContent.trim() === 'Create Workspace') return btns[i].disabled ? 'DISABLED' : 'ENABLED'; } return 'not found'; })()" })
   → "ENABLED"
   ```

7. Click "Create Workspace":
   ```
   browser_evaluate({ browser_url: CDP_URL, expression: "(function() { var btns = document.querySelectorAll('button'); for (var i = 0; i < btns.length; i++) { if (btns[i].textContent.trim() === 'Create Workspace' && !btns[i].disabled) { btns[i].click(); return 'clicked'; } } return 'not found'; })()" })
   ```

8. Wait 10s for workspace creation + opencode sidecar boot.

9. Verify navigation to session page:
   ```
   browser_evaluate({ browser_url: CDP_URL, expression: "window.location.hash" })
   → should contain "/session"
   ```

10. Verify opencode sidecar started:
    ```bash
    daytona exec openwork-test 'ps aux | grep opencode | grep -v grep'
    → should show opencode serve process
    ```

### Expected outcome
- URL contains `#/workspace/ws_.../session`
- Sidebar shows "hello" workspace
- Status bar shows "OpenWork Ready"
- opencode process running on a random port

---

## Flow 2: Send a message in a session

**Prerequisite:** Flow 1 completed (workspace exists, opencode running).

### Steps

1. Click a starter card to create a session:
   ```
   browser_evaluate({ browser_url: CDP_URL, expression: "(function() { var btns = document.querySelectorAll('button'); for (var i = 0; i < btns.length; i++) { if (btns[i].textContent.indexOf('Edit a CSV') !== -1) { btns[i].click(); return 'clicked'; } } return 'not found'; })()" })
   ```

2. Wait 5s for session creation.

3. Verify session URL:
   ```
   browser_evaluate({ browser_url: CDP_URL, expression: "window.location.hash" })
   → should contain "/session/ses_"
   ```

4. Focus the composer and type a message:
   ```
   browser_evaluate({ browser_url: CDP_URL, expression: "(function() { var editor = document.querySelector('[contenteditable=true]'); if (!editor) return 'no editor'; editor.focus(); document.execCommand('selectAll', false, null); document.execCommand('insertText', false, 'Hello from Daytona! List the files in the current directory.'); return 'typed'; })()" })
   ```

   **Key:** Use `document.execCommand('insertText', ...)` for Lexical editors, NOT `textContent =` or `innerHTML =`.

5. Click "Run task":
   ```
   browser_evaluate({ browser_url: CDP_URL, expression: "(function() { var btns = document.querySelectorAll('button'); for (var i = 0; i < btns.length; i++) { if (btns[i].textContent.indexOf('Run task') !== -1 && !btns[i].disabled) { btns[i].click(); return 'clicked'; } } return 'not found'; })()" })
   ```

6. Wait 15s for LLM response.

7. Verify agent response appeared:
   ```
   browser_evaluate({ browser_url: CDP_URL, expression: "document.body.innerText.substring(0, 500)" })
   → should contain the agent's response about directory contents
   ```

### Expected outcome
- Session title auto-generated in sidebar
- Agent response visible in the chat
- No errors in console

---

## Flow 3: Take a screenshot

```
browser_screenshot({ browser_url: CDP_URL })
```

Returns path to a PNG file. Verify it's not empty.

---

## Teardown

```bash
daytona stop openwork-test    # preserves state
daytona delete openwork-test  # destroys everything
```

---

## Troubleshooting

**"Create Workspace" stays disabled after path injection:**
The reducer uses `{ key, value }` actions. If you dispatched a full state object, it won't work.

**Lexical editor doesn't accept text:**
Use `document.execCommand('insertText', false, text)` after focusing. Direct `textContent` assignment doesn't trigger Lexical's internal state update.

**opencode sidecar not starting:**
Check memory. Electron + opencode + Vite needs ~6GB. Use `--memory 8`.

**CDP timeouts:**
The renderer might be frozen (e.g., a blocking IPC call). Restart Electron:
```bash
daytona exec openwork-test 'pkill -f electron; sleep 3; DISPLAY=:99 ELECTRON_DISABLE_SANDBOX=1 OPENWORK_ELECTRON_REMOTE_DEBUG_PORT=9825 OPENWORK_DEV_MODE=1 ELECTRON_EXTRA_LAUNCH_ARGS="--disable-gpu" nohup pnpm --filter @openwork/desktop dev:electron > /tmp/electron.log 2>&1 &'
```
