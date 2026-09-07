# Local Discussion Browser

The Browser button in a saved private discussion opens its local embedded tabs
inside the conversation. Tabs support address entry, selection, back, forward,
reload and close. Closing the panel keeps the tabs; closing a tab removes it.
Opening a tab after closing the last one restores the native view even when
the panel's bounds have not changed.
Native content is hidden while app menus, dialogs or overlays are in use.
Documents and settings retain their existing aside.

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
The original unrestricted `browser_*` tools are disabled in each Coworker config
and rejected by the native plugin's pre-execution hook.

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
not CDP endpoints, targets, policy tokens or arbitrary native methods. The
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

Runtime proof should extend `evals/specs/open-coworker-discussion.e2e.test.ts`:
open and operate an owned page through a native tool turn, switch discussions
while another opens a page, reject cross-owner/app targets, and verify the
address controls, popup ownership, overlay hiding and unchanged document aside.
Include cancelled mid-fill input, stale-snapshot rejection, and closing then
reopening the last tab at the same bounds in that real native journey.
