# React session flows

End-to-end scenarios that cover the most important UI behaviors introduced
during the React port cutover. Run them before shipping any change that touches:

- `apps/app/src/react-app/shell/session-route.tsx`
- `apps/app/src/react-app/shell/settings-route.tsx`
- `apps/app/src/react-app/domains/session/**`
- `apps/app/src/react-app/domains/settings/**`
- OpenWork server proxy endpoints for `/w/:workspaceId/opencode/session/**`

## Preflight

Before running any eval:

1. Start the Docker dev stack with `packaging/docker/dev-up.sh` and note the
   printed web URL (example: `http://localhost:50423`).
2. Open the web URL in a fresh Chrome DevTools MCP page:
   ```
   chrome-devtools_new_page { url: "http://localhost:50423/session" }
   ```
3. Confirm the footer shows **"OpenWork Ready"**.
4. Check the JS console for errors with
   `chrome-devtools_list_console_messages { types: ["error"] }`. It must be
   empty of `Maximum update depth exceeded` warnings. Any of those means the
   settings route has a re-render loop and every other eval below will be
   unreliable.

---

## Flow 1 — Send a message and observe streaming

**Why**: Streaming uses `ReactSessionRuntime` to subscribe to the OpenCode
event stream and populate the transcript cache. If the subscription isn't
mounted, prompts still submit but the UI shows empty responses until reload.

Steps:
1. Hover the workspace header in the sidebar → click **New task**.
2. Expect: URL becomes `/session/ses_*`, main area heading is **"New session"**.
3. Fill the composer: `"Count from 1 to 5, one number per line with a short sentence about each."`
4. Click **Run task**.
5. Expect: within ~1s, the user bubble appears in the transcript; within
   ~3–5s the assistant bubble appears and text progressively fills in.

Tool recipe:
```
chrome-devtools_take_snapshot
chrome-devtools_hover { uid: <workspace header> }
chrome-devtools_click { uid: <New task> }
chrome-devtools_fill { uid: <composer textbox>, value: "..." }
chrome-devtools_click { uid: <Run task> }
# observe the response filling in
chrome-devtools_take_snapshot
```

Pass criteria:
- The user message renders immediately (not after reload).
- The assistant message renders progressively and becomes non-empty.
- Status bar transitions `Running...` → `Ready`.

Known regressions this catches:
- Missing `<ReactSessionRuntime />` mount in `session-route.tsx`.
- Transcript query keyed on a workspace/session id that doesn't match what
  the runtime publishes to.

---

## Flow 2 — Add a new session

Steps:
1. Hover the workspace header.
2. Click **New task**.

Pass criteria:
- URL changes to `/session/ses_*`.
- Sidebar shows a new **"New session"** entry above existing sessions.
- Main area renders the composer with **"No transcript yet."**.
- Composer model label is whatever is saved as default (e.g.
  `opencode/minimax-m2.5-free`).

Known regressions this catches:
- `onCreateTaskInWorkspace` silently failing because the route has no
  OpenCode client.
- Created session not landing in the sidebar list (sidebar not refreshed
  after create).

---

## Flow 3 — Remove / Flow 8 — Delete a session

Steps:
1. Select the session you want to delete in the sidebar.
2. Click the **Session actions** (overflow `…`) button on the selected row.
3. Click **Delete session** in the popover.
4. Confirm in the dialog by clicking **Delete**.

Pass criteria:
- The dialog closes.
- The session is removed from the sidebar.
- URL returns to `/session` (no session id).
- The main area shows the `session.select_or_create_session` empty state.

Known regressions this catches:
- `onDeleteSession` not wired → menu has no Delete entry.
- Missing server-side `client.deleteSession(workspaceId, sessionId)` call.
- Sidebar not refreshed after delete.

---

## Flow 4 — Rename a session

Steps:
1. Select a session.
2. Click **Session actions** → **Rename session**.
3. In the modal, replace the current name with `"Counting helper"`.
4. Click **Save**.

Pass criteria:
- Modal closes.
- Sidebar label updates to the new name.
- Main-area heading updates to the new name.

Known regressions this catches:
- `onRenameSession` not wired → menu has no Rename entry.
- Missing call to `opencodeClient.session.update({ sessionID, title })`.
- Local state not refreshed, so only the server knows the new title until
  reload.

---

## Flow 5 — Open Connect Providers modal

Steps:
1. Click the **Settings** button in the session footer.
2. On the General tab, click **Connect provider**.

Pass criteria:
- Modal **"Connect providers"** opens.
- It lists at least OpenAI, Anthropic, Github Copilot, Gitlab.
- Closing the modal with **Close** returns focus to the General tab without
  navigating the route.

Known regressions this catches:
- Provider auth store never initialized → modal empty or stuck on spinner.
- Infinite render loop making the modal immediately close itself.

---

## Flow 6 — Select a new default model

Steps:
1. On the General tab click **Change** (under "Model").
2. In the picker, search or scroll to a model in an already-connected
   provider (e.g. `opencode/minimax-m2.5-free`).
3. Click the model card.

Pass criteria:
- Modal closes.
- Under "Model" the label changes from `session.default_model` (or the
  previous model) to the new model id.
- If you open a new session afterward, the composer's model label reflects
  the new default.

Known regressions this catches:
- Missing wiring of `ModelPickerModal`.
- Model list empty because `opencodeClient.config.providers` call was not
  made or was filtered too aggressively.
- Infinite loop caused by `refreshProviders()` inside a `useEffect` whose
  deps include `providerConnectedIds` (see changelog in
  `84286ebe fix(react-app/settings): break infinite loop…`).

---

## Flow 7 — Toggle thinking mode (Show model reasoning)

Steps:
1. On the General tab, click the **Off/On** button next to "Show model
   reasoning".

Pass criteria:
- Button state flips (Off → On or On → Off) instantly without a spinner.
- Reloading the page preserves the new state.

Known regressions this catches:
- `local.prefs.showThinking` not persisted to IndexedDB / localStorage.

---

## Flow 9 — Navigate every settings tab, close, then create a session

This is the full navigation smoke test. If any tab content fails to render
it's almost always the infinite-render loop (tab button highlights but body
stays on General).

Steps:
1. From `/session`, click the footer **Settings** button. URL becomes
   `/settings/general`.
2. Click each workspace tab in order:
   `Settings → Skills → Extensions → Messaging → Advanced`.
3. Click each global tab in order:
   `Cloud → Appearance → Updates → Recovery`.
4. Click the **X Close settings** button in the header.
5. Back on `/session`, hover workspace → click **New task**.

Pass criteria for each tab click:
- URL updates to `/settings/<tab>`.
- Heading (level 1 *and* level 2) updates to the tab name.
- Tab body content matches the tab (e.g. Skills shows hub list,
  Extensions shows integrations, Advanced shows runtime status, etc.).
- Close settings returns to `/session` and re-renders the session shell,
  not a stale settings DOM.

Known regressions this catches:
- Infinite render loop — the URL updates but body stays on General.
- `Routes key={location.pathname}` accidentally reintroduced, which
  unmounts/remounts routes and breaks fast transitions.
- Tab click dispatches but `parseSettingsPath` returns `general` because it
  doesn't recognize new segments.

---

---

## Flow 10 — Keyboard: Cmd+N creates a new session

**Why**: `Cmd/Ctrl+N` is the direct shortcut to create a session in the
currently selected workspace (distinct from `Cmd+K` which opens the palette).

Steps:
1. From the session view with a workspace selected, press `Cmd+N` (macOS) or
   `Ctrl+N` (elsewhere) while focus is **not** in the composer.

Pass criteria:
- URL changes to `/session/ses_*`.
- New "New session" row appears at the top of the sidebar.
- Composer is visible and ready.

Known regressions this catches:
- Shortcut handler missing from `session-route.tsx`.
- Handler short-circuited because focus was on an `<input>` / contentEditable.

---

## Flow 11 — Command palette (Cmd+K)

**Why**: The palette is the cross-surface quick switcher — create sessions,
jump between workspaces/sessions, and open settings without leaving
keyboard context.

Steps:
1. Press `Cmd+K` (or `Ctrl+K`).
2. Expect: overlay appears with "Create new session", "Search sessions",
   "Settings", plus an input at the top and the hint
   "Arrow keys to navigate · Enter to run · Esc to close".
3. Press `ArrowDown`, then `Enter`, to enter the **Sessions** sub-mode.
4. Expect: flat list of every session in every workspace, active workspace
   first. Each row shows session title, workspace title, and a
   `CURRENT WORKSPACE` / `SWITCH` badge.
5. Press `Esc`. Expect: sub-mode returns to root (not fully closed).
6. Press `Esc` again. Expect: overlay closes.

Pass criteria:
- Palette opens on `Cmd+K`, closes on `Cmd+K` or `Esc`.
- "Create new session" → creates a session in the selected workspace and
  closes the palette.
- "Search sessions" row → swaps to sessions mode.
- "Settings" row → navigates to `/settings/general` and closes.

Known regressions this catches:
- Palette missing from the port (we hit this once: the Solid palette in
  `apps/app/src/app/session/react-session-command-palette*.tsx` had been
  deleted with the Solid tree and never re-ported).
- `Cmd+K` bound to the wrong handler (e.g. browser default "search").
- Sessions list empty because `workspaceSessionGroups` isn't wired.

---

## Flow 12 — Workspace options menu (Edit name / Share / Reveal / Remove)

**Why**: The workspace row in the sidebar has an overflow menu (`…`) for
renaming, sharing, revealing the folder, and removing the workspace.
Post-cutover, all four handlers were stubs.

Steps:
1. In the sidebar, click the `…` button on the selected workspace row.
2. Expect: popover opens with **Edit name**, **Share…**, **Reveal in Finder**
   (desktop only), **Remove workspace**.
3. Click **Edit name** → modal appears with current name selected.
4. Type a new name and click **Save**.
   - Pass: sidebar label and main header update immediately.
5. Open the menu again → **Reveal in Finder**.
   - Pass: Finder becomes frontmost with the workspace folder highlighted
     (desktop only; no-op on web).
6. Open the menu again → **Share…**.
   - Pass: workspace path is copied to the clipboard. (Full ShareWorkspaceModal
     flow is still pending a second pass — see change log.)
7. Open the menu again → **Remove workspace**.
   - Pass: workspace disappears from the sidebar; `workspace_bootstrap`
     returns the remaining workspaces.

Known regressions this catches:
- Handlers stubbed out as `() => {}` in `session-route.tsx` / `settings-route.tsx`.
- `workspaceUpdateDisplayName` IPC missing from `apps/app/src/app/lib/tauri.ts`.
- `revealItemInDir` import broken (wrong package or dynamic import failing on web).

---

## Desktop (Tauri) specifics

The same evals run against the Tauri desktop app (`pnpm dev`). Use the shared
`evals/desktop-runner.md` (companion doc) for the AppleScript + cliclick
runner. Key differences:

- Focus-within reveals the `+` and `…` buttons on every workspace row, not just
  on hover. Clicking the row first (or pressing Tab) ensures they're
  reachable; on the selected workspace they stay visible continuously.
- The Tauri window chrome offsets screen coords by the window's `(X, Y)` and
  the OS titlebar. The helper script must re-query `position of first window`
  on every interaction.
- macOS screencapture produces a **point-space** PNG (same dimensions as
  window points), not a Retina 2x image. Don't divide coordinates by 2 when
  converting image pixels back to screen points.

---

## Tips for an LLM runner

- Always start with `chrome-devtools_take_snapshot` after each interaction.
  Never trust that a click "worked" — re-snapshot and verify the new `uid`s.
- When text you're waiting for might also match a sidebar button, pass a
  longer, more specific phrase to `chrome-devtools_wait_for` (e.g.
  `"Browse skill surfaces"` instead of `"Skills"`).
- If a single flow fails, immediately run
  `chrome-devtools_list_console_messages { types: ["error"], pageSize: 5 }`.
  A `Maximum update depth exceeded` error invalidates the rest of the
  session — reload and reproduce with a narrower repro before continuing.
- For Flow 1 streaming, don't insist on exact assistant text. Confirm the
  assistant bubble becomes non-empty and status returns to `Ready`.

---

## Flow 13 — Slash command selection and backspace

**Why**: The slash menu used to cause render churn and RAM growth from
unstable regex dependencies and uncached command fetches.

Steps:
1. Create a new session.
2. Type `/rev` in the composer.
3. Expect: slash menu opens with `/review` as the top fuzzy match.
4. Click `/review`.
5. Expect: composer shows `/review` chip (purple pill) + trailing space;
   slash menu closes.
6. Press Backspace once.
7. Expect: the entire `/review` chip is removed atomically (not one char at
   a time). Composer is empty.

Pass criteria:
- Menu items don't flicker or reset while typing.
- One backspace removes the chip + space together.
- No console errors or `react.render_loop_suspected` watchdog warnings.

---

## Flow 14 — Slash command error with model recovery

**Why**: When a slash command fails (e.g. model not found), the error must
show inline in the session area with a recovery action — not as raw
`[object Object]` below the composer.

Steps:
1. Create a new session.
2. Type `/init`, select it, click Run task.
3. If the command's configured model is unavailable, expect: an inline error
   card appears in the session area with a human-readable message like
   "Model openai/gpt-5.2-codex is not available."
4. Expect: a "Change model" button is visible on the error card.
5. Click "Change model".
6. Expect: the model picker opens. Select a valid model.
7. Composer should be cleared and editable (not stuck readonly).

Pass criteria:
- Error renders inline in the session (not below the composer).
- Error message is human-readable (no `[object Object]`).
- "Change model" opens the picker (not sets the failed model as default).
- Composer resets on error.

---

## Flow 15 — Paste chip collapse

**Why**: Pasting large text (3+ lines or 200+ chars) should collapse into an
inline amber chip in the composer instead of flooding the editor.

Steps:
1. Create a new session.
2. Copy a multi-line code snippet (10+ lines) to the system clipboard.
3. Paste into the composer (Cmd+V).
4. Expect: an amber "Pasted · N lines" chip appears inline in the composer
   instead of the raw text.
5. Type `explain this code:` before the chip.
6. Click Run task.
7. Expect: the user message in the transcript shows the full expanded text
   (not the `[pasted text ...]` placeholder).
8. The assistant response should reference the pasted code correctly.

Pass criteria:
- Text over threshold collapses into a chip in the composer.
- Short pastes (< 3 lines, < 200 chars) go in as plain text.
- `resolvedText` sent to the model contains the full pasted content.
- User message in the transcript shows the full text, not the placeholder.

Note: CDP `Meta+V` does not trigger real clipboard events in Electron; use
osascript (`pbcopy` + `keystroke "v" using command down`) to test paste.

---

## Flow 16 — User message display

**Why**: Hand-typed user messages must never be truncated in the transcript.
Only pasted chip placeholders should render as collapsible.

Steps:
1. Send a long message (10+ lines of hand-typed text).
2. Expect: the full message renders in the user bubble without truncation or
   "expand" chips.

Pass criteria:
- No `CollapsibleUserText` or "N lines · expand" button on hand-typed text.
- The full message is visible immediately without clicking.

---

## Flow 17 — Stop / Run task single button

**Why**: The composer should have a single action button that toggles between
"Run task" (idle or has draft while busy) and "Stop" (busy with no draft).

Steps:
1. Send a message that triggers a long response.
2. Expect: the button label changes from "Run task" to "Stop" while
   the assistant is streaming.
3. Once the response finishes, expect: button returns to "Run task".
4. While streaming, type text into the composer.
5. Expect: button shows "Run task" (to queue the follow-up), not "Stop".

Pass criteria:
- Only one button visible at any time (no side-by-side Stop + Run task).
- Button label toggles based on busy state and draft content.

---

## Flow 18 — Skill lifecycle (create, verify, use)

**Why**: Skills should be createable from the UI, appear on disk, and be
usable in new sessions after reload.

Steps:
1. Go to Settings → Skills.
2. Click "Create skill in chat".
3. Expect: navigates to a new session.
4. Type `/skill-creator create a skill about weather alerts`.
5. Select the command and run it.
6. Expect: the assistant creates `.opencode/skills/weather-alerts/SKILL.md`
   (requires a model with tool-use capability).
7. Verify the file exists on disk.
8. Reload the app (or trigger config reload).
9. Create a new session and check that `/weather-alerts` appears in the
   slash command list.
10. Run `/weather-alerts` and expect the skill template is used.

Pass criteria:
- "Create skill in chat" navigates away from settings to a session.
- The skill command actually writes files to `.opencode/skills/`.
- After reload, the new skill appears in the slash menu.
- Running the new skill uses its template as the user message.

Note: requires a model with tool-use support (e.g. Claude, GPT-4). Free-tier
models may describe what they would do without actually calling tools.

---

## Flow 19 — Add workspace button placement

**Why**: The "Add workspace" button must not clip against the Tauri/Electron
window bottom corners.

Steps:
1. Look at the sidebar bottom.
2. Expect: the "Add workspace" button has visible padding below it, above the
   footer bar.

Pass criteria:
- At least 16px gap between the button bottom edge and the window edge.

---

## Change log

- 2026-04-16 — initial doc after the React port cutover fixed streaming,
  session CRUD, the model picker, and the settings tab infinite loop.
- 2026-04-17 — added Flow 10 (Cmd+N new session), Flow 11 (Cmd+K command
  palette), Flow 12 (workspace options menu). Also added the desktop-runtime
  boot hook and restored 17 missing i18n keys that were leaking as raw
  identifiers in the UI.
- 2026-04-28 — added Flows 13-19: slash command stability, error recovery
  with model change, paste chip collapse, user message display, single action
  button, skill lifecycle, and workspace button placement.
