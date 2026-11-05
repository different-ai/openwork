# Computer Use

A small macOS 14+ helper that lets OpenWork see and use the requested app window while computer use is enabled. It is a single Swift executable
(`native/`) that the OpenWork desktop packages as **OpenWork Computer Use.app**
(bundle id `com.differentai.openwork.computer-use`) and launches from its main
process. It has no model, API key or network listener. It touches the
clipboard only for the agent's own copy and paste (below) and never returns
clipboard contents.

On start the helper relaunches itself once with macOS responsibility
disclaimed, so System Settings lists **OpenWork Computer Use** for
Accessibility and Screen Recording. A grant then only needs this short-lived
helper to restart, never OpenWork. macOS still charges Screen Recording to the
outermost app around a disclaimed process, so a packaged desktop runs an exact
copy of the helper from its app data folder, never from inside OpenWork.app.
The first process stays as a thin parent
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
work at once. On a parallel Mac one chat keeps up to three apps open at once,
each in its own window with its own helper session, so a task can move between
Numbers and Mail without closing one and losing its observations. Every
`computer_open` returns that app's `session_id`; `computer_observe`,
`computer_act`, `computer_zoom`, `computer_status` and `computer_close` take it
to pick one of the chat's apps and otherwise go to the app opened last. A
`session_id` only selects among the chat's own apps. Opening a window the chat
already holds returns `session_open` with its `session_id`; a fourth app returns
`too_many_sessions` until one is closed. Every app keeps its window lock, its
turn at the keyboard and pointer and its idle release; end of turn releases
them all, Take over on any of them holds the whole chat until Continue, and Stop
ends them all. Watch live shows the app being worked in, and the session card
names the app of each step. Other computers keep one app per chat.
With `parallelComputerUse` on ([docs](../../docs/features/parallel-computer-use/README.md)),
a subagent the chat starts (OpenCode's `subagent` tool) works on the chat's
computer as part of the chat; off, it is its own chat. The bridge reads the subagent's root chat from the
engine's session tree and sends it as `rootSessionId`; model input never names
it. The subagent keeps its own apps, `session_id`s, helpers, turns at the
keyboard and approvals, while the chat's computer choice, Stop, Take over and
Continue, questions to the person and output folder are the chat's: Stop or Take
over in the chat, or on any subagent's app, stops or holds every agent of the
chat, a subagent started later in a stopped turn included, and the chat's next
turn turns them all back on. The chat's Computer view shows its subagents' apps,
and its session card lists what they saved in its folder. With the feature on, the `computer_open`
guidance has the chat split a task across apps into app agents, in waves by
which needs another's file: each gets one app, a done condition and the file
names it reads and writes in the shared `save_folder`, they pass work as files
by path, and the chat checks the final file. Grants, element references,
screenshots and receipts live in process memory and are discarded on close; an
image the agent saves with `save_image` is a file it wrote on purpose.

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
A macOS prompt only the person may answer (a permission, sign-in or payment)
holds an observation for up to a minute until they answer it, and no action
is sent while one is open.

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
  `visible` for watch frames, and `following` and `beside`, below). Messages for another `id` are ignored. `resume` only works while
  the session is paused and Continue is allowed.

## Following the person's attention

On This Mac a session follows the person's attention, so neither interrupts the
other. The desktop reports each chat that is on screen in a visible OpenWork
window (`computerFollow`, held for a second so quick thread switches do not
flip it); the broker passes it to that chat's helpers as `following` on
`computer_open_session` and on later `watch` messages. While the person
follows, control steps work in front: the app comes forward, and on the first
look and each time they come back to the chat the window is put
`beside_openwork` once, then put back when the session closes, as after
`arrange`. A window the person moved or resized, or the agent arranged itself,
stays where it is for the rest of the session, and with several of the chat's
apps open (`beside: false`) the agent arranges them. Otherwise the session
uses background delivery and never raises its window; a step that needs the
front waits for a gap in the person's input and hands the front back, also when
it took it from OpenWork. Another app brought in front, or the agent's window
minimized, counts as not following until the person is back in OpenWork. Each
receipt's `desktop.followed` says which mode the step ran in. Other computers
get neither argument.

With `parallelComputerUse` on, a subagent's helpers follow when the person watches its chat, or the
subagent's own thread. Then every agent of the chat works in view and they take
turns at the keyboard and pointer, one whole call at a time, as one chat's
apps do. With apps of more than one agent open, none goes `beside_openwork` on
its own. When the person moves to another thread, every agent's helper hears it
and goes back to background delivery, where they act at the same time.

With two or more agents of a watched chat working in apps, the chat owns one
stage. The broker gives each agent's window a tile, in the order the apps
opened, as `stage_slot` and `stage_count` on `computer_open_session` and `watch`
(`stage_count: 0` clears it), and sends the new stage to every helper when an
agent opens or closes an app. Each helper moves only its own window, at its next
look, to its tile on the screen OpenWork is on (`WindowArrangement.stage`):
OpenWork keeps its column (the room beside it when that is half the screen or
more, otherwise a third on its side) and the windows tile the rest, two side by
side, three as one large beside two stacked, four or more as a grid of two rows.
As with `beside_openwork`, a window the person moved or resized, or the agent
arranged itself, leaves the stage for the rest of its session, and closing the
session puts the window back. Out of view nothing is staged; one agent alone
keeps `beside_openwork`.

## Presence

While a session runs the helper draws presence on the desktop: a frame around
the selected window, a named cursor that glides to each input with click
ripples, drag trails, a typing indicator and highlighted controls, narration
from `intent`, and a planning state between inputs: the cursor breathes slowly
with a little wiggle now and then, and names the session's purpose ("planning · Draw a wave"). Its label varies
("having a look", "lining up the next step"). After each step it nods when
the window changed, tilts its head when nothing did ("hmm, nothing changed"),
and shakes when a step was refused ("trying another way"). A scroll zips
over, a long move leans forward, and when the agent's turn ends after real
work the cursor hops and bursts in its color before "all yours". With Reduce
Motion on, it keeps the labels and drops the flourishes. The cursor travels like
a hand: short hops are quick, long ones take up to about a third of a second,
it eases in along a slight arc, and a click or a highlight lands when it
arrives. During a drag the stroke follows the cursor's tip. A drag with
`smooth: true` is drawn as a curve through its points (the broker turns it into
32 points that keep every given one), for drawing strokes rather than
selections. A highlight is
drawn only where the control still is, so a button whose press closed its
dialog gets none. A pill over the window's
buttons offers Take over, Continue and Stop, shows "Your turn" while the person
has control, and moves to the top of the screen when the window is hidden.
When the session ends the cursor says it is "all yours" and fades out. Every
overlay is excluded from screen capture, the frame and cursor ignore the mouse,
and the pill never activates the helper. In a background session the frame and
cursor sit just above the selected window instead of above every window, so a
window the person brings in front covers them too; the pill stays on top so
Take over and Stop are always reachable.

The Mac is shared with the person. A control session takes the front only for
the moment it acts and waits for a gap in their typing first: 0.2 s without a
key, for at most 0.5 s. When they are writing in a text field (or OpenWork's
chat composer), it waits for a real pause of 1 s instead, for up to 8 s, and the
receipt reports the wait as `waited_for_person_ms`. Background steps never wait:
they leave the front alone. Before taking the front it notes their window,
focused field and caret (the selection range, never the text), and gives all
three back as soon as the step ends, falling back to activating the app when
any of them has gone.

Some apps ignore being activated from a background helper (on macOS 26
`activate` can answer yes and do nothing) or refuse the accessibility raise.
To bring the window forward the helper tries each way once, reading back after
each whether the window is in front: raise and activate, the app's
accessibility frontmost flag, the window as its app's main and focused window,
then the make-key event records background delivery uses. When none works the
step is refused before any input as `front_unavailable` (`next: observe`); an
observation, or opening the session, reads the window where it is instead, and
the next step tries again. Steps that run in the background never take the
front, so they never wait on this.

The person's clicks and keys never stop the agent. One during a step pauses it:
input stops at once and anything held is released, the front goes back to them
(keys that reached the agent's window send it back to their field; a click there
means they chose it, so it stays), and the call waits until they have been idle
for 1 s (keys, clicks and held buttons count; moving the mouse does not). The
window then comes back, the step's live checks run again and the batch carries
on with the steps not yet sent. Typing resumes from the first character not
sent, only in the same field with the caret where the agent left it. A step that
may have landed is never sent again: an interrupted drag or click, or typing
whose field changed, ends the call as `person_paused_step` with a fresh
observation. Waits share a 60 s budget per call, after which it returns
`person_busy` (`next: wait`). Take over still waits for Continue, Stop still
stops, and a password is never resumed.

The host may pass `OPENWORK_COMPUTER_USE_PRESENCE` as JSON
`{"name": "…", "color": "#rrggbb"}`. The name falls back to "OpenWork" and the
color to blue. Presence is display only and never grants access. Embedded mode
always shows it; standalone `mcp` shows it only when the variable is set.
OpenWork sets it per helper: the chat's own apps show "OpenWork", and each
subagent's apps show its short description (the child session's title, such as
"Maps"), or else its agent's name, in a color of its own from a small palette
that stays the same for the rest of the chat. The cursor's label, its narration
and the pill all use that name, so the person can tell the agents apart.

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
themselves through Accessibility are masked. A secure text field is listed
(`secure: true`) so the agent can type a password the person gave it, after
the person confirms the app in the chat (`credential_approval_required`); its
value is never read. Other protected content is omitted. A custom control
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
`elements_removed`); programs always get the full list. In a batch, a step
that may change the view or focus (a click, press, menu command, Enter, Tab,
Escape or app shortcut) is followed in the same call while nothing opens over
the window and what the next step uses reads back as a new observation would
show it: a press, `set_value`, `enter_value` or `focus` step's control (the
same element, role, label, actions and enabled state, still inside the window);
for `key` and `type`, the control or text field that now has the keyboard (a
text field for typing, or with no listed focus the app's own editor, as for
canvas text); for a pointer step, the window image within 32 pixels of where it
lands. A control's value counts only for a press on a checkbox, radio button,
switch or disclosure triangle, whose state the press flips: entering a width
that changes a linked height, or a press that moves the controls around it,
does not stop the next step. A `wait` step never stops a batch; the step after
it makes the check. A secure field, secure input anywhere, an unconfirmed
password field on screen, or a window, dialog, menu or system prompt that
opened stops the batch there, and the receipt comes with a fresh observation.
The one exception is keys and typing while the session's window keeps the
app's keyboard, past a window or panel that opened beside it without taking
the keyboard, such as a search field's suggestions.

A coordinate step is refused with `stale_observation` when the live window image
differs from the observation within 32 pixels of where it lands. A text caret
blinking there is not a difference: one thin, solid, upright strip (at most 4
pixels wide, at least 6 and three times as tall) with nothing else changed
beyond its JPEG block. A letter, an underline, a highlight or any other change
near it still refuses the step. Right after the agent's own input in a map,
travel, design, photo, video, music or game app, or after a drag or scroll in
any app, the observation waits until two window captures in a row match (at
most 1.2 s) so it shows where an animation such as Look Around ended, not a
frame of it; `image.still_changing` says it was still moving at the limit.

`computer_act` takes a `pacing` for batches: `fast` (default) checks briefly
after each press; `wait` lets the app stop changing after every step (at most
1.5 s); `wait_retry` also re-checks a control that is briefly disabled, moving
or gone, until `retry_ms` (100–5000, default 1500), and presses it where it is
now. In every mode, what the next step needs is read again for up to 300 ms
before the batch stops, so a field that Edit › Find is still focusing takes
the typing that follows. Nothing waits past a window, dialog, menu or system
prompt that opened.

On a Mac, `computer_open` lists the app's enabled menu-bar commands in
`menus` (`"Format › Font › Bold (command+b)"`), read in one accessibility call
per item without opening a menu; `computer_observe({ menus: true })` lists
them again. `{ type: "menu", path: ["Format", "Font", "Bold"] }` runs one
through accessibility: no menu opens, no keyboard focus is needed and it works
in assist mode. When the app is in front, the agent cursor still visits the
menu title and a light copy of the path shows the command being picked,
without delaying input. In the background the menu bar on screen belongs to
another app, so the cursor names the command (`File › New…`) instead. The Apple
and app menus, the Window menu, recent-document lists and any command whose
shortcut is a blocked chord (Quit, Close, Hide, Minimize, clipboard) are never
listed or pressed. Commands go to the app's focused window only.

A Command shortcut with no observed field or control that has the keyboard,
such as Command-Shift-G on a design app's canvas, runs as the app's menu
command for it when the menus list one. Otherwise it goes to the app's key
window, as a person's would: only a chord the key list allows (never a blocked
one), only while the selected window is the app's focused window and whatever
has the keyboard is inside it, and never while a secure field has it or macOS
reports secure input. Single letters are tool keys in design, photo, video and
music apps. A key may also be written as one chord (`"command+n"`,
`"u+shift"`). Any other Command letter or digit shortcut, such as Command-N,
runs only as the menu command the app lists for it, and is refused when the
menus list none; blocked chords stay blocked however they are written.

Editing a value is done as a person does it, with real key presses. In design,
photo, video and music apps (by the category the app declares), an editing key
(Return, Enter, Escape, Tab, Backspace, Delete, arrows, Home/End and Page
Up/Down, with Shift, Option or Command) goes to whatever has the keyboard in
the selected window when no observed text field has it: the value fields,
steppers and canvases these apps draw themselves. It is the key-window check
above: never a secure field or secure input, and the focus must be inside that
window. In other apps Delete on a focused list row can delete a message or a
file, so plain keys still need an observed field or control there. In any app,
after the batch's own click, double-click or triple-click, `type` and editing
keys go to what that click gave the keyboard (a field editor included), checked
as canvas typing is: before every character, never a secure field, and Delete
or Backspace only into editable text. So `click, key command+a, type "120",
key enter` is one batch.

Some design apps draw their own text editor and report no focused element while
a text layer is being edited (PhotoCraft is built on egui, so accessibility sees
neither its canvas text nor where the keyboard is). In a design, photo, video or
music app, typing after the agent's own click, double-click or `focus` in the
session's window, in the same batch or as the first steps of the next act with
no input of the person's in between, then goes to the app's key window
(`path: "canvas_text"`). It is checked before every character as an app
shortcut is: the session's window is the app's focused window and in front when
input is, macOS reports no secure input, nothing secure has the keyboard, and
the app still reports what it did when typing began. It is never used for a
password or code, or when the app reports a focused element (the editor rule
above applies then). When typing still has nowhere to go, `focus_required` says
to double-click the text layer or click it with the Type tool, then type in the
same batch.

`{ type: "enter_value", ref, text, commit }` (`commit` is `enter` by default,
or `tab` or `none`) enters a value in one step: it gives the field the keyboard
(accessibility focus, or a click on it when the app ignores that), selects all
(accessibility, or Command-A), types and commits. It refuses a secure field.
The helper reads the value back and reports only `value_applied`,
`value_not_applied` or `value_unconfirmed`, never the value. The agent is told
to use it when `set_value` returns `value_not_applied`.

For edits of several steps, two steps make a batch deterministic without an
observation between steps. `{ type: "focus", ref }` puts the keyboard on an
observed control through accessibility, or with a click on its middle only in
a control session, and reads it back (`focus_not_taken` when it did not land).
The next keys and typing in the batch go to it, exactly when it is the listed
text field itself and otherwise by the editor rule above. It never focuses a
secure field. `{ type: "expect", ... }` sends no input and checks any of
`focused` (a ref, or `text_input` for editable text inside the window),
`front`, `enabled`, `exists`, `gone`, `dialog` (`open` or `closed`), `value:
{ ref, equals }` and `title_contains`. A check that does not hold stops the
batch with `expectation_failed`, naming it, before any later step. The
receipt lists every check in `checks: [{ step, check, ok }]`. A value is
compared inside the helper (the same text, or the same number) and never
returned, and a secure field's value is never read. For example: `focus e12,
expect { focused: e12 }, key command+a, type "120", key enter, expect { value:
{ ref: e12, equals: "120" } }`.

A key, typing or pointer step in an assist or observe session is refused with
`scope_denied`, naming the session's mode and saying to open the app again in
control mode, the default.

`{ type: "arrange", layout }` moves and resizes the session's own window on the
screen it is on, so two apps can sit side by side without the Window menu:
`left_half`, `right_half`, `full` (the screen without the menu bar and Dock) or
`beside_openwork` (the room the OpenWork window leaves, or the half away from
it when that room is narrower than 480 points; the whole screen when OpenWork
is on another one). It sets only that window's accessibility position and size,
never another app's, and is sent on its own, not over a dialog and only in
control mode. The new frame is read back: the step path is `window_arranged`,
or `window_arranged_partly` when the app kept its own size. Every observed
coordinate is stale after it, so the receipt carries a fresh observation. The
window's frame before its first `arrange` is kept, and when the session closes
(close, end of turn, idle release or Stop) the window goes back there, unless
the person moved or resized it since. The agent is told to arrange only for a
task across two apps the person may watch, or when asked. It is Mac only;
Windows PCs and remote computers refuse it before anything is sent.

`{ type: "open_file", path: "/Users/…/photo.png" }` hands a file to the
session's app the way Finder's Open With does, instead of a drag between two
apps that a session cannot make. The helper stops before it, as before a file
panel's contents or selection, and the broker answers with the organization's
Agent permissions rule for moving files: with no rule it sends the step again
bound to the exact file, without asking; Ask first shows the person a card for
that file every time; Block refuses with `organization_policy_denied`. The step
is sent on its own. Links are resolved first, so the helper hands over and
checks the real file: an absolute path to an existing file, never a folder.

Every way content moves between apps goes through one broker check,
`approveMove(grant, move, signal)`: `{ kind: "files", app, names, save? }` for
file panels, `open_file`, opening an app onto a file and saving from one, and
`{ kind: "clipboard" }` for Command-C, Command-X and Command-V. The desktop
passes the rule in as `movePolicy` (`computer_files` and `computer_clipboard`
in `/v1/me/desktop-config`). Copy and paste is on or off and never asks.

A success from Launch Services is not taken as proof: the step path is
`file_opened` once a new document window appears or the session's window is
retitled within three seconds, `file_open_failed` when the app shows an alert
or sheet instead (its title and text come back in `file_alert`, marked as
untrusted app content), otherwise `file_open_unconfirmed`. Before anything is
sent, the file's type and extension are checked against the app's
`CFBundleDocumentTypes` and the extensions its imported and exported types
tag: a type the app lists under its own identifier is still tried, with a
`type_note`; a type and extension it never declares are refused as
`file_type_unsupported`, listing what it opens. An app that declares no
document types is left to try. While a session works in an alert, dialog or
sheet, `elements: "interactive"` also lists its static text, so the agent
reads why it appeared.
`computer_open({ app_id, file })` does the same in one call, before the session
starts: an app that is not running launches on the document, the document's
window becomes the session's window (the only one titled with the file's
name, or the only one that opened), and the result's `file` is `file_opened`,
`file_open_failed` or `file_open_unconfirmed`, with the same rule, alert and
type checks. A renewal reopens the window, never the file.

With the OpenWork host on a Mac, `command+c`, `command+x` and `command+v` give
the agent its own clipboard for moving a table, text or image between apps,
each as its own step. Before the agent's copy first replaces the clipboard, the
person's items are kept once for the chat; the step path is `copied` or `cut`
once the clipboard's change count moves, otherwise `copy_unconfirmed`. A paste
runs only while the clipboard holds what the agent copied in this chat: when it
holds something else, that is kept as the person's and the agent's copy goes
back first; with no copy of the agent's, the paste is refused
(`nothing_copied`), so the person's clipboard never goes into an app. A chat
can have several apps' sessions open, each with its own helper, so what they
share lives in private pasteboards named by a random key the desktop sends per
chat: the agent's last copy, the person's kept clipboard, and which clipboard
change was the agent's. No helper can then keep the agent's copy as the
person's. When a session closes, the person's clipboard comes back unless they
changed it since; a later paste in another open session keeps theirs again and
puts the agent's copy back first. Menus keep hiding Copy,
Cut and Paste, and other chords with C, X or V stay blocked. The standalone
helper, Windows and Linux refuse all three.

`{ type: "save_as", path: "/Users/…/Desktop/report.pdf", replace?: true }`
fills the app's open Save or Export sheet in one step: it opens the sheet's
Go To field for the folder, sets the name and presses Save, setting each value
through accessibility and reading it back. The sheet must be open and observed
first, and the step is sent on its own. The path must be absolute and name a
file in an existing folder; links are resolved and folders refused.

The agent decides where to save without asking the person. A save is a file
moved between apps, so it goes through the same Agent permissions check as
`open_file` (`movePolicy`, kind `computer_files`): with no rule it goes ahead;
Ask first shows the card "Save report.pdf to Desktop from Preview?" each time,
with nothing remembered; Block, or a rule that cannot be read, refuses it. On
this Mac, `computer_open` also returns a `save_folder` the desktop made for the
chat (`~/Downloads/OpenWork/<chat>`; a subagent gets its chat's), where the agent saves when the person
names no folder. It is the chat's output folder: the guidance asks the agent to
put every deliverable there, from an app, a `computer_script` export or a shell
command, and the chat's session card lists what changed there during the session.

A file already at the path is refused before anything is sent unless the step
says `replace: true`, the agent's own guard against overwriting by accident; the
sheet's own "Replace?" prompt is answered the same way (Cancel otherwise). The
step path is `file_saved`, with `saved_file: { path, bytes }` in the receipt,
only once the file is on disk and written after Save; otherwise it is
`file_save_unconfirmed`. Windows and Linux helpers refuse the step.

`{ type: "open_in_panel", path: "/Users/…/Desktop/map.png" }` picks a file in
the app's open Open, Place, Insert or Attach panel in one step: it opens the
panel's Go To field, sets the file's path through accessibility and reads it
back, checks that the panel selected exactly that file, then presses the
panel's default button (Open, Place, Insert or Choose). The panel must be open
and observed first, and the step is sent on its own. The path must be absolute
and name an existing file; links are resolved and folders refused.

As for saves, the agent decides without asking the person. Looking through the
panel and the file this step picks both go through the same Agent permissions
check (`movePolicy`, kind `computer_files`): with no rule it goes ahead; Ask
first shows the file each time, with nothing remembered; Block, or a rule that
cannot be read, refuses it. The step path is `file_chosen` once the panel closed and
the app shows a change (a new window, a retitle, or new content in the session's
window), `file_open_failed` with the app's `file_alert` when an alert appears,
otherwise `file_choice_unconfirmed`. Windows and Linux helpers refuse the step.

`{ type: "save_image", path: "/Users/…/map.png", region?, replace? }` saves
what the agent sees in the session's window as a PNG file, so another app can
use it: save, then `open_file` there. It is the observation's capture at the
display's full resolution, with the same privacy scan and masks, and nothing
is saved when that scan is incomplete. `region` is in the observation image's
pixels. The path is an absolute `.png` in an existing folder, links resolved,
and an existing file is kept unless `replace: true`. It sends no input, so it
works in every mode without taking the front, and the observation stays
valid. The step path is `file_saved`, with `saved_file: { path, bytes, width,
height }`, only once the file reads back from disk, so the session card lists
it like a `save_as` file. The organization's rule for moving files decides, as
for `save_as`: by default the agent goes ahead, Ask first shows the save card,
and Block refuses. Mac only.

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
