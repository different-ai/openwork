# Daytona sandbox flows

End-to-end scenarios that run against a real Electron OpenWork instance in a
Daytona cloud sandbox. The agent drives the app through CDP browser tools
(`browser_list`, `browser_eval`, `browser_screenshot`, etc.) over the
Daytona proxy.

## Preflight

### 1. Create/start the sandbox

```bash
daytona organization use "<org-name>"
bash .devcontainer/test-on-daytona.sh [branch-or-commit] --artifacts-volume
```

Use the helper. It creates from the reusable `openwork-eval-vnc` snapshot,
mounts secrets, mounts the reusable pnpm store volume, checks out the requested
ref, conditionally installs deps, starts services, waits for CDP, and prints the
CDP/noVNC URLs. Keep `--artifacts-volume` on for UI validation so frame proof can
be served from port 8090. If the snapshot is missing, create it with
`bash .devcontainer/create-daytona-openwork-snapshot.sh`.

The reusable `openwork-eval-secrets` volume is mounted at `/daytona-secrets`.
Create/populate it with `bash .devcontainer/setup-daytona-secrets-volume.sh
.newtoken`; future eval sandboxes reuse it and source every
`/daytona-secrets/*.env` file before Electron starts. The Electron starter also
applies Daytona-safe Chromium flags via `ELECTRON_EXTRA_LAUNCH_ARGS`.

To persist downloadable artifacts, pass `--artifacts-volume`. The helper mounts
the reusable `openwork-eval-artifacts` volume at `/daytona-artifacts`, starts a
static download server, and prints its Daytona preview URL. Capture screenshot
checkpoints with `daytona exec <sandbox> -- 'bash .devcontainer/capture-daytona-screenshot.sh'`.

For repeatable PR evidence, prefer coded flows under `evals/flows/`:

```bash
pnpm evals --list
pnpm evals --flow <flow-id> --cdp-url <printed-electron-cdp-url>
```

The runner writes `evals/results/<run-id>/report.md` and a frame-by-frame
`index.html` with screenshots captured by `ctx.screenshot(...)`. Use the manual
CDP snippets below for debugging or for flows that have not been codified yet.

To record the Electron display, pass `--record-video`:

```bash
bash .devcontainer/test-on-daytona.sh [branch-or-commit] --record-video
```

`--record-video` implies `--artifacts-volume` and writes an mp4 under
`/daytona-artifacts/recordings`. The helper prints the direct recording URL and
the stop command:

```bash
daytona exec <sandbox> -- 'bash .devcontainer/stop-daytona-recording.sh'
```

The stop helper sends `SIGINT` so ffmpeg finalizes the mp4 cleanly before
downloading it. Optional recording controls are `--recording-name <name>`,
`--recording-fps <fps>`, and `--recording-size <WxH>`.

### 2. Get the CDP proxy URL

Use the Electron CDP URL printed by `test-on-daytona.sh`. It looks like
`https://9825-xxx.daytonaproxy01.net`.

### 3. Verify connectivity

Use the `browser_list` tool:

```
browser_list({ browser_url: "https://9825-xxx.daytonaproxy01.net" })
```

Should return the OpenWork page target.

### 4. Verify opencode sidecar

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
   browser_eval({ browser_url: CDP_URL, expression: "window.location.hash" })
   → "#/welcome"
   ```

3. Click "Get started" to expand options:
   ```
   browser_eval({ browser_url: CDP_URL, expression: "(function() { var btns = document.querySelectorAll('button'); for (var i = 0; i < btns.length; i++) { if (btns[i].textContent.indexOf('Get started') !== -1) { btns[i].click(); return 'clicked'; } } return 'not found'; })()" })
   ```

4. Click "Local workspace":
   ```
   browser_eval({ browser_url: CDP_URL, expression: "(function() { var btns = document.querySelectorAll('button'); for (var i = 0; i < btns.length; i++) { if (btns[i].textContent.indexOf('Local workspace') !== -1) { btns[i].click(); return 'clicked'; } } return 'not found'; })()" })
   ```

5. Wait 2s, then inject the folder path into the CreateWorkspaceModal React reducer:
   ```
   browser_eval({ browser_url: CDP_URL, expression: "JSON.stringify((function() { function findFiber(el) { var key = Object.keys(el).find(function(k) { return k.startsWith('__reactFiber$'); }); return key ? el[key] : null; } var spans = document.querySelectorAll('span'); var p = null; for (var i = 0; i < spans.length; i++) { if (spans[i].textContent.indexOf('No folder') !== -1) { p = spans[i]; break; } } if (!p) return {err: 'no placeholder'}; var fiber = findFiber(p); while (fiber) { var name = (fiber.elementType && fiber.elementType.name) || (fiber.type && fiber.type.name) || ''; if (name === 'CreateWorkspaceModal') break; fiber = fiber.return; } if (!fiber) return {err: 'no fiber'}; var hook = fiber.memoizedState; while (hook) { if (hook.queue && hook.queue.dispatch) { hook.queue.dispatch({ key: 'selectedFolder', value: '/workspace/hello' }); hook.queue.dispatch({ key: 'pickingFolder', value: false }); return {ok: true}; } hook = hook.next; } return {err: 'no dispatch'}; })())" })
   ```

   **Key:** The reducer uses `{ key, value }` action format, NOT direct state replacement.

6. Verify "Create Workspace" is enabled (not disabled):
   ```
   browser_eval({ browser_url: CDP_URL, expression: "(function() { var btns = document.querySelectorAll('button'); for (var i = 0; i < btns.length; i++) { if (btns[i].textContent.trim() === 'Create Workspace') return btns[i].disabled ? 'DISABLED' : 'ENABLED'; } return 'not found'; })()" })
   → "ENABLED"
   ```

7. Click "Create Workspace":
   ```
   browser_eval({ browser_url: CDP_URL, expression: "(function() { var btns = document.querySelectorAll('button'); for (var i = 0; i < btns.length; i++) { if (btns[i].textContent.trim() === 'Create Workspace' && !btns[i].disabled) { btns[i].click(); return 'clicked'; } } return 'not found'; })()" })
   ```

8. Wait 10s for workspace creation + opencode sidecar boot.

9. Verify navigation to session page:
   ```
   browser_eval({ browser_url: CDP_URL, expression: "window.location.hash" })
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
   browser_eval({ browser_url: CDP_URL, expression: "(function() { var btns = document.querySelectorAll('button'); for (var i = 0; i < btns.length; i++) { if (btns[i].textContent.indexOf('Edit a CSV') !== -1) { btns[i].click(); return 'clicked'; } } return 'not found'; })()" })
   ```

2. Wait 5s for session creation.

3. Verify session URL:
   ```
   browser_eval({ browser_url: CDP_URL, expression: "window.location.hash" })
   → should contain "/session/ses_"
   ```

4. Focus the composer and type a message:
   ```
   browser_eval({ browser_url: CDP_URL, expression: "(function() { var editor = document.querySelector('[contenteditable=true]'); if (!editor) return 'no editor'; editor.focus(); document.execCommand('selectAll', false, null); document.execCommand('insertText', false, 'Hello from Daytona! List the files in the current directory.'); return 'typed'; })()" })
   ```

   **Key:** Use `document.execCommand('insertText', ...)` for Lexical editors, NOT `textContent =` or `innerHTML =`.

5. Click "Run task":
   ```
   browser_eval({ browser_url: CDP_URL, expression: "(function() { var btns = document.querySelectorAll('button'); for (var i = 0; i < btns.length; i++) { if (btns[i].textContent.indexOf('Run task') !== -1 && !btns[i].disabled) { btns[i].click(); return 'clicked'; } } return 'not found'; })()" })
   ```

6. Wait 15s for LLM response.

7. Verify agent response appeared:
   ```
   browser_eval({ browser_url: CDP_URL, expression: "document.body.innerText.substring(0, 500)" })
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

## Flow 4: Connect OpenAI via UI and run GPT-5.5

**Goal:** Prove provider key setup works through the Electron UI, not by editing
`opencode.jsonc` directly.

### Source references for controls

Use these files to choose stable selectors before guessing DOM structure:

| UI control | Preferred selector | Source file |
|---|---|---|
| Settings button | `button[aria-label="Settings"]` | `apps/app/src/react-app/domains/session/chat/status-bar.tsx` |
| AI Providers tab | button text `AI Providers` | `apps/app/src/react-app/domains/settings/shell/settings-page.tsx`, `settings-route.tsx` |
| Connect provider | button text `Connect provider` | `apps/app/src/react-app/domains/settings/pages/ai-view.tsx` |
| Provider search | `input[placeholder="Filter providers by name or ID"]` | `apps/app/src/react-app/domains/connections/provider-auth/provider-auth-modal.tsx` |
| OpenAI provider row | button containing `OpenAI` and `openai` | `provider-auth-modal.tsx` |
| Manual key method | button containing `Manually enter API Key` | `provider-auth-modal.tsx` |
| API key input | `input[type="password"][placeholder="sk-..."]` | `provider-auth-modal.tsx` |
| Save key | button text `Save key` | `provider-auth-modal.tsx` |
| New task/session | `button[aria-label="New task"]` | `apps/app/src/react-app/domains/session/sidebar/app-sidebar.tsx` |
| Composer | `[contenteditable="true"][data-lexical-editor="true"]` | `apps/app/src/react-app/domains/session/surface/composer/editor.tsx` and `composer.tsx` |
| Run task | button text `Run task` | `apps/app/src/react-app/domains/session/surface/composer/composer.tsx` |
| Model selector | `button[aria-label="Change model"]` | `composer.tsx` |
| Model picker rows | button text containing model display name/id | model picker rendered from session route state |

### Selector helpers

Prefer text and ARIA selectors over React internals. Use React fiber only for
native file-picker state injection during workspace creation.

Click by exact text:

```js
(function clickText(text) {
  var el = Array.from(document.querySelectorAll('button')).find(function (node) {
    return node.textContent.trim() === text && !node.disabled;
  });
  if (!el) return 'not found: ' + text;
  el.click();
  return 'clicked: ' + text;
})('AI Providers')
```

Click by ARIA label:

```js
(function clickAria(label) {
  var el = Array.from(document.querySelectorAll('button,a')).find(function (node) {
    return node.getAttribute('aria-label') === label && !node.disabled;
  });
  if (!el) return 'not found: ' + label;
  el.click();
  return 'clicked: ' + label;
})('Settings')
```

Set React-controlled inputs:

```js
(function setInput(selector, value) {
  var input = document.querySelector(selector);
  if (!input) return 'not found: ' + selector;
  var setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
  setter.call(input, value);
  input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: value }));
  return 'set: ' + selector;
})('input[placeholder="Filter providers by name or ID"]', 'openai')
```

Paste into the Lexical composer:

```js
(function pasteComposer(text) {
  var editor = document.querySelector('[contenteditable="true"][data-lexical-editor="true"]');
  if (!editor) return 'no editor';
  editor.focus();
  var data = new DataTransfer();
  data.setData('text/plain', text);
  editor.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: data }));
  return editor.innerText;
})('Reply with exactly: Daytona UI key OK')
```

`document.execCommand('insertText')` may no-op in Electron/CDP for this Lexical
editor. The synthetic paste event is the reliable path.

### Steps

1. Create a workspace using Flow 1.

2. Open Settings:
   ```js
   (function(){var el=Array.from(document.querySelectorAll('button,a')).find(function(n){return n.getAttribute('aria-label')==='Settings'}); if(!el)return 'not found'; el.click(); return 'clicked';})()
   ```

3. Open AI Providers:
   ```js
   (function(){var b=Array.from(document.querySelectorAll('button')).find(function(n){return n.textContent.trim()==='AI Providers'}); if(!b)return 'not found'; b.click(); return 'clicked';})()
   ```

4. Click `Connect provider`.

5. Search for `openai` using `input[placeholder="Filter providers by name or ID"]`.

6. Click the provider row containing `OpenAI`, then click `Manually enter API Key`.

7. Fill the password input and click `Save key`:
   ```js
   (function(key){
     var input=document.querySelector('input[type="password"][placeholder="sk-..."]');
     if(!input)return 'no key input';
     Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,key);
     input.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText',data:key}));
     var save=Array.from(document.querySelectorAll('button')).find(function(b){return b.textContent.trim()==='Save key' && !b.disabled});
     if(!save)return 'save disabled';
     save.click();
     return 'submitted';
   })('sk-...')
   ```

8. Verify AI Providers shows OpenAI as connected. Expected text includes:
   `2 providers connected`, `OpenAI`, and `Disconnect`.

9. Click `Pick a new default?`, open `OpenAI`, select `Default model`, then click
   `GPT-5.5gpt-5.5`. The composer should show `GPT-5.5`.

10. Click `Back to app`, then `button[aria-label="New task"]`.

11. Paste into the composer using the `pasteComposer` helper and click `Run task`.

12. Verify the response contains `Daytona UI key OK` and session messages show
    `providerID: openai`, `modelID: gpt-5.5`, `variant: medium`.

### Expected outcome

- OpenAI appears as a connected provider in Settings.
- The model selector shows `GPT-5.5`.
- The session assistant response is successful, not `ProviderAuthError`.
- No API key is committed or written into repo docs.

---

## Flow 5: Add a custom OAuth MCP app

**Goal:** Prove a newly added OAuth MCP does not get stuck on
`Applying changes before sign-in`, opens the OAuth authorization URL after the
worker reload, completes the callback, and appears as `Ready`.

### Source references for controls

| UI control | Preferred selector | Source file |
|---|---|---|
| Settings button | `button[aria-label="Settings"]` | `apps/app/src/react-app/domains/session/chat/status-bar.tsx` |
| Extensions tab | button text `Extensions` | `apps/app/src/react-app/shell/settings-route.tsx` |
| Add custom MCP | button text `Add Custom App` | `apps/app/src/react-app/domains/settings/pages/mcp-view.tsx` |
| Server name input | `input[placeholder="github-copilot"]` | `apps/app/src/react-app/domains/connections/modals/add-mcp-modal.tsx` |
| Server URL input | `input[placeholder="https://api.githubcopilot.com/mcp/"]` | `add-mcp-modal.tsx` |
| OAuth checkbox | `input[type="checkbox"]` in the modal | `add-mcp-modal.tsx` |
| Add app submit | button text `Add App` | `add-mcp-modal.tsx` |

### Steps

1. Start the reusable mock OAuth MCP server in the Daytona sandbox:
   ```bash
   daytona exec openwork-test 'bash -lc "cd /workspace && nohup env PORT=3978 HOST=127.0.0.1 AUTO_APPROVE=1 node scripts/mock-oauth-mcp-server.mjs > /tmp/mock-mcp.log 2>&1 &"'
   ```

   Use `AUTO_APPROVE=0` when you specifically want to verify that a real browser
   page opens and requires a manual approval click.

2. Verify the mock server is healthy:
   ```bash
   daytona exec openwork-test 'bash -lc "curl -s http://127.0.0.1:3978/health"'
   ```

   Expected: `{"ok":true,...}`.

3. Create a workspace using Flow 1, or reuse an existing local workspace.

4. Open Settings, then Extensions:
   ```js
   (function(){var el=Array.from(document.querySelectorAll('button,a')).find(function(n){return n.getAttribute('aria-label')==='Settings'}); if(!el)return 'not found'; el.click(); return 'clicked';})()
   ```

   ```js
   (function(){var b=Array.from(document.querySelectorAll('button')).find(function(n){return n.textContent.trim()==='Extensions'}); if(!b)return 'not found'; b.click(); return 'clicked';})()
   ```

5. Click `Add Custom App`.

6. Fill the custom MCP modal and submit:
   ```js
   (function() {
     function setInput(input, value) {
       Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, value);
       input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: value }));
     }
     var name = document.querySelector('input[placeholder="github-copilot"]');
     var url = document.querySelector('input[placeholder="https://api.githubcopilot.com/mcp/"]');
     var checkbox = Array.from(document.querySelectorAll('input[type="checkbox"]')).find(function(el) { return !el.checked; }) || document.querySelector('input[type="checkbox"]');
     if (!name || !url || !checkbox) return 'missing fields';
     setInput(name, 'mock-oauth-eval');
     setInput(url, 'http://127.0.0.1:3978/mcp');
     if (!checkbox.checked) checkbox.click();
     var add = Array.from(document.querySelectorAll('button')).find(function(el) { return el.textContent.trim() === 'Add App' && !el.disabled; });
     if (!add) return 'add disabled';
     add.click();
     return 'submitted';
   })()
   ```

7. Immediately verify the auth modal appears and shows the reload-prep state:
   ```js
   document.body.innerText.includes('Applying changes before sign-in')
   ```

8. Wait up to 30s, then verify the mock OAuth server saw an authorization
   request and token exchange:
   ```bash
   daytona exec openwork-test 'bash -lc "curl -s http://127.0.0.1:3978/requests"'
   ```

   Expected request paths include `/authorize`, `/token`, and authenticated
   `/mcp` calls after `/token`.

9. Verify the app status for `mock-oauth-eval` is `Ready`:
   ```js
   (function() {
     var text = document.body.innerText;
     var i = text.indexOf('mock-oauth-eval');
     return i === -1 ? 'missing mock-oauth-eval' : text.slice(i, i + 200);
   })()
   ```

   Expected snippet includes `mock-oauth-eval` and `Ready`.

### Expected outcome

- The modal may briefly show `Applying changes before sign-in`, but it must not
  remain there after the worker reload.
- The mock server receives `/authorize` and `/token` requests.
- The configured MCP appears under `Your apps` as `Ready`.
- No real third-party OAuth provider or credentials are required.

### Regression caught

This catches the auth modal effect self-cancelling when `reloadStarting` changes,
which leaves the user stuck on `Applying changes before sign-in` and prevents the
browser from opening the OAuth URL.

---

## Flow 6: Desktop cloud login against Daytona server

**Goal:** Prove a real Electron Daytona sandbox can sign in against a separate
Daytona-hosted Den server stack.

### Steps

1. Start the server sandbox:
   ```bash
   bash .devcontainer/test-server-on-daytona.sh [branch-or-commit]
   ```

2. Copy the printed `Den Web` and `Den API` URLs, then start Electron against
   the server:
   ```bash
   bash .devcontainer/test-on-daytona.sh [branch-or-commit] \
     --den-base-url DEN_WEB_URL \
     --den-api-base-url DEN_API_URL
   ```

3. In Electron, open Settings, then `Cloud Account`.

4. Verify developer mode shows the Daytona Den Web URL as the configured base
   URL, and the signed-out panel is visible.

5. Create or sign in to a Den Web account, then use the desktop handoff code or
   full `openwork://den-auth?...` link in `Paste sign-in code`.

6. Verify Electron shows the cloud account as connected and can load orgs from
   the Daytona Den API.

### Expected outcome

- Electron bootstrap config points at the Daytona server sandbox, not production.
- Manual desktop handoff exchange succeeds.
- Settings show the signed-in user and at least one organization or the org
  selection prompt.
- Den API logs show `/v1/auth/desktop-handoff/exchange` and `/v1/me/orgs`.

---

## Flow 7: LLM api provisioning for desktop app from den

**Goal:** Prove a fresh Electron desktop app can receive a Den-managed LLM
provider, import it into the workspace, select the managed model, and complete a
real OpenCode task without relying on locally injected provider environment
variables.

### Verified run: 2026-06-02

- Server sandbox: `openwork-server-20260602-154721`
- Electron sandbox: `openwork-test-20260602-155000`
- Workspace: `ws_d3840983187b`, `/tmp/llm-den-provisioning-workspace`
- Den org: `acme-robotics-demo`, `org_01kt58ejd1extvd0p7nqagxaky`
- Recording: `https://8090-zz8rblselmaj10a5.daytonaproxy01.net/recordings/llm-api-provisioning-desktop-from-den.mp4`

### Steps

1. Start a fresh Daytona server sandbox and seed the demo organization:
   ```bash
   bash .devcontainer/test-server-on-daytona.sh [branch-or-commit]
   ```

2. Start a fresh Electron sandbox against that Den server with recording enabled:
   ```bash
   bash .devcontainer/test-on-daytona.sh [branch-or-commit] \
     --den-base-url DEN_WEB_URL \
     --den-api-base-url DEN_API_URL \
     --record-video \
     --recording-name llm-api-provisioning-desktop-from-den
   ```

3. Restart Electron without local AI-provider secrets so the baseline has no
   local OpenAI provider:
   ```bash
   DAYTONA_SECRETS_ENV=/tmp/no-daytona-secrets bash /opt/openwork-daytona/start-daytona-electron.sh --detach
   ```

4. Create a clean workspace and verify Settings -> AI Providers initially shows
   only `OpenCode Zen`.

5. Create a Den-managed OpenAI provider through the Den API. Do not print the API
   key; read it inside the sandbox only for the provider creation request.

6. Refresh or wait for desktop cloud sync. Verified timing: provider creation
   took `555ms`; the provider appeared/imported in desktop AI Providers `35.7s`
   after Den creation.

7. Click `Reload now`, open the model picker, select the imported cloud provider
   `Den OpenAI Verified 1780441917820`, then select `GPT-5.5`.

8. Create a new session and run:
   ```text
   Reply with exactly: Den LLM provisioning OK
   ```

9. Verify the UI response is exactly:
   ```text
   Den LLM provisioning OK
   ```

10. Verify the session metadata uses the Den provider, not `openai` from local
    environment configuration:
    ```json
    {
      "providerID": "lpr_01kt59qavdfk4skede8anxce1a",
      "modelID": "gpt-5.5",
      "variant": "medium"
    }
    ```

### Add/remove/perf checkpoints

Use these checkpoints when validating provider lifecycle and desktop sync
latency, especially after changing Den provider payloads or desktop policy code.

1. Baseline before add:
   - Restart Electron with `DAYTONA_SECRETS_ENV=/tmp/no-daytona-secrets`.
   - Confirm AI Providers shows no local OpenAI provider.
   - Capture `performance.now()` in the page before creating the Den provider.

2. Add/import timing:
   - Create the Den LLM provider through the Den API and record API duration.
   - Measure time until the provider appears in Settings -> AI Providers as
     `Imported` and `Credential ready`.
   - Verified run baseline: create `555ms`, visible/imported in desktop `35.7s`.

3. Add/use timing:
   - Click `Reload now`, select the imported provider model, and run the exact
     prompt from this flow.
   - Record time from `Run task` click to first final assistant text.
   - Confirm the session model metadata uses the `lpr_...` provider id.

4. Remove timing:
   - Delete the Den provider from the org, or remove it from the resource
     snapshot source used by the Den API.
   - Trigger desktop provider sync by opening Settings -> AI Providers, changing
     Den settings, or waiting for the cloud-provider sync interval.
   - Confirm the imported provider disappears from connected providers,
     workspace cloud import metadata, and the model picker.
   - Confirm a task cannot continue using the removed provider after reload.

5. Policy persistence:
   - Toggle an org desktop policy in Den, refresh desktop settings, then reload
     the app.
   - Confirm the restriction is still applied immediately from cached desktop
     config before the HTTP refresh completes.
   - Confirm the HTTP refresh either updates the policy or preserves the cached
     policy on transient failure.

6. Local file checks:
   - Confirm OpenWork-owned cloud import metadata is stored in the OpenWork
     runtime DB, not `.opencode/openwork.json`.
   - Confirm the provider executable config currently lands in `opencode.jsonc`;
     this remains a follow-up if the desired end state is no cloud-managed
     provider writes to user-owned OpenCode config.

### Expected outcome

- Fresh desktop starts without a local OpenAI provider.
- Den-managed provider appears as a cloud provider with `Credential ready`.
- Imported provider config includes the executable provider config fields needed
  by OpenCode, including the provider package metadata.
- The selected model completes a real task and returns `Den LLM provisioning OK`.
- Removing the Den provider removes the imported local provider on the next
  desktop provider sync and reload.
- Sync timing remains interactive for realistic org provider counts.
- No API key is printed, checked in, or written into repo docs.

### Regression caught

Den returned `providerConfig` and model `config` as JSON strings. The desktop
client must parse those stringified records; otherwise imported provider config
is incomplete and OpenCode fails with `"undefined/chat/completions" cannot be
parsed as a URL.`

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
Check memory and disk. Electron + opencode + Vite needs ~6GB. Use `--memory 8`.
Dependencies/sidecars need more than the default 3GB disk; use `--disk 10`.

**CDP timeouts:**
The renderer might be frozen (e.g., a blocking IPC call). Restart Electron:
```bash
daytona exec openwork-test 'bash -lc "pkill -f electron || true; pkill -f electron-dev || true"'
sleep 3
daytona exec openwork-test 'bash -lc "cd /workspace && bash /opt/openwork-daytona/start-daytona-electron.sh --detach"'
```

`[openwork] Electron CDP exposed...` only means OpenWork requested CDP. The real
success marker is Chromium's own `DevTools listening on ws://127.0.0.1:9825/...`
line in `/tmp/electron.log`.
