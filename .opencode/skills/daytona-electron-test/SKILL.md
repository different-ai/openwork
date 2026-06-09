---
name: daytona-electron-test
description: "Daytona Electron sandbox testing with CDP/noVNC. Use when the user says test on Daytona, run Electron on Daytona, Daytona dry run, test Electron remotely, reproduce on Daytona, or validate a real desktop flow."
---

# Skill: Daytona Electron Test

Drive the real OpenWork Electron app inside a Daytona sandbox via CDP browser
tools. Covers workspace creation, session interaction, settings verification,
and bug reproduction.

## When to use

- User says "test on Daytona", "run the app on Daytona", "Daytona dry run"
- User wants to reproduce a bug in the real Electron app remotely
- User wants to verify a UI flow end-to-end without local Electron

## Fastest path: the script

Run the helper script from the repo root. It creates a Daytona VNC-capable
sandbox from the reusable `openwork-eval-vnc` snapshot when present, checks out
the ref, conditionally installs deps, starts XFCE/noVNC, Vite, Electron, and
waits for CDP:

```bash
bash .devcontainer/test-on-daytona.sh [branch-or-commit]
```

It prints the CDP and noVNC URLs at the end. Then use `browser_list` to connect.
Refresh the snapshot with `bash .devcontainer/create-daytona-openwork-snapshot.sh`
when dependencies or base setup change. The snapshot excludes `node_modules`;
dependency installs reuse the `openwork-eval-pnpm-store` volume.
For provider flows, create/populate the reusable secrets volume once with
`bash .devcontainer/setup-daytona-secrets-volume.sh .newtoken`; future Daytona
sandboxes mount `openwork-eval-secrets:/daytona-secrets` automatically and
source every `/daytona-secrets/*.env` file before Electron starts.

## Related Daytona Skills

- `daytona-flow-validator`: pass/fail validation with a strict observe -> act
  -> observe/assert -> evidence loop.
- `daytona-cloud-server`: Den Web/API, worker proxy, marketplace, cloud auth,
  and org policy server setup.
- `daytona-electron-den`: two-sandbox server + Electron validation.
- `daytona-chrome-cdp`: standalone Chrome in Daytona for web sign-in and OAuth.
- `daytona-secrets-volume`: provider keys and eval-only secrets in
  `openwork-eval-secrets:/daytona-secrets`.
- `daytona-recording-artifacts`: screenshots, recordings, validation artifacts,
  before/after videos, and PR evidence.

## Daytona Testing Toolbox

- **Cloud server:** use `.devcontainer/test-server-on-daytona.sh` for Den Web,
  Den API, worker proxy, org policies, marketplace, and cloud auth flows.
- **Secrets volume:** use `openwork-eval-secrets:/daytona-secrets` for provider
  keys and eval-only credentials. Add more files with
  `bash .devcontainer/setup-daytona-secrets-volume.sh <local-env> <name>.env`.
- **Electron sandbox:** use `.devcontainer/test-on-daytona.sh` for the real
  desktop app, noVNC visual access, and CDP automation on port 9825.
- **Artifacts volume:** use `openwork-eval-artifacts:/daytona-artifacts` for
  screenshots, validation notes, and recordings that survive sandbox deletion.

Validation standard: use `daytona-flow-validator`. Default proof format is
frame-by-frame HTML — named PNGs in a browseable index served on port 8090.
Use video only for interactions that need motion (streaming, animations,
loading states). See `daytona-recording-artifacts` for the frame workflow.

Before sharing screenshot URLs, inspect the saved PNG itself per
`daytona-flow-validator`. Do not post screenshots that are covered by native
pickers, dialogs, toasts, desktop windows, or unrelated overlays.

When the user asks specifically about server, secrets, recordings, screenshots,
or evidence, use the focused skill above instead of relying only on this runbook.

## Manual debugging

Do not copy raw Daytona create/start commands into new docs or skills. Keep the
single maintained provisioning path in `.devcontainer/test-on-daytona.sh` and
debug by inspecting its logs:

```bash
daytona exec <sandbox> -- 'tail -80 /tmp/start-vnc.log'
daytona exec <sandbox> -- 'tail -80 /tmp/vite.log'
daytona exec <sandbox> -- 'tail -80 /tmp/electron.log'
```

### Get URLs

```bash
# Electron CDP (automation) -- THIS IS WHAT browser_list CONNECTS TO
daytona preview-url "$SANDBOX" -p 9825

# noVNC (visual access in your browser)
daytona preview-url "$SANDBOX" -p 6080
```

### 5. Connect browser tools

```
browser_list({ browser_url: "<CDP_URL>" })
```

Should show: `[target_id] OpenWork  http://localhost:5173/#/welcome`

### 6. Verify it's real Electron (not plain Chromium)

```
browser_eval({ browser_url: "<CDP_URL>", target_id: "<TARGET_ID>", expression: "navigator.userAgent" })
```

Must contain `Electron/`.

## Creating a workspace through the UI

### Prepare the directory first

```bash
daytona exec "$SANDBOX" -- "bash -lc 'mkdir -p /workspace/hello'"
```

### Drive the modal

1. **Click "Get started":**
```js
(function() { var btns = document.querySelectorAll('button'); for (var i = 0; i < btns.length; i++) { if (btns[i].textContent.indexOf('Get started') !== -1) { btns[i].click(); return 'clicked'; } } return 'not found'; })()
```

2. **Click "Local workspace":**
```js
(function() { var btns = document.querySelectorAll('button'); for (var i = 0; i < btns.length; i++) { if (btns[i].textContent.indexOf('Local workspace') !== -1) { btns[i].click(); return 'clicked'; } } return 'not found'; })()
```

3. **Inject folder path** (bypasses the native file picker that can't work headless):
```js
JSON.stringify((function() {
  function findFiber(el) {
    var key = Object.keys(el).find(function(k) { return k.startsWith('__reactFiber$'); });
    return key ? el[key] : null;
  }
  var all = document.querySelectorAll('span,div,p');
  var p = null;
  for (var i = 0; i < all.length; i++) {
    if (all[i].textContent.indexOf('No folder') !== -1) { p = all[i]; break; }
  }
  if (!p) return {err: 'no placeholder'};
  var fiber = findFiber(p);
  while (fiber) {
    var name = (fiber.elementType && fiber.elementType.name) || (fiber.type && fiber.type.name) || '';
    if (name === 'CreateWorkspaceModal') break;
    fiber = fiber.return;
  }
  if (!fiber) return {err: 'no fiber'};
  var hook = fiber.memoizedState;
  while (hook) {
    if (hook.queue && hook.queue.dispatch) {
      hook.queue.dispatch({ key: 'selectedFolder', value: '/workspace/hello' });
      hook.queue.dispatch({ key: 'pickingFolder', value: false });
      return {ok: true};
    }
    hook = hook.next;
  }
  return {err: 'no dispatch'};
})())
```

The reducer uses `{ key, value }` actions. NOT direct state replacement.

4. **Click "Create Workspace":**
```js
(function() { var btns = document.querySelectorAll('button'); for (var i = 0; i < btns.length; i++) { if (btns[i].textContent.trim() === 'Create Workspace' && !btns[i].disabled) { btns[i].click(); return 'clicked'; } } return 'not found'; })()
```

5. **Wait 10-12s.** Verify:
   - URL contains `#/workspace/ws_`
   - Status bar shows "OpenWork Ready"
   - opencode process running: `daytona exec "$SANDBOX" -- "bash -lc 'ps aux | grep opencode | grep -v grep'"`

### Native Linux dialogs

If the current app path opens a native Linux dialog instead of the React modal,
use `daytona-flow-validator`'s Linux desktop automation guidance. Drive GTK file
pickers and OS dialogs with `xdotool`/`wmctrl`, then verify the dialog closed
with `wmctrl -l`, assert app state with CDP, and inspect the captured screenshot
before sharing evidence.

## UI automation selector map

Before guessing selectors, check the owning component. Prefer ARIA labels,
button text, and input placeholders over brittle CSS classes. Use React fiber
only when bypassing native file pickers.

| Control | Stable selector/search | Source file |
|---|---|---|
| Settings button | `button[aria-label="Settings"]` | `apps/app/src/react-app/domains/session/chat/status-bar.tsx` |
| Back to app | button text `Back to app` | `apps/app/src/react-app/domains/settings/shell/settings-shell.tsx` |
| New task | `button[aria-label="New task"]` | `apps/app/src/react-app/domains/session/sidebar/app-sidebar.tsx` |
| Run task | button text `Run task` | `apps/app/src/react-app/domains/session/surface/composer/composer.tsx` |
| Model selector | `button[aria-label="Change model"]` | `apps/app/src/react-app/domains/session/surface/composer/composer.tsx` |
| Composer editor | `[contenteditable="true"][data-lexical-editor="true"]` | `apps/app/src/react-app/domains/session/surface/composer/editor.tsx` |
| AI Providers tab | button text `AI Providers` | `apps/app/src/react-app/domains/settings/shell/settings-page.tsx` |
| Connect provider | button text `Connect provider` | `apps/app/src/react-app/domains/settings/pages/ai-view.tsx` |
| Provider search | `input[placeholder="Filter providers by name or ID"]` | `apps/app/src/react-app/domains/connections/provider-auth/provider-auth-modal.tsx` |
| Manual key option | button containing `Manually enter API Key` | `provider-auth-modal.tsx` |
| API key input | `input[type="password"][placeholder="sk-..."]` | `provider-auth-modal.tsx` |
| Save key | button text `Save key` | `provider-auth-modal.tsx` |

Reusable click helpers:

```js
// Click exact button text.
(function(text) { var b = Array.from(document.querySelectorAll('button')).find(function(el) { return el.textContent.trim() === text && !el.disabled; }); if (!b) return 'not found: ' + text; b.click(); return 'clicked: ' + text; })('AI Providers')
```

```js
// Click an ARIA-labeled button/link.
(function(label) { var el = Array.from(document.querySelectorAll('button,a')).find(function(node) { return node.getAttribute('aria-label') === label && !node.disabled; }); if (!el) return 'not found: ' + label; el.click(); return 'clicked: ' + label; })('Settings')
```

```js
// Set a React-controlled input.
(function(selector, value) { var input = document.querySelector(selector); if (!input) return 'not found: ' + selector; Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, value); input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: value })); return 'set: ' + selector; })('input[placeholder="Filter providers by name or ID"]', 'openai')
```

```js
// Paste text into the Lexical composer. Prefer this over execCommand in Electron/CDP.
(function(text) { var editor = document.querySelector('[contenteditable="true"][data-lexical-editor="true"]'); if (!editor) return 'no editor'; editor.focus(); var data = new DataTransfer(); data.setData('text/plain', text); editor.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: data })); return editor.innerText; })('Reply with exactly: Daytona UI key OK')
```

## Connect OpenAI through the UI

Use this when the user provides a temporary key and asks to test real model
sessions. Do not write the key into docs or repo files.

1. Open Settings using `button[aria-label="Settings"]`.
2. Click `AI Providers`.
3. Click `Connect provider`.
4. Set `input[placeholder="Filter providers by name or ID"]` to `openai`.
5. Click the provider row containing `OpenAI` and `openai`.
6. Click `Manually enter API Key`.
7. Set `input[type="password"][placeholder="sk-..."]` to the key.
8. Click `Save key`.
9. Verify text includes `2 providers connected`, `OpenAI`, and `Disconnect`.
10. Click `Pick a new default?`, expand `OpenAI`, select `Default model`, and click `GPT-5.5gpt-5.5`.
11. Return to app, create a session, paste a prompt into the composer, and click `Run task`.

Expected successful session message metadata: provider `openai`, model `gpt-5.5`, variant `medium`.

## Session interaction

### Prerequisites: API key for real LLM sessions

To test real sessions (not just UI flow), the opencode sidecar needs an LLM
provider key. The easiest is OpenAI:

```bash
daytona exec "$SANDBOX" -- "bash -lc 'cd /workspace/hello && node -e \"
  const fs = require(\\\"fs\\\");
  const p = \\\"opencode.jsonc\\\";
  let c = JSON.parse(fs.readFileSync(p, \\\"utf8\\\").replace(/^\\\\/\\\\/.*$/gm, \\\"\\\"));
  c.provider = c.provider || {};
  c.provider.openai = { options: { apiKey: process.env.KEY } };
  fs.writeFileSync(p, JSON.stringify(c, null, 2));
\" '"
```

Set `KEY=sk-proj-...` in the command above. After writing the config, you
**must restart all services** (see "Injecting API keys" section below) for
opencode to pick up the new provider.

To switch models in the UI, click the model name in the bottom bar (e.g.
"Big Pickle") and select the desired model (e.g. GPT-5.5).

### Type in the Lexical composer

```js
(function() {
  var editor = document.querySelector('[contenteditable=true]');
  if (!editor) return 'no editor';
  editor.focus();
  document.execCommand('selectAll', false, null);
  document.execCommand('insertText', false, 'YOUR PROMPT HERE');
  return 'typed';
})()
```

**MUST use `document.execCommand('insertText', ...)`.**
Direct `textContent =` or `innerHTML =` does NOT trigger Lexical state updates.

### Click Run task

```js
(function() { var btns = document.querySelectorAll('button'); for (var i = 0; i < btns.length; i++) { if (btns[i].textContent.indexOf('Run task') !== -1 && !btns[i].disabled) { btns[i].click(); return 'clicked'; } } return 'not found'; })()
```

### Check response

```js
document.body.innerText.substring(0, 3000)
```

## Settings navigation

**Open settings** (gear icon):
```js
(function() { var el = Array.from(document.querySelectorAll('button,a')).find(function(node) { return node.getAttribute('aria-label') === 'Settings'; }); if (!el) return 'not found'; el.click(); return 'clicked'; })()
```

**Navigate to a panel** (e.g. AI Providers):
```js
(function() { var btn = Array.from(document.querySelectorAll('button')).find(function(el) { return el.textContent.trim() === 'AI Providers'; }); if (!btn) return 'not found'; btn.click(); return 'clicked'; })()
```

**Back to app:**
```js
(function() { var btn = Array.from(document.querySelectorAll('button')).find(function(el) { return el.textContent.trim() === 'Back to app'; }); if (!btn) return 'not found'; btn.click(); return 'clicked'; })()
```

## Window management (minimize/restore testing)

Install xdotool first:
```bash
daytona exec "$SANDBOX" -- "bash -lc 'apt-get update && apt-get install -y xdotool'"
```

Then:
```bash
# Minimize
daytona exec "$SANDBOX" -- "bash -lc 'DISPLAY=:99 xdotool search --name OpenWork windowminimize'"

# Restore
daytona exec "$SANDBOX" -- "bash -lc 'DISPLAY=:99 xdotool search --name OpenWork windowactivate'"
```

## API keys and eval secrets

Do not edit workspace config or print keys. Create/populate the reusable
Daytona volume once from the repo root:

```bash
bash .devcontainer/setup-daytona-secrets-volume.sh .newtoken
bash .devcontainer/setup-daytona-secrets-volume.sh .anthropic anthropic.env
```

Every Daytona eval sandbox mounts `openwork-eval-secrets:/daytona-secrets` and
`/opt/openwork-daytona/start-daytona-electron.sh` sources every
`/daytona-secrets/*.env` file before Electron starts. Keep provider keys, test
OAuth credentials, and other eval-only secrets there instead of workspace files.
If you update the volume while a sandbox is already running, restart Electron so
the env is reloaded:

```bash
# Step 1: kill Electron/runtime children
daytona exec "$SANDBOX" -- "bash -lc 'pkill -f electron || true; pkill -f electron-dev || true; pkill -f opencode || true'"

# Step 2: wait, then restart Electron (separate exec call)
sleep 3
daytona exec "$SANDBOX" -- "bash -lc 'cd /workspace && bash /opt/openwork-daytona/start-daytona-electron.sh --detach'"
```

**GOTCHA:** Do NOT chain `pkill` and the restart in the same
`daytona exec` call. `pkill -f electron` sends SIGTERM to the exec session
itself (because the command string matches). The restart never runs.
Always use two separate `daytona exec` calls with a `sleep` between them.

## Ports reference

| Service   | Port | Description                              |
|-----------|------|------------------------------------------|
| noVNC     | 6080 | See the Electron app visually            |
| Vite HMR  | 5173 | React UI hot reload                      |
| CDP       | 9825 | Chrome DevTools Protocol for automation  |
| Den Web   | 3005 | Admin dashboard (needs MySQL)            |
| Den API   | 8788 | Control plane (needs MySQL)              |

## Two-sandbox Den + Electron marketplace evals

Use `daytona-electron-den` when testing Cloud Marketplace, desktop policies, or
org-managed extension flows end-to-end. Keep this section as a quick reference
only.

1. Start the Den server sandbox:
```bash
bash .devcontainer/test-server-on-daytona.sh <branch-or-commit>
```

2. Seed the server sandbox with demo org, marketplace, and plugin data. The seed
must use the same encryption key as `.devcontainer/start-daytona-server.sh`, and
`@openwork/email` must be built before the seed imports Den email helpers:
```bash
daytona exec <server-sandbox> -- 'cd /workspace && pnpm --filter @openwork/email build && cd /workspace/ee/apps/den-api && OPENWORK_DEV_MODE=1 DATABASE_URL=mysql://root:password@127.0.0.1:3306/openwork_den DEN_DB_ENCRYPTION_KEY=daytona-den-db-encryption-key-please-change-1234567890 BETTER_AUTH_SECRET=local-dev-secret-not-for-production-use!! BETTER_AUTH_URL=http://localhost:3005 pnpm exec tsx scripts/seed-demo-org.ts --reset'
```

3. Start Electron against the printed Den Web/API URLs:
```bash
bash .devcontainer/test-on-daytona.sh <branch-or-commit> --den-base-url <DEN_WEB_URL> --den-api-base-url <DEN_API_URL> --record-video --recording-name <name>
```

4. Sign in from Electron using the seeded demo account. Create a desktop handoff
grant from the Den API, paste the `openwork://den-auth?...` URL into Cloud
Account -> `Paste sign-in code`, and choose `Acme Robotics`:
```bash
TOKEN=$(curl -s -X POST '<DEN_API_URL>/api/auth/sign-in/email' -H 'content-type: application/json' --data '{"email":"alex@acme.test","password":"OpenWorkDemo123!"}' | node -e 'let s="";process.stdin.on("data",c=>s+=c);process.stdin.on("end",()=>process.stdout.write(JSON.parse(s).token))')
curl -s -X POST '<DEN_API_URL>/v1/auth/desktop-handoff' -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' --data '{"desktopScheme":"openwork"}'
```

5. Open Settings -> Extensions -> Marketplace and run the marketplace install,
remove, search, and filter flows against the seeded marketplace packages.

## Troubleshooting

**OOM during pnpm install or Vite esbuild crash (EPIPE):**
You used `--memory 1` (default). Always `--memory 8`.

**Electron exits with "Running as root without --no-sandbox":**
The devcontainer sets `ELECTRON_DISABLE_SANDBOX=1`. If running Electron
manually, pass `--no-sandbox` or set the env var.

**Generic DBus errors in Electron logs:**
DBus warnings are expected in Daytona/Linux containers. They are not fatal if
you also see `DevTools listening on ws://127.0.0.1:9825/...` and an OpenWork
window in noVNC.

**GPU process errors in Electron logs:**
`Exiting GPU process due to errors during initialization` is common under Xvfb.
It is not fatal if Chromium falls back and the window appears. If CDP never
prints `DevTools listening`, check `/tmp/electron.log` and restart Electron.

**"bun: not found" during dev:electron:**
The sidecar prep script uses bun. The devcontainer Dockerfile installs it
globally. If you built a custom Dockerfile, add `RUN npm install -g bun`.

**"xauth command not found":**
`apt-get install -y xauth` (already in the devcontainer Dockerfile).

**CDP shows no targets after 60s:**
Check `/tmp/electron.log` and `/tmp/vite.log`:
```bash
daytona exec "$SANDBOX" -- "bash -lc 'tail -80 /tmp/electron.log'"
daytona exec "$SANDBOX" -- "bash -lc 'tail -80 /tmp/vite.log'"
```

The app log line `[openwork] Electron CDP exposed at http://127.0.0.1:9825`
means OpenWork requested CDP. The real success marker is Chromium's own line:
`DevTools listening on ws://127.0.0.1:9825/devtools/browser/...`.

**opencode sidecar not restarting after kill:**
The Electron runtime manager does NOT auto-detect sidecar death. You must
restart the entire Electron process.

**`daytona exec` with `pkill` kills the exec session:**
The process pattern match hits the exec wrapper. Always split kill and
restart into separate `daytona exec` calls.

**Blank Electron window (empty `<div id="root"></div>`):**
Vite crashed (check `/tmp/vite.log`). Usually memory pressure. Verify
`free -m` shows >2 GB available.

**noVNC URL says sandbox not found:**
Preview URLs are not stable. Regenerate the URL:
```bash
daytona preview-url "$SANDBOX" -p 6080
```

**Electron starts twice or CDP says address already in use:**
Kill the old Electron process before restarting:
```bash
daytona exec "$SANDBOX" -- "bash -lc 'pkill -f electron || true; pkill -f electron-dev || true'"
```

## Recording before/after comparisons

Use this workflow to capture a BEFORE recording on the current branch, switch
to a feature branch on the same sandbox, and capture an AFTER recording. Both
recordings are saved to the persistent `openwork-eval-artifacts` volume and
survive sandbox deletion.

### Step 1: Start the sandbox with BEFORE recording

```bash
bash .devcontainer/test-on-daytona.sh dev --record-video --recording-name my-feature-before
```

Save the sandbox name from the output (e.g. `SANDBOX=openwork-test-20260601-165424`).

### Step 2: Drive the BEFORE flow

Use browser tools to navigate the app and demonstrate the current behavior.
The display is being recorded the entire time.

### Step 3: Stop the BEFORE recording

```bash
daytona exec "$SANDBOX" -- 'bash .devcontainer/stop-daytona-recording.sh'
```

### Step 4: Switch to the feature branch

```bash
daytona exec "$SANDBOX" -- "bash -lc 'cd /workspace && git fetch origin feat/my-branch:feat/my-branch && git checkout feat/my-branch'"
```

Vite HMR picks up the changes automatically. Wait a few seconds, then reset
any app state needed (e.g. onboarding flag):

```js
// In browser_eval:
const raw = localStorage.getItem("openwork.preferences");
const prefs = raw ? JSON.parse(raw) : {};
prefs.hasCompletedOnboarding = false;
localStorage.setItem("openwork.preferences", JSON.stringify(prefs));
location.reload();
```

### Step 5: Start the AFTER recording

```bash
daytona exec "$SANDBOX" -- "bash -lc 'cd /workspace && DISPLAY=:99 .devcontainer/start-daytona-recording.sh --detach --output /daytona-artifacts/recordings/my-feature-after.mp4'"
```

### Step 6: Drive the AFTER flow

Use browser tools to demonstrate the new behavior. Same steps as BEFORE, but
validate with `daytona-flow-validator` before calling the recording successful.

### Step 7: Stop the AFTER recording

```bash
daytona exec "$SANDBOX" -- 'bash .devcontainer/stop-daytona-recording.sh'
```

### Step 8: Get recording URLs

Both recordings are on the persistent artifacts volume, served via the
Python HTTP server on port 8090:

```bash
ARTIFACTS_URL=$(daytona preview-url "$SANDBOX" -p 8090 2>/dev/null | grep -v "^time=")
echo "BEFORE: ${ARTIFACTS_URL}/recordings/my-feature-before.mp4"
echo "AFTER:  ${ARTIFACTS_URL}/recordings/my-feature-after.mp4"
```

Include these URLs in your PR description.

## Screenshot validation checkpoints

Use screenshots for fast validation while driving the UI. They complement, but
do not replace, CDP assertions or recordings.

```bash
daytona exec "$SANDBOX" -- 'bash .devcontainer/capture-daytona-screenshot.sh'
```

Screenshots are saved to `/daytona-artifacts/screenshots` when the artifacts
volume is mounted. Get the download URL from port 8090:

```bash
ARTIFACTS_URL=$(daytona preview-url "$SANDBOX" -p 8090 2>/dev/null | grep -v "^time=")
echo "${ARTIFACTS_URL}/screenshots/<filename>.png"
```

Use this pattern for each critical UI state: run a CDP assertion, capture a
screenshot, then continue the recording.

### Key recording commands reference

| Action | Command |
|--------|---------|
| Start recording (from test-on-daytona.sh) | `--record-video --recording-name NAME` |
| Start recording (mid-sandbox) | `daytona exec $SANDBOX -- "bash -lc 'cd /workspace && DISPLAY=:99 .devcontainer/start-daytona-recording.sh --detach --output /daytona-artifacts/recordings/NAME.mp4'"` |
| Stop recording | `daytona exec $SANDBOX -- 'bash .devcontainer/stop-daytona-recording.sh'` |
| List recordings | `daytona exec $SANDBOX -- 'ls -lah /daytona-artifacts/recordings/'` |
| Capture screenshot | `daytona exec $SANDBOX -- 'bash .devcontainer/capture-daytona-screenshot.sh'` |
| Get download URL | `daytona preview-url $SANDBOX -p 8090` then append `/recordings/NAME.mp4` |

### Notes

- Recordings are stored on the `openwork-eval-artifacts` Daytona volume (5 GB,
  reusable across sandboxes). They persist after `daytona delete`.
- The `start-daytona-recording.sh` script records to a temp file first, then
  copies to the artifacts volume on stop — this avoids NFS write issues.
- Always use `stop-daytona-recording.sh` to stop. It sends SIGINT so ffmpeg
  finalizes the mp4 container properly. SIGKILL produces a corrupt file.
- Default resolution is 1920x1080 at 15fps. Override with `--size 1280x800
  --fps 10` for smaller files.

## Teardown

```bash
daytona delete "$SANDBOX"
```
