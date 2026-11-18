# Headless session control: agents address sessions by id, the UI moves only on request

Status: shipped with `session.send` (this note documents the decision and the remaining follow-ups).

## Symptom

A person orchestrating many sessions from one chat saw the app's active pane jump to
whichever session the orchestrating agent was acting on. Relays were also misrouted:
in one afternoon five messages landed in the wrong session (twice in the orchestrator
itself, once in a session of another workspace, once in a finished session), and
`composer.send` answered `Action is disabled` whenever the visible session was mid-turn.

## Root cause

The only way an agent could talk to an existing session was
`session.open` → `composer.set_text` → `composer.send`, and the composer actions are
focus-bound, not session-bound.

- `apps/app/src/react-app/domains/session/surface/session-surface.tsx` registers
  `composer.set_text`, `composer.send`, and `composer.stop` with
  `useControlAction(props.isControlTarget ? action : null)`; `session-page.tsx` passes
  `isControlTarget={activeWorkbenchPane === "primary" | "secondary"}`. There is one
  registration slot per action id (`registerAction` in
  `shell/control/control-provider.tsx`), so the id resolves to whichever pane is focused
  at execution time. Neither action takes a `sessionId`.
- Therefore the navigation was **incidental, not intrinsic**: the engine can accept a
  prompt for any session (`POST /session/{id}/prompt_async`, already used by
  `session.create` in `apps/server/src/opencode-plugins/openwork-extensions-preview.ts`),
  but no affordance exposed it, so the agent navigated to make the target the focused
  composer.
- Any focus change between `set_text` and `send` re-pointed both actions at the newly
  focused session (`apps/app/tests/control-focus-bound-composer.test.tsx` reproduces
  this deterministically). `composer.send` is also disabled while the visible session's
  `model.transitionState !== "idle"`, which is the `Action is disabled` error.
- `effects.ui` in `packages/types/src/openwork-affordance.ts` is descriptive metadata for
  the model: nothing in `executeAction`/`executeCommand` reads it. It was also untruthful
  for `session.create_task` (declared `ui: none`, opens the new session in the focused
  pane).

## Principle

Control-plane actions are addressed by id and headless by default. A UI change is either
an explicit opt-in on the action (`reveal: true`) or a separate action whose only job is
to show something (`session.open`, `workbench.session.focus`).

The same split exists in comparable products:

- VS Code: `workspace.openTextDocument` / edits work on documents headlessly;
  `window.showTextDocument` is the separate "show it" call and takes `preserveFocus` so
  even showing need not steal focus.
- Cursor Cloud Agents: follow-ups are `POST /v0/agents/{id}/followup` (and
  `POST /v1/agents/{id}/runs`) addressed by agent id; the editor is a view the person
  moves. A busy agent gets a structured `409 agent_busy`, not a UI error.
- Slack apps: `chat.postMessage` posts to a channel id without switching the user's view.
- tmux: `send-keys -t <target>` types into a pane without selecting it.
- OS accessibility APIs act on element references, not on "whatever has focus".

## What changed

- **A. `session.send { sessionId, text, workspaceId?, reveal? }`** — a server-executed
  command (`provider: openwork-server`, same trust as `session.create`) in
  `openwork-extensions-preview.ts`. It resolves the session across workspaces with the
  same ownership check as `session.read`, posts `prompt_async` with a generated
  `messageID`, and returns `{ accepted: true, sessionId, workspaceId, title, messageId }`.
  With `reveal: true` it sends first, then issues one `session.open` through the UI
  mailbox stamped with the requester's `origin`, and reports `revealed`. `effects.ui` is
  `navigate` only when the reveal actually happened.
- **Queue semantics (engine, opencode 1.18.18):** `prompt_async` persists the user message
  and returns 204 immediately (`server/routes/instance/httpapi/handlers/session.ts`
  `promptAsync`, forked). `SessionPrompt.prompt` → `loop` → `SessionRunState.ensureRunning`
  (`effect/runner.ts`): if the session is already running, the call awaits the existing
  run and the running loop picks the new user message up at its next step; nothing is
  rejected or dropped. If no `model` is given, the session's stored model is used.
  `evals/specs/session-send-headless-by-id.test.ts` witnesses this against the real
  engine.
- **B. by-id actions already headless:** `session.rename`, `session.pin`,
  `session.archive` act by id and do not navigate (archive closes the tab only when the
  target is the one on screen). No change needed beyond documentation.
- **C. truthful effects:** `session.create_task` now declares `ui: navigate`;
  `session.open`, `workbench.session.focus` keep `ui: navigate`; `composer.set_text`
  keeps `ui: focus`.
- **D. focus-bound actions say so:** `composer.set_text` / `composer.send` /
  `composer.stop` descriptions state they target the focused composer and point to
  `session.send`; the agent system instruction says the same.

## Attribution

`session.send` does not stamp the requester into the recipient's message: the sender's
own transcript holds the tool call and its result (`messageId`), which is the trail.
Stamping would alter the user-visible text the recipient answers to.

## Follow-ups (not in this change)

- A desktop e2e (`.e2e.test.ts`) that drives the real renderer with three open sessions;
  the PR-lane spec proves the mailbox receives no command, which is the only path by
  which the renderer navigates.
- `session.stop` by id is tracked in #4904 (gated on a product decision about stopping
  another session's work without confirmation).
- `session.read` returning `status`/`working` (#4903) lets an agent decide whether to
  send now or wait.
