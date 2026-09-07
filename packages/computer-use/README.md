# Computer Use

Computer Use operates one explicitly approved macOS app window through a
short-lived session. It is a standalone runtime: no HandsFree service, voice
loop, private background-activation API, model SDK, API key, HTTP listener, or
legacy whole-desktop tool is required.

## Start

In OpenWork, open **Library → Computer Use** and choose **Enable Computer Use**
for the current workspace. If macOS access is missing, open permission setup
from that page and grant Accessibility and Screen Recording to the app macOS
identifies. Return to OpenWork and wait for **Ready**. macOS permissions alone
do not enable the workspace connection. Mention a
running app in a message. The helper asks you to choose its window and approve
the requested mode. The floating panel provides **Take over**, **Continue**, and
**Stop**. The setup window can stop all sessions.

| Mode | Access | Foreground behavior |
| --- | --- | --- |
| `observe` | Window text and screenshots | No input |
| `assist` | Observation plus advertised accessibility press/value operations | Does not activate an app or move the pointer |
| `control` | Observation, accessibility, and targeted mouse/keyboard input | Requires the selected window in front; local input or switching apps pauses control |

The app and mode are fixed for the session. Changing either requires a new
approval. A session lasts at most 15 minutes, pauses after two minutes without
an operation, and permits at most 200 action attempts. Continue is a native
person-only control. In control mode, it brings the approved window forward
and requires a fresh observation before any further input. The floating
panel shows the requested task and remaining access time. There is no resume, scope-upgrade, clipboard, URL-open,
shell, whole-screen, or permission-grant tool.

The default is a new app approval for every session. There are no persistent
"always allow" grants in this version. This intentionally keeps the first
migration's authority understandable and revocable.

## Runtime and protocol

```
OpenWork / any compatible MCP client
  └─ dedicated stdio connection
      └─ MCPServer: validated requests, cancellation, bounded input
          └─ SessionRuntime: native consent, app/window identity, limits, receipts
              ├─ MacAccessibility: public AX APIs + window-only ScreenCaptureKit
              ├─ MacInput: exact-process input, window and focus checks
              └─ SessionControls: native approval, Take over / Continue / Stop
```

The executable owns authority. A JavaScript client or orchestration script
cannot loosen its mode, supply another PID for an action, or resume after
takeover. A kernel-held lock permits one session at a time across helper
processes and releases on process exit. Each stdio connection owns its own
unpredictable session ID. Grants, element references, screenshots, and action
receipts stay in process memory and are discarded on close. The only runtime
file is an empty control lock under Application Support.

App identity includes bundle identifier, process ID, executable URL and launch
time. Window identity includes a ScreenCaptureKit window ID and the exact AX
window object; ambiguous matches are rejected. Accessibility reads have
depth, node, record, text, and elapsed-time budgets. Standard protected fields
are omitted from the semantic tree and masked in the returned PNG.

All action arguments are validated at the native boundary. Coordinates refer
to the actual returned PNG dimensions and are mapped to the selected window's
current bounds, including negative display origins. A visual action also
requires a foreground-window check, a fresh matching image, and target hit
testing. Input is posted to the pinned process; no global HID fallback exists.

An observation is valid for 15 seconds and one action attempt. Before input,
the runtime verifies the app, window, geometry, semantic content and exact
element identity. It consumes the observation before dispatch and caches the
receipt under `request_id`, including failures after dispatch begins. An
identical retry returns the same receipt. Reusing the ID for different input
is an error. The client must observe after every attempt.

`status: "dispatched"` means an OS operation was accepted or posted; it does
**not** verify the intended outcome. Outcome verification belongs in the next
observation and the caller's task-specific assertion. Input failures can have
partial effects, so their receipts explicitly require observation before a
retry. Cancellation, sleep, takeover and Stop invalidate observations.

| Tool | Purpose |
| --- | --- |
| `computer_discover` | App identities, permission status, modes, keys and limits; no window text |
| `computer_open_session` | Native app/window/mode approval |
| `computer_observe` | Semantic state plus optional window PNG |
| `computer_act` | One validated action with session, observation and request IDs |
| `computer_session_status` | State, scope, action count and expiry |
| `computer_close_session` | Revoke the grant and release control |

Tool failures use MCP `isError: true` with machine-readable `code` and `next`
fields. The server negotiates supported MCP protocol versions. The stdio
reader stays off the AppKit thread, and approval uses an asynchronous native
sheet so cancellation and the UI remain responsive.

## Model and orchestration strategy

Use dedicated integrations for structured data and the built-in browser for
websites. For native apps, use `assist` when the accessibility tree exposes
the needed controls. Choose `control` only when visual interaction is needed.
The runtime has no provider lock or second hidden model loop; OpenWork's
selected tool-capable model invokes the same MCP contract. A model must accept
images to make visual decisions. Text-only models can request
`include_image: false` and work with accessible controls.

For persistent JavaScript orchestration, `src/session.mjs` exports
`openComputerSession({callTool, appId, purpose, mode, signal})`. Its handle
offers `observe()`, `act()`, `status()` and `close()` / `Symbol.asyncDispose`.
`act()` consumes the current observation, dispatches exactly once, and returns
a new observation plus the dispatch receipt. It never retries an uncertain
action. If post-action capture fails, the error preserves the receipt and
asks for another observation. Use a dedicated MCP connection per task and
dispose the handle when the task stops.

Keep model reasoning, planning and provider credentials in the caller. Bound
the caller's turn count, duration and cost independently. Preserve text and
image tool results and their request IDs across continuation. Do not infer
task success from a tool receipt, a model's prose, or a screenshot alone.
For an API-native computer-tool adapter, route every action through this same
session boundary and stop for pending safety checks; never automatically
acknowledge them. No such adapter is enabled by this package.

## Pointer event compatibility

The pointer backend constructs AppKit events with the approved window number,
then posts them only to the pinned process. On recent macOS, these events also
need a window-local coordinate in addition to the public screen coordinate.
`MacInput` isolates an availability-checked lookup of the private
`CGEventSetWindowLocation` symbol for this purpose. This is an OS compatibility
dependency, not a public-API stability guarantee. If unavailable, pointer input
fails explicitly before a press; accessible app controls remain usable.
Foreground, hit-test, consent and per-event session checks still apply. There
is no background-activation or global-input fallback.

## Boundaries and known limits

- macOS 14+ is the only native backend. Windows needs a separately tested UI
  Automation/input backend and active-desktop/UIPI handling; Linux needs its
  own accessibility and compositor/portal permission design. They are not
  emulated through shell scripts or silently routed to the old helper.
- This is an app/window dispatch boundary, not an operating-system sandbox.
  A permitted app can itself save files, send messages, navigate to a site,
  or perform other consequential work. The calling host remains responsible
  for action authorization and prompt-injection handling. Treat screen/AX
  content as untrusted data. Use an isolated desktop for adversarial workloads.
- Known terminal, permission, credential and host-control apps are excluded.
  This blocklist is defense in depth, not a claim that every executable or
  command-capable app can be identified. Custom widgets can mislabel or omit
  protected fields; never assume screenshots cannot contain sensitive data.
- Exact visual freshness deliberately rejects animation, a changed caret or
  any other changed pixels. Prefer accessible actions; observe again when a
  visual target changes. There is no speculative click or stale-image retry.
- Screenshot and AX calls are not an atomic OS transaction. Identity, bounds,
  content and per-event checks reduce races but cannot make a third-party
  application's behavior atomic. The native input path does not claim
  background mouse/keyboard operation, secure-desktop automation or locked use.
- Focusable text fields, public AX actions and a limited key vocabulary are
  supported. Context menus, arbitrary shortcuts, file dialogs outside the
  approved window, and inaccessible windows may require person takeover.
- Screenshots and typed text are not logged by the runtime, but returned tool
  content enters the calling host's conversation and its configured retention
  and provider policies. Runtime in-memory retention is not a promise about
  the host's transcripts.

## Handoff behavior

The native panel keeps the requested task and chosen window visible throughout
access, including while paused. **Take over** releases held pointer input and
invalidates the current observation. Local typing and pointer input also pause
access. **Continue** is an explicit person action; in control mode it raises
only the approved window, checks that window is foreground, and requires the
caller to observe again. It does not replay interrupted typing or dragging.
**Stop** ends the grant. The access countdown continues while paused.

During physical input, Continue is disabled until one second without another
input event. That quiet period only makes Continue available; it never resumes
control. Session status exposes `phase`: `person_interacting`,
`ready_to_continue`, `refreshing`, or `working`, while preserving the existing
`paused`/`active` state. After Continue, the panel says it is refreshing until
an observation succeeds. Old input is never replayed.

**Hide panel** hides this session's floating controls without revoking access.
The **OW** menu bar item restores the task panel; its tooltip is generic so
hiding the panel also hides task details. Stop removes both surfaces. Session status includes the task
purpose, approved window title, and panel visibility for the owning caller.
This associates the native panel with the approved task; navigation back to an
OpenWork conversation is not added by this package.

When the window changes during observation, the runtime makes at most three
read-only capture attempts, 75 ms apart. Every attempt checks the same session
generation, window identity, geometry, and semantic state. Continuous changes
still return `stale_observation`; a failed refresh invalidates the old token.
This does not relax the exact-image checks for visual actions, retry any input,
or clear a person takeover.

## Build, migration and verification

```
pnpm --filter @openwork/computer-use build:native
swift test --package-path packages/computer-use/native
pnpm evals:e2e computer-use-window-scope
```

The desktop build stages this package as **OpenWork Computer Use.app** while
preserving the existing bundle identifier and executable location for TCC and
installed MCP configurations. The helper's `--check` includes
`protocolVersion: "openwork.computer-use/1"`; setup identifies an old helper
and asks for a rebuild/reinstall. Reconnect Computer Use in each existing
workspace to replace an old package command and refresh tool schemas.
There is no runtime fallback to `@openwork/handsfree`; its historical sources
remain separate and are not part of this implementation.

The native journey owns two disposable windows and drives the real helper
over stdio. It verifies native consent, isolated connection grants, accessible
actions, replay protection, read scope, protected-field omission, stale
geometry, person takeover during typing, pointer release during interrupted
drags, Continue and Stop. Its person-input fixture uses the real approval UI,
never a production auto-approve flag. It requires macOS plus existing person-
granted Accessibility and Screen Recording; it never changes TCC permissions.
If the selected placement is Linux/Daytona, it skips explicitly and the
verdict is **Incomplete**. A skip is not native proof. Platform coverage,
visual-input journeys, provider task-success benchmarking and packaged
permission-upgrade verification remain separate verification work.

## Design sources (reviewed September 4, 2026)

- [Computer use API and integration patterns](https://developers.openai.com/api/docs/guides/tools-computer-use): persistent execution context, own-tool integrations, observations after action groups, execution limits and caller-owned permissions.
- [Desktop computer-use permissions](https://learn.chatgpt.com/docs/computer-use): separate OS permissions and app approval; person takeover; prefer dedicated integrations; foreground limitations.
- [Apple ScreenCaptureKit](https://developer.apple.com/documentation/screencapturekit/capturing-screen-content-in-macos): select one window with `SCContentFilter(desktopIndependentWindow:)`.
- [Apple accessibility trust](https://developer.apple.com/documentation/applicationservices/1460720-axisprocesstrusted): check the helper's actual AX authorization.
- [Microsoft UI Automation security](https://learn.microsoft.com/en-us/dotnet/framework/ui-automation/ui-automation-security-overview): integrity-level and protected UI restrictions require a Windows-specific implementation.
- [MCP tools specification](https://modelcontextprotocol.io/specification/2025-11-25/server/tools): tool schemas, content and `isError` error reporting.
