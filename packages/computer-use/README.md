# Computer Use

A small macOS 14+ helper that lets OpenWork see and use the requested app window while computer use is enabled. It is a single Swift executable
(`native/`) that the OpenWork desktop packages as **OpenWork Computer Use.app**
(bundle id `com.differentai.openwork.computer-use`) and launches from its main
process. It has no model, API key, network listener or clipboard access.

On start the helper relaunches itself once with macOS responsibility
disclaimed, so System Settings lists **OpenWork Computer Use** for
Accessibility and Screen Recording. A grant then only needs this short-lived
helper to restart, never OpenWork. The first process stays as a thin parent
that checks the desktop's signature, shares stdio, forwards signals and exits
with the helper's status; the relaunched helper stops if that parent goes away.

## Commands

| Command | Purpose |
| --- | --- |
| `ComputerUse mcp-embedded` | What the signed OpenWork desktop app (`com.differentai.openwork`, same team as the helper) launches. Other code the team signs, such as the bundled sidecars, is not a host. MCP over stdio; requested targets open directly; the desktop hosts Take over, Continue and Stop over the private `openwork/ui` channel. |
| `ComputerUse mcp` | MCP server with native controls, available only to that same authenticated desktop host. |
| `ComputerUse --check` | Prints `{ok, accessibility, screenRecording, supported, protocolVersion: "openwork.computer-use/1"}` and exits. |
| `ComputerUse permissions accessibility\|screenRecording` | Triggers the macOS prompt and opens the matching System Settings pane. |
| `ComputerUse permissions-guide accessibility\|screenRecording` | Floating permission guide driven by its parent over line-delimited JSON (below). |

## Sessions and tools

A session covers one app, one window and one mode. Technical leases and action
accounting renew silently; idle cleanup and follow-up requests preserve enabled
access. Neither renewal nor cleanup clears a human takeover. The modes are
`control` (the default: accessibility plus targeted mouse and keyboard input),
`assist` (accessibility press/set value) and `observe` (read only). The agent is
told to use control to finish the task and to pick a narrower mode only when the
person asks for one. On a parallel Mac computer, control works in the window
where it is, without taking the front unless the app or step needs it
([docs](../../docs/features/computer-use-background/README.md)). This is
included in `computerUse`, not a separate rollout.
A kernel-held lock allows one session per window, so chats in different windows
work at once. Grants, element references,
screenshots and receipts live in process memory and are discarded on close.

| Tool | Purpose |
| --- | --- |
| `computer_discover` | App identities, permissions, modes, keys, shortcuts and limits; reads no window content |
| `computer_open_session` | Launch the requested app and resolve its target window without an approval prompt |
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

On this Mac an observation carries a screenshot only when it adds something,
unless `include_image` (or `computer_act`'s `screenshot`) says otherwise.
Observe and assist sessions, and background delivery, read the elements first
and add an image when they name fewer than eight controls or leave most of them
unnamed. A control session in front always gets one. An automatic image that
matches the last one sent from the same window is not sent again
(`image.omitted: "unchanged"`, `same_as_observation`); its coordinates still
apply. Observe and assist images, used only for reading, are 1024 pixels on
the long side; control keeps 1280 for coordinate accuracy, and `computer_zoom`
shows detail at full resolution.

Person input in the selected app or a deliberate app switch pauses
the session and releases held input. Only the person's Continue resumes it;
neither time nor the agent can. Sleep or temporary desktop unavailability
invalidates observations and releases held input without creating a human
handoff; fresh target validation is required when the desktop returns.

## Embedded protocol (`openwork/ui`)

In `mcp-embedded` mode the helper and host also exchange JSON-RPC
notifications with method `openwork/ui`:

- Helper → host: `{kind: "state", id, phase, appName, appID, pid, windowTitle,
  task, mode, status, canContinue, cause?}` where `phase` is `working`, `paused` or `closed`;
  `{kind: "frame", id, sequence, capturedAt, width, height, mimeType, data}`
  watch frames (PNG, at most 5 per second, only while the host is watching and
  the agent is working); `{kind: "input", id, sequence, action, phase, at, x?, y?}`
  for each dispatched input.
- Host → helper: `{id, action}` with `action` one of `takeover`, `resume`, `stop`, or `watch` (plus
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
and the pill never activates the helper. In a background session the frame and
cursor sit just above the selected window instead of above every window, so a
window the person brings in front covers them too; the pill stays on top so
Take over and Stop are always reachable.

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

Unit tests cannot show that input reaches real apps. To check a signed build
on your Mac, run it with computer use on, stop any chat using the computer,
and run `pnpm --filter @openwork/computer-use prove:mac-apps`. It drives
Calculator and TextEdit through the desktop's local bridge, broker and helper,
as the agent does, with a fixed plan and no model. Each scenario checks a real
outcome (Calculator's display, a file saved on disk) and reports the time of
every call. `--only calculator-press,textedit-type` picks scenarios; `--json
<file>` saves the results. Leave the mouse and keyboard alone while it runs.
Pointer input relies on availability-checked lookups of the private
`CGEventSetWindowLocation` and `CGEventGetWindowLocation` symbols; without
them, pointer actions fail explicitly while accessible controls keep working.

## Windows (This PC)

On Windows the desktop offers **This PC** instead of This Mac. Its helper is
`windows/ComputerUse.cs`, compiled with the .NET Framework compiler that ships
with Windows into `openwork-computer-use.exe` and signed with the rest of the
Windows build. It has no model, API key, network listener or clipboard access.
`computer-windows-driver.mjs` starts it and speaks its line protocol (one JSON
object per line on stdin/stdout). The shared runtime in `computer-remote.mjs`
supplies sessions, receipts, Take over, Continue, Stop and watch frames, as for
Linux VMs. This PC is a local computer: it does not need `remoteComputers`, and
a Windows chat starts on it.

| Command | Purpose |
| --- | --- |
| `openwork-computer-use --check` | Prints `{protocol: "openwork.computer-use.windows/1", ok, reason, supported, session, integrity}` and exits. |
| `openwork-computer-use serve --host-pid N` | Prints `{"type":"ready",...}`, then answers `windows`, `focus`, `capture`, `input` and `status` in order; `cancel` is answered at once and stops running input. It exits when stdin closes. |

- Targets are app windows only; there is no whole-screen session. A window is
  identified by its handle, process id and process start time, so a restarted
  app never matches an old observation.
- OpenWork's own windows are hidden. Terminals, code editors, password managers,
  security settings, apps in another Windows session, apps running with higher
  privileges than OpenWork (as administrator) and capture-protected windows are
  listed with the reason they can't be used and are never opened. The helper
  never elevates itself.
- Screenshots contain only the selected window. If another app's window
  overlaps it, the window draws itself (`PrintWindow`) instead.
- Input is `SendInput`. Before each step and between short chunks of text the
  helper checks that the window is still in front, has not moved or resized,
  and that Windows is not locked or showing a secure prompt; otherwise it stops
  and releases held keys and buttons. A click must land on the selected window
  or its own popup, never on a window covering it.
- The PC is shared with the person. The agent takes the front only for the
  moment it acts: it joins the foreground app's input queue for one
  `SetForegroundWindow` call, the usual way past Windows' foreground lock. 0.4 s
  after its last focus or input, it gives the front back to the window that had
  it and puts the pointer back where the person left it. It does neither if the
  person has clicked, typed or (for the pointer) moved the mouse since.
- Low-level mouse and keyboard hooks tell the person's own input from the
  agent's injected events and keep only when it happened, never which key or
  where. A click or key press of the person's during the agent's moment stops
  that step (`person_interrupted`). Moving the mouse never stops or delays the
  agent; if it moves the pointer between the agent placing it and clicking, the
  pointer goes back to the exact point first. The agent defers at most half a
  second to a gap in typing or a released button before taking the front, and
  between steps puts its window back in front at most twice per request.
- `command` is sent as Ctrl and `option` as Alt. Clipboard, close/quit and
  app-switch chords (Ctrl+C/X/V, Alt+F4, Ctrl+W, Alt+Tab and similar) are refused
  before anything is sent.
- Coordinates are physical pixels (per-monitor DPI aware v2).

Not yet on Windows: accessible controls through UI Automation (so no `assist`
mode, `press` or `set_value`; the agent acts on screenshot coordinates), the
on-desktop presence overlay, and app scripting (`computer_script` is not
offered). If Windows still refuses to bring the window to the front, the call
fails with nothing sent and the agent observes again.

Build it on Windows with
`node apps/desktop/scripts/prepare-computer-use-helper.mjs --force`; desktop dev
and packaged builds run it automatically. A missing compiler is a warning, and
This PC then reports the helper missing.

## Experimental access model

The desktop rollout enables application tools on personal Macs, configured
remote desktops and conversation-owned cloud VMs without extra OpenWork approval
flows. Resolve the intended app/window from the request and current state.
Use an explicit window_id when needed; clarify only genuinely ambiguous targets.
Routine renewal never asks for permission again. Stop ends the current work;
Take over remains paused until Continue and interrupted actions are never replayed.
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

Browser observations include accessible field names, input types,
required/read-only/disabled state, checkbox state, select
options and validation messages. `fill` replaces or clears text and date/time
fields; `select` accepts observed option values (including multiple selection);
`set_checked` sets a checkbox, radio or custom switch without toggling an
already correct control. Form receipts verify the retained value and expose
`value_mismatch` when a page rewrites or rejects it. Field values filled by the
page or person stay withheld; only the exact value entered by the agent can be
read back. Select option references are opaque and limited to the observed list.
Submission still requires
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

In a dedicated VM with the desktop running, stable Node.js 24.x (24.22.1 or newer within that major) can run
`scripts/prove-cloud-desktop.mjs`. Request its loopback `/run` endpoint, pause
and resume the VM through the provider, then request `/after`. This checks a
browser fill followed by a desktop keyboard save, shared takeover, screenshot
coordinates at browser zoom, and memory preservation. It uses synthetic data;
it is a focused provider diagnostic, separate from the Web rollout UI proof.

## UI programs and shortcuts

With `computerUse` enabled, `computer_run` executes one bounded JavaScript
program against the conversation's selected computer or built-in browser. It
uses the same Stop/takeover controls and organization policy as direct tools.
Programs share the enabled access, target validation and human handoff used by direct tools. The `remoteComputers` rollout is
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
native Find field's focus transition, including unnamed find fields that take
focus after Command-F; browser text is searched directly. Menu and select
helpers need controls exposed by the app's accessibility tree or browser DOM.
Menu-bar menus are outside the selected window, so `menu` fails at once with
`menu_not_in_window` when its first item is not in the window. Unsupported
custom controls return a diagnostic; inspect an image and use `act` rather
than guessing. A caught helper error's message starts with its code (for
example `scope_denied: ...`), so a program can branch on it.

Native observations keep each control's ref across reads of the same window and
never reuse a ref for another control. After the model's own `computer_act`, the
returned observation lists only the elements that changed or appeared
(`elements_listing: "changes"`, with `elements_unchanged` and
`elements_removed`); programs always get the full list. In a batch, presses,
`set_value` and menu commands can follow a press while nothing opens over the
window and their controls read back unchanged.

`computer_act` takes a `pacing` for batches: `fast` (default) checks briefly
after each press; `wait` lets the app stop changing after every step (at most
1.5 s); `wait_retry` also re-checks a control that is briefly disabled, moving
or gone, until `retry_ms` (100–5000, default 1500), and presses it where it is
now. Nothing waits past a window, dialog, menu or system prompt that opened.

On a Mac, `computer_open` lists the app's enabled menu-bar commands in
`menus` (`"Format › Font › Bold (command+b)"`), read in one accessibility call
per item without opening a menu; `computer_observe({ menus: true })` lists
them again. `{ type: "menu", path: ["Format", "Font", "Bold"] }` runs one
through accessibility: no menu opens, no keyboard focus is needed and it works
in assist mode. The agent cursor still visits the menu title and a light copy
of the path shows the command being picked, without delaying input. The Apple
and app menus, the Window menu, recent-document lists and any command whose
shortcut is a blocked chord (Quit, Close, Hide, Minimize, clipboard) are never
listed or pressed. Commands go to the app's focused window only.

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
