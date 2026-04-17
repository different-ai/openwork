# React session flows

Nine end-to-end scenarios that cover the most important UI behaviors introduced
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
   `Settings → Automations → Skills → Extensions → Messaging → Advanced`.
3. Click each global tab in order:
   `Cloud → Appearance → Updates → Recovery`.
4. Click the **X Close settings** button in the header.
5. Back on `/session`, hover workspace → click **New task**.

Pass criteria for each tab click:
- URL updates to `/settings/<tab>`.
- Heading (level 1 *and* level 2) updates to the tab name.
- Tab body content matches the tab (e.g. Automations lists templates,
  Skills shows hub list, Advanced shows runtime status, etc.).
- Close settings returns to `/session` and re-renders the session shell,
  not a stale settings DOM.

Known regressions this catches:
- Infinite render loop — the URL updates but body stays on General.
- `Routes key={location.pathname}` accidentally reintroduced, which
  unmounts/remounts routes and breaks fast transitions.
- Tab click dispatches but `parseSettingsPath` returns `general` because it
  doesn't recognize new segments.

---

## Tips for an LLM runner

- Always start with `chrome-devtools_take_snapshot` after each interaction.
  Never trust that a click "worked" — re-snapshot and verify the new `uid`s.
- When text you're waiting for might also match a sidebar button, pass a
  longer, more specific phrase to `chrome-devtools_wait_for` (e.g.
  `"Create and manage scheduled automations"` instead of `"Automations"`).
- If a single flow fails, immediately run
  `chrome-devtools_list_console_messages { types: ["error"], pageSize: 5 }`.
  A `Maximum update depth exceeded` error invalidates the rest of the
  session — reload and reproduce with a narrower repro before continuing.
- For Flow 1 streaming, don't insist on exact assistant text. Confirm the
  assistant bubble becomes non-empty and status returns to `Ready`.

## Change log

- 2026-04-16 — initial doc after the React port cutover fixed streaming,
  session CRUD, the model picker, and the settings tab infinite loop.
