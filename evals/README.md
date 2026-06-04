# OpenWork UI evals

Human-readable scenarios that an LLM (or a person) can replay against a live
OpenWork instance to verify end-to-end behavior of the UI.

Each eval is:
- A short list of steps written in plain English.
- An **expected outcome** with observable signals.
- The CDP browser tool calls to drive it.

They are not unit tests. They intentionally exercise the running stack
(OpenCode + OpenWork server + React UI) so regressions in wiring — not just
types — get caught.

## How to run

### Option A: On Daytona (recommended)

Run against a real Electron app in a Daytona cloud sandbox. No local Docker or
display needed. See [`daytona-flows.md`](./daytona-flows.md) for full details.

Quick start:

```bash
daytona organization use "Different AI"
bash .devcontainer/test-on-daytona.sh [branch-or-commit]
# Use the printed Electron CDP URL with browser_* tools.
```

### Option B: Local Electron

Start the Electron dev app locally:

```bash
pnpm dev
```

Wait ~15s, then use the browser tools against `http://127.0.0.1:9825`.

### Option C: Manual browser

Open the app and follow the step lists by hand.

## Tool reference

Evals use the OpenCode browser tools (`.opencode/tools/browser.ts`). Every tool
takes `browser_url` as the first argument.

| Tool | Description |
|------|-------------|
| `browser_list` | List page targets on the CDP endpoint |
| `browser_navigate` | Navigate a target to a URL |
| `browser_snapshot` | Accessibility tree with UIDs |
| `browser_click` | Click by snapshot UID |
| `browser_fill` | Fill input by snapshot UID |
| `browser_eval` | Run JS in the page |
| `browser_screenshot` | Capture PNG |

## Conventions

- Use `browser_eval` for button clicks and text input — it's more reliable
  than snapshot UIDs for dynamic React UIs.
- For Lexical editors, use `document.execCommand('insertText', false, text)`
  after focusing. Direct DOM manipulation doesn't trigger Lexical state updates.
- For React state injection (e.g., folder picker bypass), use the
  `__reactFiber$` → reducer dispatch pattern documented in `daytona-flows.md`.
- When asked to "wait for X", use `sleep` then `browser_eval` to check.

## Files

- [`daytona-flows.md`](./daytona-flows.md) — Daytona sandbox flows (workspace
  creation, session messaging, screenshot verification).
- [`react-session-flows.md`](./react-session-flows.md) — core
  session/settings flows verified during the React port cutover, including
  long streaming interruption coverage.
- [`openable-items-flow.md`](./openable-items-flow.md) — inline openable-item
  chips, Cmd/Ctrl+K inventory, artifact/browser opening, icon checks, and
  screenshot evidence requirements.
- [`reload-events-flow.md`](./reload-events-flow.md) — reload-required toast
  suppression on boot/no-op writes and positive coverage for real runtime config
  changes.
- [`onboarding-welcome-flows.md`](./onboarding-welcome-flows.md) — the 7
  onboarding/welcome flows covering first-run experience and folder
  explanation.
- [`browser-extension-flows.md`](./browser-extension-flows.md) — browser
  extension plugin loading, built-in browser navigation, composer extensions
  menu, extension toggle, and stale MCP migration.
- [`extensions-marketplace-flows.md`](./extensions-marketplace-flows.md) —
  extension runtime and marketplace install/remove/search/filter flows.
- [`desktop-policy-extension-flows.md`](./desktop-policy-extension-flows.md) —
  admin-to-member extension policy flows for disabling and restoring built-in
  extensions.
- [`cloud-admin-to-member-assignment-flows.md`](./cloud-admin-to-member-assignment-flows.md)
  — admin assigns providers/policies to a member, member desktop receives and
  uses them, then removal restores/cleans up UI state.
- [`cloud-signin-client-provisioning-funnel.md`](./cloud-signin-client-provisioning-funnel.md)
  — founder funnel from website sign-in to provisioning skills/plugins/providers
  and validating the capability appears and produces value in the desktop client.
- [`workspace-layout-state-flows.md`](./workspace-layout-state-flows.md) —
  persisted sidebar/browser layout, legacy layout migration, and workspace-safe
  layout state.
- [`environment-variable-flows.md`](./environment-variable-flows.md) — local
  environment variable CRUD, masking, validation, apply/restart behavior, and
  remote-workspace secret boundaries.
