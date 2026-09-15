# Computer Use

Computer Use operates one explicitly approved macOS app window through a
short-lived session. Its native runtime needs no HandsFree service, voice
loop, private background-activation API, model SDK, API key, HTTP listener, or
legacy whole-desktop tool.

## Start

In OpenWork, open **Library → Computer Use** and choose **Enable Computer Use**
for the current workspace. If macOS access is missing, open permission setup
from that page and grant Accessibility and Screen Recording to the app macOS
identifies. Return to OpenWork and wait for **Ready**. macOS permissions alone
do not enable the workspace connection. Mention an
app in a message. OpenWork can launch an installed app, then asks you to choose
its window and **Allow and start** in the main app. Ordinary work shows no control dashboard. Your input interrupts the agent;
it must wait and obtain a fresh observation before continuing. **Stop** in the
native preview ends access. Hide leaves the grant intact; OpenWork can show the preview again. The small floating preview shows the last approved
observation and the last action location, not a continuous desktop recording. The setup window can stop all sessions.

| Mode | Access | Foreground behavior |
| --- | --- | --- |
| `observe` | Window text and screenshots | No input |
| `assist` | Observation plus advertised accessibility press/value operations | Does not activate an app or move the pointer |
| `control` | Observation, accessibility, and targeted mouse/keyboard input | Requires the selected window in front; clicks, typing, scrolling, dragging or switching apps pause control |

The app and mode are fixed for the session. Changing either requires a new
approval. A session lasts at most 15 minutes, pauses after two minutes without
an operation, and permits at most 200 action attempts. System or window failures can still require an explicit Continue prompt in OpenWork. In control mode, it brings the approved window forward
and requires a fresh observation before any further input. The main app shows approval and exceptional recovery prompts. There is no resume, scope-upgrade, clipboard, URL-open,
shell, whole-screen, or permission-grant tool.

The default is a new app approval for every session. There are no persistent
"always allow" grants in this version. This intentionally keeps the first
migration's authority understandable and revocable.

## Runtime and protocol

```
OpenWork engine → stdio relay → desktop broker → native MCPServer
OpenWork main window → desktop IPC → broker's private UI channel
                                      └─ native session authority
                                          ├─ MacAccessibility: AX + window-only capture
                                          ├─ MacInput: exact-process input and focus checks
                                          └─ SessionControls: approval + small preview
Standalone MCP client → ComputerUse mcp → native approval and controls
```

OpenWork launches a filtered stdio-to-Unix-socket relay for MCP and owns the
native helper process. Only the main window's desktop IPC can approve or recover a blocked session;
private UI messages are removed from the engine transport. The socket is inside
a user-only directory. Existing enabled bundled commands migrate when a local
workspace loads. Custom commands and disabled entries are preserved.
Standalone `ComputerUse mcp` retains native approval and controls.

The executable owns authority. The agent's MCP client
cannot loosen its mode, supply another PID for an action, or act after an interruption without waiting and refreshing state. A kernel-held lock permits one session at a time across helper
processes and releases on process exit. Each stdio connection owns its own
unpredictable session ID. Grants, element references, screenshots, and action
receipts stay in process memory and are discarded on close. The native session lock is an empty file under Application Support; desktop
coordination also uses a private temporary Unix socket.

App identity includes bundle identifier, process ID, executable URL and launch
time. Window identity includes a ScreenCaptureKit window ID and the exact AX
window object; ambiguous matches are rejected. Accessibility reads have
depth, node, record, text, and elapsed-time budgets. Standard protected fields
are omitted from the semantic tree and masked in the returned PNG.

All action arguments are validated at the native boundary. Coordinates refer
to the actual returned PNG dimensions and are mapped to the selected window's
current bounds, including negative display origins. A visual action also
requires a foreground-window check, an observation that included an image, and
live target hit testing. Input is posted to the pinned process; no global HID
fallback exists.

An observation is valid for 60 seconds and one `computer_act` call. Before
input, the runtime verifies the app, window, geometry, structural content and
exact element identity. Structural content means roles, labels, geometry,
enablement, actions and editable values; a clock, counter or other read-only
text that ticks over does not make the observation stale, and pixel equality
is not required (a caret, spinner or animation costs no round trip). The
runtime consumes the observation before dispatch and caches the receipt under
`request_id`, including failures after dispatch begins. An identical retry
returns the same receipt. Reusing the ID for different input is an error.

### Working at coworker speed

The vocabulary and loop follow what current computer-use references converge
on (Anthropic's batch actions and modifier chords, OpenAI's ordered `actions`
arrays, accessibility-first macOS tools that re-resolve each step live):

- **Batches.** `computer_act` takes `action` or `actions` (1–8 steps). Steps
  run in order; each is checked against the same session, generation and frame,
  every pointer position is hit-tested live and every ref is re-verified by
  exact element identity. The batch stops at the first failure and the receipt
  lists `steps` as dispatched, failed or skipped. Once any step landed the
  receipt is `status: "partial"` with `ok: true`, so the caller still receives
  the settled view instead of an error.
- **Shortcuts.** `key` accepts a base key plus `modifiers` (`command`, `shift`,
  `option`, `control`). Chords that quit, close, hide or minimize the app,
  switch apps, open Spotlight, capture the screen or toggle full screen are
  refused with `blocked_shortcut`; `computer_discover` lists them. `command+v`
  is accepted only after the same session dispatched `command+c` or
  `command+x`; a person pause resets that, so the person's own pasteboard is
  never pasted by the agent. Clicks accept the same modifiers; `triple_click`
  selects a line or paragraph.
- **Settle, then observe.** After each dispatched step the runtime waits until
  two structural reads 70 ms apart agree (at most 500 ms), so the following
  observation shows the reached state rather than a mid-transition frame.
  `wait` (50–3000 ms) is for a known load inside a batch, not a substitute.
- **Compact elements.** `computer_observe` returns interactive elements by
  default (`ref`, `role` without the `AX` prefix, `label`, `value`, `x`/`y`/
  `w`/`h` in image pixels, `press`/`settable`/`disabled` flags only when set).
  `elements: "all"` adds static text for reading; `"none"` returns only the
  image. `elements_total` reports how many records the walk collected.
- **Typing.** Text is still one grapheme per event without the clipboard, but
  the focus and session checks repeat every 50 ms instead of every character.

`status: "dispatched"` means an OS operation was accepted or posted; it does
**not** verify the intended outcome. Outcome verification belongs in the next
observation and the caller's task-specific assertion. Input failures can have
partial effects, so their receipts explicitly require observation before a
retry. Cancellation, sleep, takeover and Stop invalidate observations.

| Tool | Purpose |
| --- | --- |
| `computer_discover` | App identities, permission status, modes, keys, modifiers, blocked shortcuts and limits; no window text |
| `computer_open_session` | Launch if needed, then person approval of app/window/mode |
| `computer_observe` | Interactive (or all) elements plus optional window PNG |
| `computer_act` | One action or an ordered batch, validated per step, with session, observation and request IDs |
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
- Freshness is structural, not pixel-exact: a window whose roles, labels,
  geometry or editable values changed is stale; changed pixels alone are not.
  Later steps of a batch act on a window the earlier step just changed, so
  batch only predictable sequences. There is no stale-observation retry.
- Screenshot and AX calls are not an atomic OS transaction. Identity, bounds,
  content and per-event checks reduce races but cannot make a third-party
  application's behavior atomic. The native input path does not claim
  background mouse/keyboard operation, secure-desktop automation or locked use.
- Focusable text fields, public AX actions, plain keys and app shortcuts are
  supported. Context menus (right click), file dialogs outside the approved
  window, and inaccessible windows may require person takeover; menus, sheets
  and popovers are not composited into the window capture.
- Screenshots and typed text are not logged by the runtime, but returned tool
  content enters the calling host's conversation and its configured retention
  and provider policies. Runtime in-memory retention is not a promise about
  the host's transcripts.

## Handoff behavior

In the hosted desktop flow, person input releases held pointer input and
invalidates the current observation. Passive mouse movement does not interrupt.
The agent receives `user_interacting` during a one-second quiet period, then
`requery_required` for actions until it requests a new observation. Time passing
alone never resumes input. A new observation after quiet brings only the approved
window forward in control mode, checks focus, and refreshes state. Further person
input interrupts that recovery too. Interrupted typing or dragging is never replayed.
The one-second duration and event selection are OpenWork choices, not verified
constants from another product.

Sleep, desktop unavailability, idle expiry, and failed focus recovery still need
an explicit **Continue** prompt in OpenWork. Normal work and recoverable person
input do not show a permanent controller. **Hide** hides only the native preview;
**Show preview** in OpenWork restores it. **Stop** revokes the grant, and neither
observation nor further actions can restart that session. The access countdown
continues while interrupted.

Standalone `ComputerUse mcp` preserves its native approval and text controls:
**Take over**, **Continue**, **Stop**, **Hide panel**, and the **OW** menu-bar
restore action. Unlike hosted recovery, standalone person input still requires
manual Continue after quiet, then a fresh observation.

Session status includes the purpose, approved window, preview visibility, and
`phase`: `person_interacting`, `requery_required`, `ready_to_continue`,
`refreshing`, or `working`. Desktop approval/preview coordination is global, not
bound to an OpenWork task ID. The preview displays the latest requested image,
not a continuous capture stream. There is no combined start-and-get-state tool.
Stop is enforced for the existing grant, not a native assistant-turn ID: caller
instructions end the current turn, but another open-session call can request new
approval. These are remaining gaps, not claims of full Codex/Sky parity.

When the window changes during observation, the runtime makes at most three
read-only capture attempts, 75 ms apart. Every attempt checks the same session
generation, window identity, geometry, and semantic state. Continuous changes
still return `stale_observation`; a failed refresh invalidates the old token.
This does not relax the structural or hit-test checks for visual actions, retry
any input, or recover during active person input.

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
