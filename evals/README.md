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

## Coded flows (programmatic runner)

A growing subset of flows is codified under [`flows/`](./flows) and executed by
the zero-dependency runner in [`runner/`](./runner) with machine-checkable
assertions, poll-until-condition waits (no fixed sleeps), and JSON + markdown
reports with screenshots.

```bash
pnpm evals --list                 # show available coded flows
pnpm evals --all                  # run everything runnable
pnpm evals --flow app-smoke       # run one flow
pnpm evals --all --cdp-url http://127.0.0.1:9825   # explicit CDP endpoint
```

The runner probes `http://127.0.0.1:9825` (Daytona) then `:9823` (local
`pnpm dev`) by default. Flows that need cloud credentials declare
`requiredEnv` and are skipped (not failed) when the env is missing — e.g.
`cloud-signin-handoff` needs `OPENWORK_EVAL_DEN_API_URL` and
`OPENWORK_EVAL_DEN_TOKEN`. Reports land in `evals/results/<run-id>/`
(gitignored). A non-zero exit code means at least one flow failed.

The markdown specs below remain the source narrative; when codifying a flow,
link the spec via the flow's `spec` field.

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

Evals use the CDP browser tools provided by the `opencode-chrome-devtools`
plugin (configured in `.opencode/opencode.json`). Every tool takes
`browser_url` as the first argument.

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
- [`cloud-auth-flows.md`](./cloud-auth-flows.md) — desktop cloud sign-in
  (browser handoff + paste-code), expired grants, sign-out cleanup, and org
  switching.
- [`cloud-provider-sync-flows.md`](./cloud-provider-sync-flows.md) — org LLM
  provider import, update, delete, refresh timing, and permission boundaries.
- [`cloud-marketplace-sync-flows.md`](./cloud-marketplace-sync-flows.md) —
  marketplace plugin import/update/removal sync between Den and the desktop.
- [`cloud-org-membership-flows.md`](./cloud-org-membership-flows.md) — org
  invitations, role updates, member removal, and domain restrictions.
- [`cloud-worker-flows.md`](./cloud-worker-flows.md) — legacy cloud worker
  launch/connect flows (feature being sunset; kept for regression context).
- [`daytona-server-failure-recovery-flows.md`](./daytona-server-failure-recovery-flows.md)
  — Den API/Web/proxy/MySQL outage and recovery behavior.
- [`default-openwork-marketplace-onboarding-flow.md`](./default-openwork-marketplace-onboarding-flow.md)
  — default Marketplace provisioning funnel from sign-in to chat handoff.
- [`den-marketplace-guided-onboarding-flow.md`](./den-marketplace-guided-onboarding-flow.md)
  — guided browser + desktop marketplace onboarding with pass criteria.
