# Openable items eval

End-to-end coverage for session-derived openable items: inline provenance chips,
command-palette inventory, server-verified artifact previews, localhost browser
targets, and stop-tracking persistence.

## Preflight

1. Start the Electron dev app from the repo root:
   ```bash
   OPENWORK_ELECTRON_REMOTE_DEBUG_PORT=9823 pnpm dev:electron
   ```
2. Attach browser tools to `http://127.0.0.1:9823` and select the OpenWork target.
3. Open or create a local workspace with permission to write files and run a local server.
4. Keep every screenshot path returned by `browser_screenshot`; visually inspect each PNG before reporting pass/fail.

## Flow 1 — Inline Chips And Command Palette

**Why**: Openable items should be discoverable where the assistant introduced
them, while the full inventory lives in Cmd/Ctrl+K instead of the artifact pane.

Steps:

1. Create a new task.
2. Send this prompt:
   `Create reports/openable-items-eval.csv with three rows of sample revenue data, reports/openable-items-eval.xlsx with the same data, reports/openable-items-eval.md summarizing it, and reports/openable-items-eval.html with a tiny HTML preview. Then start a local preview server and mention the app root URL http://localhost:<port>, one /api/health URL, and one ws://localhost:<port>/socket hint when done.`
3. Wait until the status bar returns to `Ready`.
4. Capture a screenshot of the transcript area.
5. Open Cmd/Ctrl+K, choose `Accessible items`, and capture a screenshot of the command palette list.

Expected:

- The assistant message that mentions the files/URLs has an `Openable items` strip directly below it.
- The strip includes Chrome-style icons for localhost/browser targets.
- The strip includes an XLS/spreadsheet icon for `.csv`, `.xlsx`, `.xls`, `.ods` targets.
- The strip includes an `MD` badge for `.md`/Markdown targets.
- Cmd/Ctrl+K has a root `Accessible items` command.
- The `Accessible items` palette mode lists the localhost server target and server-verified artifact targets.
- Generic project files such as `package.json` do not appear.
- Missing files do not appear.
- The right artifact pane is not used as the full inventory.

Browser tool recipe:

```text
browser_snapshot({ browser_url, target_id })
browser_click({ browser_url, target_id, uid: <New task> })
browser_fill({ browser_url, target_id, uid: <composer>, value: <prompt> })
browser_click({ browser_url, target_id, uid: <Run task> })
browser_eval({ browser_url, target_id, expression: "new Promise((resolve) => setTimeout(() => resolve(document.body.innerText), 90000))" })
browser_screenshot({ browser_url, target_id })
browser_eval({ browser_url, target_id, expression: "window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', metaKey: /Mac/i.test(navigator.platform), ctrlKey: !/Mac/i.test(navigator.platform), bubbles: true }))" })
browser_snapshot({ browser_url, target_id })
browser_click({ browser_url, target_id, uid: <Accessible items command> })
browser_screenshot({ browser_url, target_id })
```

## Flow 2 — Open Browser Target

Steps:

1. In Cmd/Ctrl+K → `Accessible items`, choose the app-root `http://localhost:<port>` row.
2. Capture a screenshot of the right pane.

Expected:

- The Browser pane opens.
- The active browser tab is the app root URL, not `/api/health` and not the raw `ws://` socket URL.
- Browser rows use the Chrome icon in the command palette and inline strip.

## Flow 3 — Open Artifact Targets

Steps:

1. In Cmd/Ctrl+K → `Accessible items`, choose `openable-items-eval.csv`.
2. Capture a screenshot of the artifact pane.
3. Choose `openable-items-eval.md` from Cmd/Ctrl+K → `Accessible items`.
4. Capture a screenshot of the artifact pane.

Expected:

- The CSV opens in the spreadsheet editor.
- CSV/XLS/XLSX/ODS targets use an XLS/spreadsheet icon.
- Markdown opens directly in the text editor and uses an `MD` badge.
- The artifact pane shows viewer/editor controls only; it is not the all-items discovery inventory.
- The artifact rail button count reflects server-verified artifact files only, not localhost URLs.

## Flow 4 — Stop Tracking

Steps:

1. Open Cmd/Ctrl+K → `Accessible items`.
2. Choose `Stop tracking openable-items-eval.md`.
3. Open Cmd/Ctrl+K → `Accessible items` again and capture a screenshot.
4. Reload the app/session and open Cmd/Ctrl+K → `Accessible items` again.
5. Capture another screenshot.

Expected:

- The Markdown artifact disappears from the command-palette inventory and inline access surfaces after `Stop tracking`.
- The hidden choice persists after reload for the same workspace/session.
- Other server/browser targets remain visible.

## Required Evidence

Attach or report the screenshot paths for:

1. Inline `Openable items` strip after the assistant message.
2. Cmd/Ctrl+K `Accessible items` list.
3. Browser pane opened from a localhost target.
4. Artifact pane opened from a CSV/XLS target.
5. Artifact pane opened from a Markdown target.
6. Cmd/Ctrl+K list after `Stop tracking` and after reload.

Before reporting success, open each PNG and verify the visible UI matches the
expected bullets above. Do not claim screenshot coverage from file creation
alone.
