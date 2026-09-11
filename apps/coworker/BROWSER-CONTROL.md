# Local Discussion Browser

Pages opened by a coworker first appear in a compact floating **Browser** preview
inside the current chat. The drag handle snaps only to top-right, middle-right or
bottom-right, with keyboard arrows/Home/End and an equivalent position menu. The
card never occupies a separate column or covers the composer. Its position is
remembered per discussion for this launch; the initial position is middle-right.

The same page can expand **beside the chat** or into a **full-screen modal**.
Collapse returns to the floating card; full-screen Exit/Escape returns to the
previous mode without granting control or resuming work. The Browser header button
hides/restores presentation. Narrow discussion areas stack the side viewer rather
than squeezing two unusable columns. Everything runs on this computer.

Tabs support address entry, selection, back, forward, reload and close. Manual
page mutations require confirmed human control. Hiding presentation keeps tabs;
closing a tab removes it. Switching coworkers/discussions removes the previous
presentation. Global settings also suspend the retained workspace's browser,
including body portals and capture. Full screen never survives detachment.
Opening a tab after closing the last one restores the native view even when the
panel's bounds have not changed. Model opens respect the person's expanded or
collapsed choice and never take another discussion's foreground.
Native content is hidden while app menus, dialogs or overlays are in use.
Documents and settings retain their existing aside.

Browser and Computer controls mount after the discussion registry write is
confirmed. A new discussion appears immediately, but its optimistic identity
alone is not enough for native access or a browser binding.

One `@openwork/browser-tabs/electron` host serves this desktop shell. Tabs are
owned by the coworker's workspace ID, directory identity and native session ID,
never by the selected conversation as a substitute for a tool's origin. Work in
another discussion cannot select the visible conversation or open its panel.
Popups remain embedded and retain the opener's owner.

The persistent partition is `persist:coworker-browser`. Browser logins are shared
across discussions and coworkers within this Coworker profile. They are not
shared with the OpenWork app or the system browser. Tabs themselves last for
this app launch. There is no login synchronization, mobile or remote backend.

## Native Tools

`coworker_browser_open` returns `browser_url`, `target_id`, `tab_id`, `url` and
`title`. `coworker_browser_tabs` lists only the current native discussion's page
handles, including popups. Snapshot, click, fill, eval, navigate, screenshot and
close require that exact endpoint and target pair. Page automation reuses the
installed `opencode-chrome-devtools` exported tools; there is no second CDP suite.
Screenshot returns the plugin's local PNG path.

`coworker_browser_snapshot` returns `{ snapshot_id, snapshot }`, with the
provider's original accessibility text in `snapshot`. Click and fill require
that `snapshot_id` alongside the exact endpoint, target and UID. The receipt is
single-use and belongs to one target generation. A new snapshot, action attempt
(including failed or cancelled input), eval, navigation, reload, close, or a
host URL/loading change invalidates it. There is no fallback to a cached UID
without a current receipt. Same-target model operations are serialized; another
target can continue independently. A changing/loading page cannot produce an
actionable snapshot. Screenshots alone do not consume an existing receipt.

The native plugin sends the engine's session, assistant message and tool-call
IDs to the scoped `/context` route. The broker checks the saved private
discussion, native directory, active person-request execution, exact tool name
and arguments. Stable call IDs suppress duplicate dispatch, including uncertain
responses. Workers, groups, schedules and automatic continuations are denied.
The Desktop-host `browser_*` and `webmcp_*` namespaces are disabled in each
Coworker config and rejected by the native plugin's pre-execution hook, including
explicit enables and future names. Coworker keeps its own broker; sharing the
native page host does not enable a second task/approval authority.

The exact-version pnpm patch `patches/opencode-chrome-devtools@1.0.4.patch`
adds cancellation to the shared provider, rather than copying its automation
into Coworker. Native context and an abort signal reach the provider's target
discovery, socket setup and every CDP dispatch, including each fill key event.
Abort terminates the socket, rejects pending commands and ends navigation waits.
Both native execution cancellation and the plugin's exact-call cancellation
message stop remaining input. Closing/changing a page also aborts in-flight
observations and UID input. Already dispatched input cannot be undone; an
interrupted action is never replayed and requires a fresh observation.

The renderer bridge exposes only view-scoped UI commands and tab presentation,
with geometry stamped by preload's current native zoom. Window resize invalidates
the last CSS-geometry observation, and stale native stamps are rejected without
resuming a handoff. It does not expose CDP endpoints, targets, policy tokens or
arbitrary native methods. The
embedded host checks `/managed-policy/evaluate` with the embedded server handle's
dedicated `policyToken`. Missing, denied or unreadable policy fails closed;
navigation, redirects, frames, uploads and CDP requests retain the host's request
hook. Top-level pages remain HTTP(S). WS(S) resource requests are passed to the
same managed evaluator with their method and upload metadata unchanged; they
are not rejected merely for being WebSockets. Loopback app/control URLs remain
blocked for both pages and resources. Denied or unknown policy never falls back
to allowing a request.

Owner checks are tool/UX isolation, not a security sandbox: raw loopback CDP is
accessible to other processes running as this OS user. Page content is untrusted
and never grants permission for consequential actions.

## Person Handoff And Preview

While the coworker controls the page, expanded views display a **watch-only**
image; the native page is parked, not merely covered by a DOM overlay. Clicking
the image or **Take over** requests control. That first click is never forwarded
to the page. A coworker can request the same handoff with
`coworker_browser_handoff({ browser_url, target_id, reason: "sign-in" | "takeover" })`.
The exact owned tab is selected without changing the foreground discussion.
The card above the composer (inside the modal in full screen) reports pausing,
sign-in or human control. Only the person chooses **I'm done** or
**Let coworker continue**; presentation and task state are separate.

All model browser reads/actions for that discussion pause during handoff.
Queued/in-flight dispatch is aborted and previews cleared. Native input and
Resume stay locked until operations and capture settle; uncertain cleanup stays
pausing. A selected loading tab is preserved without restarting navigation.
Only trusted renderer IPC with the current handoff ID resumes control. The
original handoff call waits up to 120 seconds; timeout, cancellation or closing
its tab does not resume automation. A later person resume permits future calls
but never restarts a finished turn. Resume requires a fresh snapshot before
input, eval or navigation. Already-dispatched input cannot be undone; returning
control is not approval for a consequential action.

In-memory JPEG previews are bounded to 480x300 and 512 KiB, refreshed at most
once per three seconds. Expanded watch images are bounded to 1600x1000 and
1.5 MiB, with at least 350 ms between completion and the next capture. One raw
capture per binding supplies backpressure; stale owner/view/tab/generation
results are discarded. Paused, loading, hidden and unreadable states clear
previews. Pixels can contain sensitive content; this is not a redaction service.
The parked page keeps a 1280x900 viewport in the shared hidden parking window.

Full screen uses an HTML dialog. Native Escape and the isolated preload fallback
only exit presentation for the foreground owned view; they never grant access.
Binding loss drops stale renderer presentation and offers explicit reconnect.
`browser-panel.tsx` owns the viewer, `browser-preview.tsx` the snap interaction,
and `use-discussion-browser.ts` the binding/capture/viewport lifecycle. Native
control authority stays in `electron/browser-control.mjs`.

## Assets And Checks

The main bundle imports the shared Electron host. The installer build resolves
`@openwork/browser-tabs/preload` at build time and copies the unchanged CJS asset
beside `electron-dist/main.mjs`; `electron-dist/**/*` includes it. Source dev
resolves that same package export locally. Packaged runtime uses only the
adjacent absolute asset path. The installed browser plugin stays a runtime
dependency, preserving its exported implementation.

Focused checks from `apps/coworker`:

```sh
node --test electron/browser-control.test.mjs src/lib/artifacts.test.ts
pnpm typecheck
node --experimental-vm-modules node_modules/opencode-chrome-devtools/test/cancellation.test.mjs
```

The last command requires the patched dependency installation and executes the
`node:test` file directly (test discovery excludes `node_modules`). The patch adds
the provider tests because its published package has only a live-browser CLI
test, not the upstream test suite. The added tests execute the actual published
provider against a fake raw CDP transport with no sockets, pages or services.
The colocated tests cover receipts, native abort propagation, policy handling
and the panel's real bounds effect using a simulated hook/viewport lifecycle;
these are regression checks, not native app proof.

The covering journey is `evals/specs/open-coworker-browser.e2e.test.ts`, using
`evals/worlds/coworker-browser.ts`: a disposable HTTP page and local model witness
through the real Coworker engine/plugin. It checks owned turns, cross-discussion
isolation, decoded previews, watch-click non-delivery, human-only handoff and
native browser Escape, stale-input rejection after resume, and same-bounds
reopening. It does not automate OS-native computer control. Screenshots are
supplementary, and runtime proof requires running the intended packaged head.

This is not a prompt-injection defense or transactional approval engine.
Arbitrary eval remains powerful; same-URL semantic DOM drift needs stronger
dispatch-time identity checks before claiming general website reliability.
Account-profile management, system-browser login import, live computer video
and unattended control are not implemented.
