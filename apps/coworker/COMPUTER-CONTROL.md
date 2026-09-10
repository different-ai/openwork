# Give a coworker a computer for its task

## Product decision

Computer control belongs to a saved private discussion, not to the coworker's
whole workspace. A person chooses a computer and explicitly enables app access
for requested tasks in that discussion. Each admitted open is scoped to one
eligible app/window: a single window opens automatically; multiple windows
require the person's selection in the embedded Computer view. Setup, permission,
task execution, and observed task completion are four different states.

The first implementation supplies **This Mac**, using the shared
`@openwork/computer-use` runtime. When present in the target list, an unavailable
**Remote computer** appears only as a disabled chooser option. There is no
automatic provisioning and no remote-to-local fallback. This is a development
candidate, not a release claim.

### The experience

1. Open the **Computer** icon in a saved discussion's right panel icon strip.
   New discussions start off.
2. Review the selected computer and **This computer** / **Remote** placement in
   the details popover. **Set up permissions** opens an in-app Coworker guide,
   not the generic OpenWork setup window. Accessibility and Screen Recording
   show separate results from the bundled helper's fresh `--check` probe. Failed
   checks are unverified, not granted. The guide rechecks while open, on return
   to the app, and through **Check permissions**. Granting macOS permissions
   does not enable the discussion.
3. Choose **Enable for this discussion**, then ask for the task normally.
4. The coworker discovers available app identities and asks for a scoped session.
   The broker validates the exact admitted app, mode, purpose and ownership
   before opening a single eligible window or accepting a multiple-window choice.
5. The watch-only floating Computer view shows the selected window, recent frames,
   input feedback, Take over, Continue and Stop. Healthy enabled access uses a discreet green dot on the
   Computer icon, not a persistent composer banner. The accessible name describes
   the discussion allowance; the tooltip includes the observed session phase.
   Access alone does not mean work is running. The details popover retains the
   selected computer, approved app/window, and native session state.
   `ComputerControl`'s optional `statusSlot: HTMLElement | null` shows an exception
   strip only when enabled access, a session, or pending cleanup also needs
   attention: a failed read/action, unavailable session status, or unconfirmed
   cleanup. These states use an amber icon warning instead of the green dot.
   A failed read labels the state as last known, not stopped.
6. Open the Computer icon for **Stop & revoke**; it is also directly available
   in the exception strip. It disables the discussion and awaits session release.
   Unknown release remains visibly pending. A later target cannot borrow that
   lease. Confirmed off state removes the dot and strip; without a status slot,
   the icon and popover still expose status and revocation.

The strip points to the embedded Computer view for **Take over** and **Continue**.
These explicit controls reach the native session through scoped host notifications.
Paused tools wait for the person
within a bounded execution; the model cannot resume them or repeat an interrupted
action automatically. The popover remains the setup and review surface. Neither
setup surface grants macOS permissions by itself. The floating view shows recent
redacted window frames, separate from actionable model observations; it never
forwards the person's clicks or typing. Pointer markers identify actual input,
not verified results or the person's live cursor. Minimizing the view, hiding
Coworker or switching discussions stops preview capture, not work or access.
Native menu-bar Take over, Continue and Stop remain available.

The guide's settings buttons run `ComputerUse permissions accessibility` or
`ComputerUse permissions screenRecording` as a direct child, keeping the same
responsible-app context as the probe and MCP session. Only this explicit action
requests the corresponding macOS permission and opens its System Settings pane.
It starts no control session. System Settings opening is not proof of permission;
Coworker waits for a new probe. The native generic `setup` command remains for
other clients. Native permissions, window-scope checks and human-only continuation
remain required. Enabling Computer does not authorize purchases, sending messages,
deleting files or other sensitive actions.

The guide names the shared **OpenWork Computer Use** helper, the possible
responsible **Open Coworker** entry, version-dependent macOS pane naming and
quit/reopen expectations. It distinguishes system-wide OS permissions from
discussion opt-in and window-scoped consent, discloses model-bound observations,
and explains that closing the guide is not Stop and revocation does not remove
macOS permissions.

Leaving the discussion stops its UI observer, not its work. A completed turn
closes its native session; discussion opt-in can remain until revoked or the app
restarts. A later turn needs its own validated, scoped app/window open. Native
Stop revokes discussion opt-in when observed, including during cleanup.

## Reuse, not another computer runtime

The local adapter launches the same native helper used by OpenWork. It inherits
window-only capture, protected-field omission, freshness checks, at-most-once
dispatch receipts, app identity checks, exclusive control, native permissions,
human-only continuation, idle/expiry limits, and the menu-bar controls.

Coworker uses the helper's `mcp-coworker-hosted` embedded presentation mode,
separate from `mcp-hosted` automatic interruption recovery. Standalone clients
retain their native approval UI. The `move` action
delivers window-scoped hover in control mode using a fresh screenshot; it does
not promise to move the global Mac cursor.

No native Swift code is copied. The six native tools stay behind a dedicated
connection owned by the trusted Coworker broker. They are not installed as an
unrestricted workspace MCP. No additional model loop or provider credential is
introduced.

| Layer | Owner |
|---|---|
| Compact discussion UI, watch view and typed IPC | `src/ui/computer-control.tsx`, `src/ui/computer-panel.tsx`, `src/lib/bridge.ts` |
| Ephemeral opt-in, target pinning, receipts and cleanup | `electron/computer-control.mjs` |
| Engine-native tool identity and image attachment delivery | `electron/computer-plugin.mjs` |
| Native helper discovery, readiness, dedicated MCP lifetime | `electron/computer-local.mjs` |
| Admission, turn cancellation and terminal cleanup | `electron/main.mjs`, `electron/collaboration.mjs` |
| Consent, observation, input and takeover | `../../packages/computer-use` |

The broker checks the saved discussion, pinned workspace/directory, actual active
execution, user-message parent, running tool name, native call ID and exact input.
Model arguments cannot select a coworker, native session, transport command,
credential, endpoint or dispatch receipt identity. Renderer setup/configuration
is restricted to the actual main app frame at the expected renderer URL.

This is not an OS sandbox: workspace-readable plugin descriptors are not an
unforgeable boundary against arbitrary code running as the same OS user, and
approval to use an app does not authorize every consequential action inside it.
Dedicated integrations/browser controls remain preferable when sufficient.

## Adapter strategy

`createComputerControl({ adapters, discussionFor, resolveContext })` accepts
trusted main-process dependencies. Each adapter declares:

```ts
type ComputerAdapter = {
  id: string;                  // Stable, unique target identity.
  label: string;
  placement: "desktop" | "cloud";
  protocol: "openwork.computer-use/1";
  readiness(): Promise<{
    readiness: "ready" | "setup-required" | "unsupported" | "unavailable";
    detail: string;
    permissions?: { accessibility: boolean; screenRecording: boolean };
  }>;
  setup(permission: "accessibility" | "screenRecording"): Promise<void>;
  connect(): Promise<{
    callTool(name: string, args: Record<string, unknown>, options?: {
      signal?: AbortSignal;
      timeoutMs?: number;
    }): Promise<unknown>;       // MCP content/error envelope, including images.
    close(): Promise<void>;    // CONFIRMED session revocation, not socket close.
  }>;
};
```

The shared wire protocol is the native runtime's six-tool contract:
`computer_discover`, `computer_open_session`, `computer_observe`, `computer_act`,
`computer_session_status`, `computer_close_session`. Capabilities and supported
modes come from discovery; an adapter must reject unsupported scope, never widen
it. Images reach the engine as attachments, not status metadata or base64 prose.

Target selection is pinned to a grant and its receipt history. Changing target
requires revocation first. The registry currently conservatively permits only
one controller across all targets. Independent simultaneous remote computers
are not implemented. `readiness()` must not allocate, wake, or spend. A failed
connection must confirm no live session remains; uncertain setup/cleanup keeps
the reservation and requires explicit recovery. Never retry input on transport
failure. Cleanup does not inherit the aborted operation's signal.

### Daytona: next adapter, not a second scheduler

Daytona's SDK supplies screenshots, mouse/keyboard and accessibility primitives.
Those raw calls do **not** implement this session contract. A working remote
adapter must be a Den-authorized service around them, not a renderer with a
Daytona key or a direct passthrough exposing an unrestricted desktop.

The intended remote composition is:

- Den authenticates the member, checks policy/entitlement, and resolves an
  explicitly selected worker/workspace and immutable runtime incarnation.
- Existing Cloud runtime machinery owns provisioning and lifecycle; explicit
  user intent owns wake/allocation and cost. Computer reads never provision.
- A worker-side computer service owns consent, target/window scope, controller
  lease, expiry, fresh observations, protected content, receipts and input.
- The adapter returns a session bound to that member, worker, incarnation,
  coworker and task. Disconnect is not release: cancellation needs a durable
  server acknowledgement. Unknown dispatch cannot move to another machine.
- The existing native thread or Cloud Automation executor runs the task.
  Scheduling authority does not grant computer access. Background execution
  requires a distinct reviewed remote grant and exact execution receipts.

Do not import unmerged mobile/runtime work wholesale to supply this feature.
This candidate does not change Den, allocate a sandbox, enable unattended local
control, or claim that a remote task works while the Coworker desktop is offline.

## Current limits and verification

- Local native support: macOS 14+. Windows/Linux native adapters are absent.
- Private person-request discussions only. Groups, Workers, consultations,
  automatic continuations and scheduled responsibilities do not inherit access.
- No persistent grants, arbitrary remote endpoint entry or conversation deep
  link inside the native helper. Watch frames do not renew a control lease or
  become actionable observations.
- Helper staging reuses Desktop's generator and bundle identity. Packaging
  checks the actual target CPU and signature, failing instead of shipping an
  incompatible host-only binary. Cross-CPU/universal distribution remains gated
  by the target-aware helper build work.
- Focused broker/local-adapter checks cover isolation, adapter pinning,
  cancellation races, native handoff, stale observation, no input replay and
  uncertain cleanup. They are not native journey proof.

The existing journey is `evals/specs/open-coworker-computer-control.e2e.test.ts`. It
uses the real Coworker engine/plugin, a localhost model witness and the existing
disposable two-window native fixture. Its native-panel selectors still need
adaptation to the embedded view; it is not proof of this candidate's new UI.
After explicit local-test authorization:

```sh
pnpm evals:e2e open-coworker-computer-control --local
```

Missing person-granted Accessibility or Screen Recording permission skips before
fixture input. A skip is **Incomplete**, not a passing computer-control result.
