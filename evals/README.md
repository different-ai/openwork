# OpenWork UI evals

Human-readable scenarios and coded flows that verify end-to-end OpenWork UI
behavior against a live app.

Each eval should have:
- A short narrative spec written in plain English.
- An **expected outcome** with observable signals.
- A coded flow under [`flows/`](./flows) when it is used for PR evidence or
  repeated regression coverage.

They are not unit tests. They intentionally exercise the running stack
(OpenCode + OpenWork server + React UI) so regressions in wiring — not just
types — get caught.

## Coded flows (programmatic runner)

A growing subset of flows is codified under [`flows/`](./flows) and executed by
the zero-dependency runner in [`runner/`](./runner) with machine-checkable
assertions, poll-until-condition waits (no fixed sleeps), and JSON + markdown
reports with screenshots. The runner also writes a browseable frame-by-frame
`index.html` in each result directory.

```bash
pnpm evals --list                 # show available coded flows
pnpm evals --all                  # run everything runnable
pnpm evals --flow app-smoke       # run one flow
pnpm evals --all --cdp-url http://127.0.0.1:9825   # explicit CDP endpoint
```

### fraimz — the deliverable

Every run writes **`fraimz.html`** to `evals/results/<run-id>/`: the
frame-by-frame proof where each frame binds a **claim**, the **action** the end
user took, the **assertion** that witnesses the side effect, and a validated
**screenshot**. fraimz is the atomic artifact a human looks at to understand the
experience at a glance — it is what we review, and we can fine-tune what each
frame captures over time. (`index.html` is kept as a back-compat alias.)

"Make fraimz for this flow" runs the whole loop — create/pick the eval, drive
it as the end user, validate and repair, output `fraimz.html`. Trigger it with
the `/fraimz` command or:

```bash
pnpm fraimz --flow <id>           # same runner; headline output is fraimz.html
pnpm fraimz --flow core-flow --cdp-url http://127.0.0.1:9825
```

The runner probes `http://127.0.0.1:9825` (Daytona) then `:9823` (local
`pnpm dev`) by default. Flows that need cloud credentials declare
`requiredEnv` and are skipped (not failed) when the env is missing — e.g.
`cloud-signin-handoff` needs `OPENWORK_EVAL_DEN_API_URL` and
`OPENWORK_EVAL_DEN_TOKEN`. Reports land in `evals/results/<run-id>/`
(gitignored). Open `evals/results/<run-id>/index.html` for the frame proof.
A non-zero exit code means at least one flow failed.

### One-command cloud stack

```bash
pnpm evals --all --stack den     # MySQL + schema + den-api + demo seed +
                                 # desktop bootstrap + dev app, then runs flows
pnpm evals --stack-down          # stop what --stack den started
```

`--stack den` is idempotent: each layer (MySQL, schema, den-api, seed, app)
is skipped when already up. It signs in as the seeded demo owner
(`alex@acme.test`) and exports `OPENWORK_EVAL_DEN_API_URL` /
`OPENWORK_EVAL_DEN_TOKEN`, so the env-gated cloud flows run with zero manual
setup. Requires Docker. The MySQL volume survives `--stack-down`, so
subsequent runs skip schema push and seeding.

The markdown specs below remain the source narrative; when codifying a flow,
link the spec via the flow's `spec` field.

## How to run

### Option A: On Daytona (recommended)

Run against a real Electron app in a Daytona cloud sandbox. No local Docker or
display needed. See [`daytona-flows.md`](./daytona-flows.md) for full details.

Quick start:

```bash
daytona organization use "<org-name>"
bash .devcontainer/test-on-daytona.sh [branch-or-commit] --artifacts-volume
pnpm evals --flow app-smoke --cdp-url <printed-electron-cdp-url>
```

### Option B: Local Electron

Start the Electron dev app locally:

```bash
pnpm dev
```

Wait ~15s, then use the browser tools against `http://127.0.0.1:9825`.

### Option C: Manual browser/debugging

Open the app and follow the step lists by hand. Use this for exploration or
debugging only; PR evidence for UI changes should use a coded flow when
possible.

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

- Prefer coded flows in `evals/flows/*.flow.mjs` over ad hoc browser tool calls.
- Declare the demo kind on every new flow: `kind: "user-facing"` (a flow demo
  where the end user is the protagonist) or `kind: "internal"` (an internal
  demo, e.g. perf improvements or invariants). The runner rejects other values
  and flags legacy flows without one in `fraimz.html`.
- Use runner helpers such as `ctx.clickText`, `ctx.fill`, `ctx.waitFor`,
  `ctx.expectText`, `ctx.expectNoText`, `ctx.expectHashIncludes`,
  `ctx.control`, `ctx.prove`, and validated `ctx.screenshot` calls.
- Prefer `ctx.prove("claim", { voiceover, action, assert, screenshot })` for PR
  evidence. It records the claim, voiceover, assertions, screenshot, and
  validation results together so the HTML frame proof explains why each image
  proves the step.
- Every `ctx.prove` should carry a `voiceover`: one or two spoken-style
  sentences narrating what the viewer sees in that frame. `fraimz.html` renders
  it per frame with a play button (Web Speech API) and a per-flow "Play full
  voiceover". Write the voiceover script for the whole demo before coding the
  flow. See `evals/flows/session-search-grouped.flow.mjs` for the reference
  shape.
- Screenshots should include `claim`, `requireText`, `rejectText`, or
  `hashIncludes` whenever possible. A screenshot without an assertion is only a
  visual checkpoint, not proof that the workflow passed.
- Use direct `browser_eval` only for debugging/prototyping or when a flow has
  not yet been codified. If the behavior matters for a PR, codify it before
  calling the UI validation complete.
- For Lexical editors in coded flows, use a synthetic paste/event helper; direct
  DOM manipulation doesn't trigger Lexical state updates.
- For React state injection (e.g., folder picker bypass), use the
  `__reactFiber$` → reducer dispatch pattern documented in `daytona-flows.md`.
- Prefer poll-until-condition waits (`ctx.waitFor`, `ctx.waitForText`) over
  fixed sleeps.
- The runner forces **light mode** by default before every flow runs
  (`ctx.ensureLightMode()`, called automatically in `runner/run.mjs`) so
  screenshot evidence stays readable regardless of the host machine's OS theme.
  A flow that is itself testing theme/dark-mode behavior can opt out with
  `preserveTheme: true` on the flow definition; no current flow needs this.

## Evidence and repair standard

Frame proof is the default for UI evals. The generated `index.html` should show
each step, the claim being proven, assertions, screenshot validation checks, and
supporting images. Treat recordings as supplementary evidence for motion, not as
the primary pass/fail source.

Before reporting a flow as passed:
- Confirm every important user-visible claim has an assertion.
- Confirm every important screenshot has validation metadata and is not just a
  loose gallery image.
- Re-capture or repair evidence if the screenshot is duplicated, missing required
  text, showing an error state, or taken on the wrong route.
- For Daytona display screenshots, also verify no native picker, modal, stale
  dialog, or unrelated desktop window is covering the claimed state.
- If the test used API/localStorage/setup shortcuts, label that evidence as setup
  and resume visible proof at the next user-facing step.

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
- [`cloud-mcp-agent-flows.md`](./cloud-mcp-agent-flows.md) — agent-driven org
  management through the openwork-cloud MCP: org identity, invitations, team
  assignment, and skill sharing via plugins + marketplaces, with server-side
  ground-truth assertions.
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
