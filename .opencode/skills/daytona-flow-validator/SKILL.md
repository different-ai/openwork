---
name: daytona-flow-validator
description: Daytona UI flow validation loop. Use when validating real app behavior, checking a Daytona flow, proving a bug is fixed, or deciding pass/fail from CDP snapshots, screenshots, and assertions.
---

# Daytona Flow Validator

Use this skill to decide whether a Daytona Electron or browser flow actually
works. Launching the sandbox is separate. This skill owns the feedback loop.

## Core Rule

Never report success from a click, script return value, or recording alone.
Validate the same path a human would take, using CDP to drive Chrome or Electron
instead of replacing the journey with hidden state changes. Every meaningful
action must follow this loop:

1. Observe with `browser_snapshot` first.
2. Act with `browser_click` or `browser_fill` against snapshot UIDs whenever possible.
3. Observe again with `browser_snapshot`.
4. Assert the expected URL, text, state, process, network, or file result.
5. Capture a screenshot checkpoint when the visible state matters.

If any assertion is missing, the flow is not validated yet.

Use `browser_eval`, direct API calls, localStorage writes, filesystem edits, or
database changes only when a human-visible path is impossible, unavailable in the
current product, or needed as setup for data that the UI cannot create yet. When
you use one of these shortcuts, say so in the report and do not let it replace the
visible click-by-click demo claim.

## Human-Visible Demo Standard

For founder, designer, PR, or eval evidence, record the journey as a reviewer
would experience it:

- Start recording before the first user-visible action.
- Use Chrome CDP for Den Web and Electron CDP for desktop.
- Prefer accessible snapshot items and visible clicks/fills over synthetic DOM mutation.
- Keep every major transition visible: sign-up, org creation, onboarding, handoff, desktop sign-in, Marketplace, install, and chat response.
- Do not skip screens by setting tokens, editing localStorage, calling APIs, or navigating directly unless the report labels that segment as setup or a known product gap.
- If test data must be created through an API, show the result in the UI immediately after and state that the data creation was invisible setup.
- A recording that cannot be understood without terminal logs, API responses, or explanation is not a full demo pass.

## Minimum Pass Evidence

For a UI flow, collect all of these when feasible:

- CDP target proof: `browser_list` shows the intended target.
- App proof: `navigator.userAgent` contains `Electron/` for desktop flows, or does not for standalone Chrome flows.
- State proof: URL, visible text, selected model/provider, status, or route matches the expected outcome.
- Backend proof: relevant `daytona exec` process/log/health check for sidecars, Den, worker proxy, or mock servers.
- Frame-by-frame HTML proof: the default deliverable. Named PNGs for each step served as a browseable HTML index on port 8090. See `daytona-recording-artifacts` for how to produce the index.
- Video clips: only when a step involves motion (streaming text, loading spinners, animations). Embed clips in the same HTML index alongside the static frames.

Frame proof is the default. Video is the exception for interactions that need
motion. When the user says "test this on Daytona" and UI is involved, always
produce frame-by-frame HTML proof unless the user explicitly asks for video.

## Validation Loop Template

Use this structure for each step in the final report:

```text
Step: <what was attempted>
Before: <snapshot/eval showed X>
Action: <tool/selector used>
After: <snapshot/eval showed Y>
Assertion: pass/fail because <observable signal>
Evidence: <screenshot path or artifact URL if captured>
```

## Prefer Accessible Snapshots

Start with `browser_snapshot` for normal UI controls because it gives stable
UIDs for `browser_click` and `browser_fill`. Treat `browser_eval` as an escape
hatch, not the default interaction mechanism. Use `browser_eval` when:

- React dynamic UI makes snapshot UIDs stale.
- Native file pickers must be bypassed.
- Lexical editor input needs a synthetic paste event.
- You need to inspect app state, localStorage, URL, or text quickly.

Even when `browser_eval` is necessary, keep the user-visible state coherent:
observe before, perform the minimal hidden action, then observe the visible result
with `browser_snapshot` or a screenshot.

## Lexical Composer

Prefer synthetic paste for the OpenWork composer:

```js
(function pasteComposer(text) {
  var editor = document.querySelector('[contenteditable="true"][data-lexical-editor="true"]');
  if (!editor) return { ok: false, reason: 'composer not found' };
  editor.focus();
  var data = new DataTransfer();
  data.setData('text/plain', text);
  editor.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: data }));
  return { ok: true, text: editor.innerText };
})('Reply with exactly: Daytona validation OK')
```

Then assert the Run button is enabled before clicking it.

## Linux Desktop Automation

Use CDP for renderer UI first. When the flow opens native Linux UI that CDP
cannot control, such as GTK file pickers, OS permission dialogs, XFCE windows,
or Electron-native dialogs, switch to desktop automation inside the sandbox.

Check/install the tools:

```bash
daytona exec "$SANDBOX" -- "bash -lc 'if ! command -v xdotool >/dev/null 2>&1; then sudo apt-get update && sudo apt-get install -y xdotool wmctrl; fi'"
```

Inspect the real desktop window state before acting:

```bash
daytona exec "$SANDBOX" -- "bash -lc 'DISPLAY=:99 wmctrl -l; DISPLAY=:99 xdotool getactivewindow getwindowname 2>/dev/null || true'"
```

Native file picker pattern:

```bash
daytona exec "$SANDBOX" -- "bash -lc 'DISPLAY=:99 xdotool search --name \"Authorize folder\" windowactivate; DISPLAY=:99 xdotool mousemove 760 151 click 1 key ctrl+a type --delay 1 -- \"/workspace/hello\" key Return; sleep 1; DISPLAY=:99 xdotool mousemove 1465 927 click 1'"
```

Rules for native desktop automation:

- Use `wmctrl -l` before and after to prove the expected native window opened or
  closed.
- Prefer window titles such as `Authorize folder` over coordinates when possible.
- Use coordinates only after inspecting a screenshot/noVNC state; coordinate
  clicks are display-size dependent.
- Close stale dialogs with `Escape` before capturing evidence.
- After native automation, reassert app state with CDP and inspect a fresh
  screenshot. Native dialogs commonly remain on top and invalidate evidence.

Close stale native dialogs before recording or screenshots:

```bash
daytona exec "$SANDBOX" -- 'bash -lc '\''DISPLAY=:99 xdotool search --name "Authorize folder" windowclose %@ 2>/dev/null || true; sleep 1; DISPLAY=:99 wmctrl -l'\'''
```

## Screenshots

Use browser screenshots for renderer state:

```text
browser_screenshot({ browser_url: CDP_URL, target_id: TARGET_ID })
```

Use Daytona display screenshots for noVNC/window state:

```bash
daytona exec "$SANDBOX" -- 'bash .devcontainer/capture-daytona-screenshot.sh'
```

Do not treat screenshots as the only assertion. Inspect text/state with CDP too.

Before publishing, commenting, or reporting a screenshot URL, open the saved
image and visually verify it matches the claim. Use `webfetch` on the artifact
URL, `Read` on the local PNG path, or another image-capable viewer. A screenshot
is not valid evidence until the image itself has been inspected.

For every screenshot, assert these visual checks:

- The target OpenWork/Chrome window is visible and not covered by a native file
  picker, modal, toast, desktop window, or unrelated overlay.
- The exact claimed state is visible in the image, not just present in DOM or
  command output.
- Important labels, selected rows, dropdown options, status indicators, artifact
  cards, or output panes are legible enough for a reviewer.
- The screenshot URL belongs to the sandbox and flow being reported.

If any check fails, mark the evidence as failed, fix the visible state, capture a
new screenshot, inspect the new image, and only then share it. If bad evidence
was already posted, post a superseding correction that clearly says the earlier
screenshot was invalid.

Before every Daytona display screenshot, run a native-window check and fail fast
if a picker is present:

```bash
daytona exec "$SANDBOX" -- 'bash -lc '\''DISPLAY=:99 wmctrl -l | tee /tmp/windows-before-shot.txt; ! grep -q "Authorize folder" /tmp/windows-before-shot.txt; DISPLAY=:99 .devcontainer/capture-daytona-screenshot.sh --output /daytona-artifacts/screenshots/<flow>/<step>.png'\'''
```

If a Chromium or Electron window is intentionally part of the shot, activate the
right window first with `wmctrl -a "OpenWork - Dev"` or
`wmctrl -a "OpenWork Cloud - Chromium"` so the screenshot shows the intended
journey step.

## Failure Handling

When a step fails:

- Capture current `browser_snapshot` or `document.body.innerText`.
- Capture a screenshot.
- Inspect the relevant logs before retrying.
- Retry only after naming the suspected cause.

Common logs:

```bash
daytona exec "$SANDBOX" -- 'tail -120 /tmp/electron.log'
daytona exec "$SANDBOX" -- 'tail -120 /tmp/vite.log'
daytona exec "$SERVER_SANDBOX" -- 'tail -120 /tmp/den-api.log'
```

For Den Web flows specifically:

- If the page remains on `Checking account`, `Loading your workspace`, or
  `Checking workspace access`, verify whether the client hydrated by trying a
  real `browser_click`/`browser_fill`, not only `browser_eval`.
- If Next dev is behind a Daytona proxy, switch Den Web to `next build` +
  `next start` before declaring the app broken.
- Validate direct Den API auth independently. A direct API pass plus Den Web
  proxy failure is an incomplete handoff, not a full pass.
- If you bridge auth by writing localStorage in Electron, state that explicitly
  in the final report and limit the pass claim to the downstream desktop flow.

## Final Verdict

Use one of these verdicts:

- `Passed`: every expected outcome has an observable assertion and frame-by-frame proof is published.
- `Failed`: at least one assertion disproves the expected outcome.
- `Incomplete`: the sandbox/tooling failed, evidence is missing, or only a recording/screenshot was collected without frame proof.
