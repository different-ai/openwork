---
name: browser-automation
description: Local OpenWork Electron browser automation with CDP. Use when driving a local Electron dev app, browser_list, browser_snapshot, browser_eval, composer automation, or local UI smoke tests.
---

# Browser Automation

## What I Do

- Attach OpenCode browser tools to the OpenWork Electron app during local development.
- Drive the app UI through Electron's Chrome DevTools Protocol endpoint.
- Send a task/session from the composer and confirm the response in the UI.

## Local Dev Setup

`pnpm dev` enables Electron CDP by default:

```sh
OPENWORK_ELECTRON_REMOTE_DEBUG_PORT=${OPENWORK_ELECTRON_REMOTE_DEBUG_PORT:-9823}
```

The default browser URL for OpenCode browser tools is:

```text
http://127.0.0.1:9823
```

The app UI normally loads at:

```text
http://localhost:5173/
```

To use a different CDP port, launch with an override:

```sh
OPENWORK_ELECTRON_REMOTE_DEBUG_PORT=9830 pnpm dev
```

To disable Electron CDP for a run:

```sh
OPENWORK_ELECTRON_REMOTE_DEBUG_PORT=0 pnpm dev
```

## Background Launch

Use a detached launch when the user wants the app running in the background:

```sh
nohup pnpm dev > /var/folders/d9/xqhkvsp94rg0n0n523snqztm0000gn/T/opencode/openwork-dev.log 2>&1 &
```

Then wait for the CDP port:

```sh
lsof -nP -iTCP:9823 -sTCP:LISTEN
```

## Browser Tool Flow

1. List targets with `browser_list` using `browser_url: "http://127.0.0.1:9823"`.
2. Select the `OpenWork` target ID.
3. Read state with `browser_eval` or `browser_snapshot`.
4. Fill the Lexical composer by targeting `[contenteditable="true"][data-lexical-editor="true"]`.
5. Click the `Run task` button.
6. Confirm the session response by checking `document.body.innerText` or the current URL.

## Send A Session

Use this `browser_eval` pattern after selecting the OpenWork target:

```js
(() => {
  const editor = document.querySelector('[contenteditable="true"][data-lexical-editor="true"]');
  if (!editor) return { ok: false, reason: 'editor not found' };

  editor.focus();
  const data = new DataTransfer();
  data.setData('text/plain', 'Say hello from the Electron browser test.');
  editor.dispatchEvent(new ClipboardEvent('paste', {
    bubbles: true,
    cancelable: true,
    clipboardData: data,
  }));

  const run = Array.from(document.querySelectorAll('button'))
    .find((button) => button.innerText.trim() === 'Run task');
  if (!run) return { ok: false, reason: 'Run task not found', inserted };
  if (run.disabled) return { ok: false, reason: 'Run task disabled', inserted, text: editor.innerText };

  run.click();
  return { ok: true, inserted: true, text: editor.innerText };
})()
```

## Notes

- Electron CDP is used for development test tooling. User browser tasks should use the built-in OpenWork Browser target.
- A successful local attach should show an `OpenWork` target at `http://127.0.0.1:9823`.
- The known-good smoke prompt is `Say hello from the Electron browser test.` and the expected response is `Hello from the Electron browser test.`
