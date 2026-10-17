# Computer Use

A small macOS 14+ helper that lets OpenWork see and use one app window selected automatically by the desktop, for one short session. It is a single Swift executable
(`native/`) that the OpenWork desktop packages as **OpenWork Computer Use.app**
(bundle id `com.differentai.openwork.computer-use`) and launches from its main
process. It has no model, API key, network listener or clipboard access.

## Commands

| Command | Purpose |
| --- | --- |
| `ComputerUse mcp-embedded` | What OpenWork launches. MCP over stdio; the desktop selects the window automatically and hosts Take over, Continue and Stop over the private `openwork/ui` channel. |
| `ComputerUse mcp` | Standalone MCP server for local testing, with native consent and a small native control panel. |
| `ComputerUse --check` | Prints `{ok, accessibility, screenRecording, supported, protocolVersion: "openwork.computer-use/1"}` and exits. |
| `ComputerUse permissions accessibility\|screenRecording` | Triggers the macOS prompt and opens the matching System Settings pane. |
| `ComputerUse permissions-guide accessibility\|screenRecording` | Floating permission guide driven by its parent over line-delimited JSON (below). |

## Sessions and tools

A session covers one app, one window and one mode, for at most 15 minutes,
pauses after two idle minutes and allows at most 200 actions. The modes are
`observe` (read only), `assist` (accessibility press/set value) and `control`
(also targeted mouse and keyboard input; the selected window must be in front).
A kernel-held lock allows one session at a time. Grants, element references,
screenshots and receipts live in process memory and are discarded on close.

| Tool | Purpose |
| --- | --- |
| `computer_discover` | App identities, permissions, modes, keys, shortcuts and limits; reads no window content |
| `computer_open_session` | Launch the app if needed, select its window automatically (embedded desktop mode) |
| `computer_observe` | Compact interactive (or all) elements plus an optional window PNG |
| `computer_zoom` | A region of the current observation at full resolution; read only |
| `computer_act` | One action or an ordered batch (1–8) against a fresh observation, with a display-only `intent` |
| `computer_session_status` | Mode, pause state, action count and expiry |
| `computer_close_session` | Revoke the grant and release control |

Every call is validated at the native boundary. An observation authorizes one
`computer_act` within 60 seconds; before input the helper re-checks the app,
window, geometry, structural content and element identity, and coordinates
also need an unchanged screenshot and a live hit test. `request_id` makes a
retry return the original receipt instead of repeating input. A `dispatched`
receipt is not proof the task succeeded: observe again to verify. Terminal,
permission, credential and host apps (`com.differentai.openwork*`,
`com.differentai.opencoworker*`) can never be targeted. Failures are MCP
`isError: true` results with machine-readable `code` and `next` fields.

Person input in the approved app, an app switch, sleep or idle expiry pauses
the session and releases held input. Only the person's Continue resumes it;
neither time nor the agent can.

## Embedded protocol (`openwork/ui`)

In `mcp-embedded` mode the helper and host also exchange JSON-RPC
notifications with method `openwork/ui`:

- Helper → host: `{kind: "state", id, phase, appName, appID, pid, windowTitle,
  task, mode, status, canContinue, windows?}` where `phase` is `approval`,
  `working`, `paused` or `closed` (`windows` only during approval);
  `{kind: "frame", id, sequence, capturedAt, width, height, mimeType, data}`
  watch frames (PNG, at most 5 per second, only while the host is watching and
  the agent is working); `{kind: "input", id, sequence, action, phase, at, x?, y?}`
  for each dispatched input.
- Host → helper: `{id, action}` with `action` one of `approve` (plus
  `windowId`), `deny`, `takeover`, `resume`, `stop`, or `watch` (plus
  `visible`). Messages for another `id` are ignored. `resume` only works while
  the session is paused and Continue is allowed.

## Presence

While a session runs the helper draws presence on the desktop: a frame around
the selected window, a named cursor that glides to each input with click
ripples, drag trails, a typing indicator and highlighted controls, narration
from `intent`, and a "thinking" state between inputs. A pill over the window's
buttons offers Take over, Continue and Stop, shows "Your turn" while the person
has control, and moves to the top of the screen when the window is hidden.
When the session ends the cursor says it is "all yours" and fades out. Every
overlay is excluded from screen capture, the frame and cursor ignore the mouse,
and the pill never activates the helper.

The host may pass `OPENWORK_COMPUTER_USE_PRESENCE` as JSON
`{"name": "…", "color": "#rrggbb"}`. The name falls back to "OpenWork" and the
color to blue. Presence is display only and never grants access. Embedded mode
always shows it; standalone `mcp` shows it only when the variable is set.

## Permission guide protocol

`permissions-guide <permission>` shows a floating guide beside System Settings
and requests the permission. Its stdout and stdin carry one JSON object per line.

- Guide → host: `{"event": "ready"}` first, then `requested` (with
  `permission`), `refresh` (please send fresh status), `visibility` (with
  `visible`) and `return` (the person chose Back to OpenWork).
- Host → guide: `{"type": "status", "readiness": "ready" | "setup-required" |
  "unavailable" | "unsupported", "permissions": {"accessibility": bool,
  "screenRecording": bool}}`, `{"type": "request", "permission": …}` and
  `{"type": "close"}`.

The guide exits on `close`, on stdin EOF, on SIGTERM, after five minutes, or
after `return`. Opening System Settings is never treated as a grant: readiness
always comes from a fresh `--check`.

## Build and verify

```
pnpm --filter @openwork/computer-use build:native
swift test --package-path packages/computer-use/native
node apps/desktop/scripts/prepare-computer-use-helper.mjs --force --outdir apps/desktop/resources/helpers
```

`prepare-computer-use-helper.mjs` builds the release binary and assembles and
signs the helper app; desktop dev and packaged builds run it automatically.
Pointer input relies on an availability-checked lookup of the private
`CGEventSetWindowLocation` symbol; without it, pointer actions fail explicitly
while accessible controls keep working.

## Experimental access model

The desktop rollout grants application access without chat or window prompts.
System permissions still come from macOS. Editable controls do not expose their
raw Accessibility values to the model; ordinary visible content remains in the
screenshot. Protected controls that identify
themselves through Accessibility are omitted and masked; a custom control
that does not identify its sensitive content cannot be recognized reliably.
Computer use reads the selected app's visible content and is not a general
credential-redaction boundary.

Member command, file and website permissions describe structured tools. They
do not classify every operation a native app can perform through its UI.
The computer rollout therefore grants broader GUI access; enabling it requires
reviewing that access model, rather than assuming those structured rules sandbox
the app session. Take over, Stop, window boundaries and rollout cancellation
remain enforced.


## Shared cloud runtime

Browser observations include accessible field names, current non-sensitive
values, input types, required/read-only/disabled state, checkbox state, select
options and validation messages. `fill` replaces or clears text and date/time
fields; `select` accepts observed option values (including multiple selection);
`set_checked` sets a checkbox, radio or custom switch without toggling an
already correct control. Form receipts verify the retained value and expose
`value_mismatch` when a page rewrites or rejects it. Submission still requires
observing the resulting page; an uncertain submit must never be replayed.
References expire after a minute and are consumed once. Before input, the host
revalidates the target's state, geometry and hit test, while unrelated page
updates can continue. Embedded frames and closed custom controls retain the
image/computer fallback.

The JavaScript browser host, computer broker and X11 adapter are shared with
Electron. They live in this package; the desktop imports its explicit exports.
`cloud.mjs` composes them for a member-owned Web worker. See
[Managed Daytona computer](../../docs/computer-use/managed-daytona.md) for its
image, flags, lifecycle and current viewer limits.

In a dedicated VM with the desktop running, Node 22+ can run
`scripts/prove-cloud-desktop.mjs`. Request its loopback `/run` endpoint, pause
and resume the VM through the provider, then request `/after`. This checks a
browser fill followed by a desktop keyboard save, shared takeover, screenshot
coordinates at browser zoom, and memory preservation. It uses synthetic data;
it is a focused provider diagnostic, separate from the Web rollout UI proof.

## UI programs and shortcuts

With `computerUse` enabled, `computer_run` executes one bounded JavaScript
program against the conversation's selected computer or built-in browser. It
uses the same Stop/takeover controls and organization policy as direct tools.
There is no extra application consent step. The `remoteComputers` rollout is
also required when the selected computer is a VM.

```js
// computer_run({ surface: "browser", code: ... })
await tools.ui.open({ url: "https://example.com/projects" });
await tools.ui.waitFor({ target: { role: "textbox", name: "Search" } });
await tools.ui.fill({
  target: { role: "textbox", name: "Search" },
  text: "Website refresh",
});
const project = await tools.ui.scrollUntil({
  target: { role: "button", name: "Website refresh" },
  container: { role: "region", name: "Projects" },
  maxPages: 6,
});
if (!project.found) return project;
await tools.ui.click({ target: project.target });
return await tools.ui.observe({ screenshot: true });
```

`open`, `observe`, `find`, `exists`, `click`, `fill`, `fillForm`, `setChecked`,
`select`, `key`, `findText`, `menu`, `waitFor`, `scroll` and `scrollUntil` run
inside the program. `act` exposes the existing low-level action contract for
visual fallbacks. Targets accept `role`, `name`, `text`, `exact` (default true)
and `nth`; ambiguous targets fail before dispatch. Fields are replaced by
default; `fill({..., append: true})` appends. `setChecked` verifies the desired
state and does not toggle an already-correct checkbox. `findText` handles a
native Find field's focus transition; browser text is searched directly.
Menu and select helpers need controls exposed by the app's accessibility tree
or browser DOM. Unsupported custom controls return a diagnostic; inspect an
image and use `act` rather than guessing.

A program defaults to 30 seconds, accepts a timeout up to 60 seconds, and is
limited to 80 helper calls and 32 KB of returned program data. The desktop
session persists between programs; variables do not. Supply JSON through
`input`, and return only what the next decision needs. The interpreter has no
ambient filesystem, network, process, module or page-script access. Screenshots
are attached separately, and input receipts and timing counters accompany the
result. A failure never replays completed input. If a receipt is uncertain,
observe and decide what remains instead of resubmitting the whole program.

Semantic operations reuse a fresh post-action observation. Visual actions still
need image coordinates and a current screenshot. A program waiting on a known
UI condition keeps polling locally, and stops when the feature is disabled,
the chat is stopped, its target changes, or its caller cancels.

### Linux VM execution

The X11 driver starts an owner-only Unix-socket worker on the existing VM.
Typing chunks and action batches run inside that worker with one provider
request; a separate cancellation request stops remaining input and releases
held buttons/modifiers. The worker exits after two idle minutes and restarts
on demand. A lost response after dispatch is never retried automatically.

To enable semantic Linux controls, install `python3-gi`, `gir1.2-atspi-2.0` and
`at-spi2-core`, enable the app's accessibility bridge, and run provider commands
in the same user/session-bus environment as the desktop. For GTK, that normally
means `GTK_MODULES=atk-bridge`, `NO_AT_BRIDGE=0` and the desktop's
`DBUS_SESSION_BUS_ADDRESS`. Without AT-SPI, the existing screenshot, keyboard
and pointer operations remain available. Observations report whether semantic
controls are available; applications that do not expose controls need visual
fallbacks.

The real X11 fixture in `apps/desktop/test/computer-shortcuts-x11.mjs` proves
semantic fill, idempotent checkbox setting, save, scrolling, physical typing
in one provider request, cancellation and rollout rollback. It requires an
isolated Xvfb/DBus desktop running `fixtures/computer-shortcuts-gtk.py` and
`OPENWORK_TEST_COMPUTER_CONTAINER`; it never connects to a production VM.
The browser proof is `evals/proofs/computer-shortcuts.proof.test.ts`.
