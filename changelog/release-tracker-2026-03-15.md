# Release Changelog Tracker

Internal preparation file for release summaries. This is not yet published to the changelog page or docs.

## v0.11.151

#### Commit
`5e606273`

#### Released at
`2026-03-15T03:20:31Z`

#### Title
Feedback emails reach the team inbox again

#### One-line summary
Fixes the in-app feedback email target so reports reach the shared OpenWork inbox again.

#### Main changes
Updates the feedback mail link to send reports to `team@openworklabs.com`, restoring the intended shared inbox for in-app feedback.

#### Lines of code changed since previous release
81 lines changed since `v0.11.150` (55 insertions, 26 deletions).

#### Release importance
Minor release: fixes a focused feedback delivery problem without changing the surrounding product flow.

#### Major improvements
False

#### Number of major improvements
0

#### Major improvement details
None.

#### Major bugs resolved
True

#### Number of major bugs resolved
1

#### Major bug fix details
- Fixed the feedback flow so submitted messages are sent to the OpenWork team inbox.

#### Deprecated features
False

#### Number of deprecated features
0

#### Deprecated details
None.

## v0.11.152

#### Commit
`2386e59d`

#### Released at
Unreleased tag only. No published GitHub release. Tagged at `2026-03-14T20:53:19-07:00`.

#### Title
CI workflows move to Blacksmith runners

#### One-line summary
Moves CI and release workflows onto Blacksmith-backed runners, with no visible OpenWork app, web, or server workflow change.

#### Main changes
Repoints CI and release workflows to Blacksmith runners and larger Linux release builders, tightening the release pipeline without changing user-facing product behavior.

#### Lines of code changed since previous release
70 lines changed since `v0.11.151` (35 insertions, 35 deletions).

#### Release importance
Minor release: updates release infrastructure only, with no intended user-facing product change.

#### Major improvements
False

#### Number of major improvements
0

#### Major improvement details
None.

#### Major bugs resolved
False

#### Number of major bugs resolved
0

#### Major bug fix details
None.

#### Deprecated features
False

#### Number of deprecated features
0

#### Deprecated details
None.

## v0.11.153

#### Commit
`f35422b7`

#### Released at
Unreleased tag only. No published GitHub release. Tagged at `2026-03-14T22:35:30-07:00`.

#### Title
Live session updates and scroll pinning recover

#### One-line summary
Restores real-time assistant streaming in sessions while keeping long replies pinned correctly and web event streaming more reliable.

#### Main changes
- Restored incremental session text updates so assistant replies stream live again.
- Reworked chat pinning and jump controls so long responses stay easier to follow.
- Let the web proxy pass event streams through more safely during fallback handling.

#### Lines of code changed since previous release
449 lines changed since `v0.11.152` (315 insertions, 134 deletions).

#### Release importance
Minor release: repairs a core live-session behavior without materially changing OpenWork's overall workflow model.

#### Major improvements
False

#### Number of major improvements
0

#### Major improvement details
None.

#### Major bugs resolved
True

#### Number of major bugs resolved
2

#### Major bug fix details
- Restored live session updates so streaming conversations refresh in place again.
- Fixed scroll pinning so active sessions can stay attached to the newest output.

#### Deprecated features
False

#### Number of deprecated features
0

#### Deprecated details
None.

## v0.11.154

#### Commit
`90c167f9`

#### Released at
Unreleased tag only. No published GitHub release. Tagged at `2026-03-15T07:58:03-07:00`.

#### Title
Desktop release packaging is reworked

#### One-line summary
Reorganizes the desktop release pipeline around workflow artifacts and staged asset upload, with no direct product workflow change.

#### Main changes
Rebuilds the desktop release pipeline to package workflow artifacts first, verify bundled sidecar metadata, and upload release assets in a later step, including a dedicated Linux ARM64 path.

#### Lines of code changed since previous release
976 lines changed since `v0.11.153` (488 insertions, 488 deletions).

#### Release importance
Minor release: updates release packaging only, with no intended user-facing product change.

#### Major improvements
False

#### Number of major improvements
0

#### Major improvement details
None.

#### Major bugs resolved
False

#### Number of major bugs resolved
0

#### Major bug fix details
None.

#### Deprecated features
False

#### Number of deprecated features
0

#### Deprecated details
None.

## v0.11.155

#### Commit
`725b2117`

#### Released at
`2026-03-15T16:08:25Z`

#### Title
Windows release diagnostics stop masking failures

#### One-line summary
Improves release-pipeline diagnostics and normalizes workflow action inputs so broken Windows packaging runs are easier to debug.

#### Main changes
Fixes the Windows GitHub connectivity diagnostic step and aligns release-action input names so maintainers get clearer failure signals during desktop release packaging.

#### Lines of code changed since previous release
51 lines changed since `v0.11.154` (27 insertions, 24 deletions).

#### Release importance
Minor release: improves release reliability only, with no intended user-facing product change.

#### Major improvements
False

#### Number of major improvements
0

#### Major improvement details
None.

#### Major bugs resolved
False

#### Number of major bugs resolved
0

#### Major bug fix details
None.

#### Deprecated features
False

#### Number of deprecated features
0

#### Deprecated details
None.

## v0.11.156

#### Commit
`598fed9d`

#### Released at
Unreleased tag only. No published GitHub release. Tagged at `2026-03-15T10:06:37-07:00`.

#### Title
Desktop release packaging splits build from upload

#### One-line summary
Restructures desktop release automation to build artifacts first, bundle Linux ARM separately, and upload assets in a final pass.

#### Main changes
Splits desktop releases into build, bundle, and upload stages, adds separate Linux ARM packaging, and introduces automated asset upload from workflow artifacts.

#### Lines of code changed since previous release
602 lines changed since `v0.11.155` (486 insertions, 116 deletions).

#### Release importance
Minor release: updates release packaging flow only, with no intended user-facing product change.

#### Major improvements
False

#### Number of major improvements
0

#### Major improvement details
None.

#### Major bugs resolved
False

#### Number of major bugs resolved
0

#### Major bug fix details
None.

#### Deprecated features
False

#### Number of deprecated features
0

#### Deprecated details
None.

## v0.11.157

#### Commit
`fca457be`

#### Released at
Unreleased tag only. No published GitHub release. Tagged at `2026-03-15T12:27:44-07:00`.

#### Title
Den access controls tighten and nested task sessions return

#### One-line summary
Hardens Den sign-in and worker access while restoring inline subagent transcripts, selected-row session actions, and cleaner feedback links.

#### Main changes
- Requires verified Den accounts, removes exposed host tokens, and limits worker access more tightly by user role.
- Renders subagent sessions inline under task steps and moves rename/delete actions into the selected session row.
- Opens feedback mail links in place on the web instead of leaving a blank tab behind.

#### Lines of code changed since previous release
706 lines changed since `v0.11.156` (485 insertions, 221 deletions).

#### Release importance
Minor release: improves session clarity and fixes a few focused interaction issues without changing the broader OpenWork model.

#### Major improvements
False

#### Number of major improvements
0

#### Major improvement details
None.

#### Major bugs resolved
True

#### Number of major bugs resolved
3

#### Major bug fix details
- Fixed subagent sessions so child work stays attached to the task step that spawned it.
- Fixed session list actions so controls live on the selected row instead of feeling misplaced.
- Fixed web feedback email links so they no longer open a stray blank tab.

#### Deprecated features
False

#### Number of deprecated features
0

#### Deprecated details
None.

## v0.11.158

#### Commit
`09837baf`

#### Released at
Unreleased tag only. No published GitHub release. Tagged at `2026-03-15T12:43:37-07:00`.

#### Title
Orchestrator npm publish runs from package cwd

#### One-line summary
Fixes the release workflow so `openwork-orchestrator` publishes from `packages/orchestrator`, with no visible app or web workflow change.

#### Main changes
Corrects the orchestrator publish job to run from the package directory so sidecar build and npm publish steps use the right paths.

#### Lines of code changed since previous release
33 lines changed since `v0.11.157` (17 insertions, 16 deletions).

#### Release importance
Minor release: updates release publishing plumbing only, with no intended user-facing product change.

#### Major improvements
False

#### Number of major improvements
0

#### Major improvement details
None.

#### Major bugs resolved
False

#### Number of major bugs resolved
0

#### Major bug fix details
None.

#### Deprecated features
False

#### Number of deprecated features
0

#### Deprecated details
None.

## v0.11.159

#### Commit
`0559b341`

#### Released at
`2026-03-15T20:36:46Z`

#### Title
Den cloud billing and worker launch align

#### One-line summary
Aligns the app-hosted Den flow with landing-page messaging, restores checkout handling for extra workers, and fixes visible billing and marketing regressions.

#### Main changes
- Reworked the app cloud-worker flow to match the Den landing experience and messaging.
- Restored Polar checkout and return handling for additional cloud workers.
- Fixed the Den marketing rail and removed a dead billing navigation path.

#### Lines of code changed since previous release
2472 lines changed since `v0.11.158` (1192 insertions, 1280 deletions).

#### Release importance
Minor release: meaningfully improves the hosted cloud flow and corrects a couple of visible web regressions without redefining OpenWork's overall product shape.

#### Major improvements
True

#### Number of major improvements
1

#### Major improvement details
- Aligned the app cloud-worker flow with the Den landing experience for a more consistent hosted setup path.

#### Major bugs resolved
True

#### Number of major bugs resolved
2

#### Major bug fix details
- Fixed the Den marketing rail so the hosted web surface renders correctly again.
- Removed an impossible billing navigation branch from the cloud control experience.

#### Deprecated features
False

#### Number of deprecated features
0

#### Deprecated details
None.

## v0.11.160

#### Commit
`a9e56ec0`

#### Released at
`2026-03-15T23:51:50Z`

#### Title
Den auth, downloads, and nested sessions polish

#### One-line summary
Simplifies the Den auth entry flow, sends landing-page downloads to the right installer, and restores parent-child session browsing in the sidebar.

#### Main changes
- Simplified the Den auth screen so account entry is lighter and easier to scan.
- Download buttons now choose the right installer for the visitor's OS and architecture.
- Sidebar previews now keep subagent sessions nested under their parent tasks.

#### Lines of code changed since previous release
475 lines changed since `v0.11.159` (303 insertions, 172 deletions).

#### Release importance
Minor release: delivers a collection of focused UX and reliability fixes across key web and session surfaces without changing the core OpenWork workflow.

#### Major improvements
False

#### Number of major improvements
0

#### Major improvement details
None.

#### Major bugs resolved
True

#### Number of major bugs resolved
3

#### Major bug fix details
- Simplified the Den auth screen so the hosted sign-in path is less confusing.
- Fixed landing download CTAs so they point users to the right installer for their OS and architecture.
- Fixed nested session rendering so subagent sessions appear under their parent tasks with clearer list structure.

#### Deprecated features
False

#### Number of deprecated features
0

#### Deprecated details
None.

## v0.11.161

#### Commit
`4fb90428`

#### Released at
Unreleased tag only. No published GitHub release. Tagged at `2026-03-15T16:48:43-07:00`.

#### Title
Den first-run goes straight to connect

#### One-line summary
Cuts onboarding friction by removing the intent step, waiting for session hydration cleanly, and ending first-run on a direct connect screen.

#### Main changes
Removes the extra intent step, drops the transient marketing-heavy auth shell, and adds a dedicated final connect screen so new Den users can launch a worker and open it in OpenWork with fewer detours.

#### Lines of code changed since previous release
448 lines changed since `v0.11.160` (198 insertions, 250 deletions).

#### Release importance
Minor release: improves a focused hosted onboarding path without materially changing OpenWork's broader product model.

#### Major improvements
True

#### Number of major improvements
1

#### Major improvement details
- Improved the Den first-run experience so the hosted setup path feels more focused and intentional.

#### Major bugs resolved
False

#### Number of major bugs resolved
0

#### Major bug fix details
None.

#### Deprecated features
False

#### Number of deprecated features
0

#### Deprecated details
None.

## v0.11.162

#### Commit
`770c9473`

#### Released at
`2026-03-16T00:51:15Z`

#### Title
Docker dev prints LAN-ready OpenWork URLs

#### One-line summary
Makes local Docker testing easier from phones and other devices by printing public URLs and deriving Den auth and CORS defaults from the detected host.

#### Main changes
- `dev-up.sh` now prints localhost, hostname, and LAN IP URLs for the app, server, and share service.
- `den-dev-up.sh` derives auth URLs and trusted origins for cross-device testing.
- Added `OPENWORK_PUBLIC_HOST` and `DEN_PUBLIC_HOST` overrides when auto-detection is wrong.

#### Lines of code changed since previous release
149 lines changed since `v0.11.161` (130 insertions, 19 deletions).

#### Release importance
Minor release: improves local stack accessibility for testing and self-hosted development without changing the main OpenWork product flow.

#### Major improvements
True

#### Number of major improvements
1

#### Major improvement details
- Improved Docker dev-stack defaults so OpenWork is easier to access from other devices on local networks.

#### Major bugs resolved
False

#### Number of major bugs resolved
0

#### Major bug fix details
None.

#### Deprecated features
False

#### Number of deprecated features
0

#### Deprecated details
None.

## v0.11.163

#### Commit
`69249a20`

#### Released at
`2026-03-16T02:47:00Z`

#### Title
Custom skill hub repos and steadier session actions

#### One-line summary
Lets teams browse and install skills from any GitHub hub repo while making session switching, composer focus, and reload prompts behave more predictably.

#### Main changes
- Added custom GitHub skill hub repos, including saved repo selection and install-from-that-repo flows.
- Cmd+K session actions now return focus to the composer after opening or creating sessions.
- Restored the inline skill reload banner and cleaned up workspace status alignment.

#### Lines of code changed since previous release
1169 lines changed since `v0.11.162` (1034 insertions, 135 deletions).

#### Release importance
Minor release: adds a focused new skills-source capability and cleans up session interaction issues without changing the product's overall shape.

#### Major improvements
True

#### Number of major improvements
1

#### Major improvement details
- Added custom GitHub skill hub repository support so organizations can use their own hosted skill sources inside OpenWork.

#### Major bugs resolved
True

#### Number of major bugs resolved
3

#### Major bug fix details
- Preserved composer focus after Cmd+K session actions.
- Restored the inline skill reload banner in sessions.
- Aligned worker status labels with worker names for clearer scanning.

#### Deprecated features
False

#### Number of deprecated features
0

#### Deprecated details
None.

## v0.11.164

#### Commit
`b88e2b53`

#### Released at
`2026-03-16T15:14:38Z`

#### Title
Owner tokens and child sessions stay visible

#### One-line summary
Clarifies remote approval access with owner tokens, keeps nested child sessions from disappearing in sidebar syncs, and broadens polish across sharing and localization.

#### Main changes
- Remote and cloud connect flows now expose owner tokens separately from collaborator tokens for permission prompts.
- Sidebar resyncs stop dropping child task sessions when root items refresh.
- Added Japanese localization and sharper HTML-first share previews.

#### Lines of code changed since previous release
2418 lines changed since `v0.11.163` (1907 insertions, 511 deletions).

#### Release importance
Minor release: improves visibility, recovery, and localization across key flows without materially changing OpenWork's core architecture.

#### Major improvements
True

#### Number of major improvements
2

#### Major improvement details
- Added full Japanese localization coverage for the app.
- Improved share previews with HTML-first crawler links and more polished Open Graph cards.

#### Major bugs resolved
True

#### Number of major bugs resolved
3

#### Major bug fix details
- Preserved child task sessions during root sidebar syncs.
- Exposed owner tokens in remote permission prompts so recovery flows are easier to finish.
- Allowed removing the default skills hub repository for fully custom skills setups.

#### Deprecated features
False

#### Number of deprecated features
0

#### Deprecated details
None.

## v0.11.165

#### Commit
`d556ed53`

#### Released at
`2026-03-17T02:56:06Z`

#### Title
Settings can sign into Cloud and open workers

#### One-line summary
Adds an in-app OpenWork Cloud settings flow for sign-in, org selection, and worker opening, while smoothing desktop auth handoff and share reliability.

#### Main changes
- Added a Cloud tab in Settings for sign-in, org selection, worker lists, and opening ready Den workers into OpenWork.
- Routed desktop auth through the web handoff flow, including installed-app scheme support and bearer-session handling.
- Restored shared bundle installs and fully cleared disconnected provider credentials.

#### Lines of code changed since previous release
3120 lines changed since `v0.11.164` (2391 insertions, 729 deletions).

#### Release importance
Major release: introduces a substantial new OpenWork Cloud workflow and expands how users authenticate and open cloud workers from the product.

#### Major improvements
True

#### Number of major improvements
2

#### Major improvement details
- Added OpenWork Cloud authentication and worker-open controls directly in Settings.
- Added web-based desktop auth handoff for Den so cloud and desktop sign-in flows connect more smoothly.

#### Major bugs resolved
True

#### Number of major bugs resolved
4

#### Major bug fix details
- Restored shared bundle installs and repeat app opens in OpenWork Share.
- Fully cleared disconnected provider credentials.
- Fixed Den auth handoff to use the installed desktop scheme reliably.
- Improved share preview readability so unfurls are easier to scan.

#### Deprecated features
False

#### Number of deprecated features
0

#### Deprecated details
None.

## v0.11.166

#### Commit
`81882826`

#### Released at
`2026-03-17T05:45:14Z`

#### Title
Daytona-backed Den Docker flow ships

#### One-line summary
Introduces a Daytona-first local Den stack with a worker proxy and snapshot tooling, while tightening org setup and local developer startup paths.

#### Main changes
- Added a Daytona-backed Den Docker flow with a dedicated worker proxy and snapshot builder for preloaded runtimes.
- Introduced the `den-v2` control plane and shared Den DB packages for the new hosted-worker path.
- Fixed unique org slug generation and the `webdev:local` startup script.

#### Lines of code changed since previous release
13718 lines changed since `v0.11.165` (12760 insertions, 958 deletions).

#### Release importance
Major release: lands a major Den runtime and development-stack expansion that materially changes how cloud-worker flows are developed and tested.

#### Major improvements
True

#### Number of major improvements
1

#### Major improvement details
- Added a full Daytona-backed Den Docker development flow with new controller, proxy, schema, and provisioning pieces for cloud-worker workflows.

#### Major bugs resolved
True

#### Number of major bugs resolved
2

#### Major bug fix details
- Enforced stable org and environment syncing with unique org slugs for Den dev setups.
- Fixed the `webdev:local` helper script so local web startup works reliably.

#### Deprecated features
False

#### Number of deprecated features
0

#### Deprecated details
None.

## v0.11.167

#### Commit
`5ac86e5a`

#### Released at
Unreleased draft release. Tagged at `2026-03-16T22:50:30-07:00`.

#### Title
Cloud settings stay gated by developer mode

#### One-line summary
Keeps the Cloud settings tab and default settings route aligned with developer mode so regular users do not land in unfinished controls.

#### Main changes
Fixes the Settings tab list and default settings route so Cloud controls only appear in developer mode, matching the intended rollout of the new OpenWork Cloud panel.

#### Lines of code changed since previous release
45 lines changed since `v0.11.166` (23 insertions, 22 deletions).

#### Release importance
Minor release: fixes a narrow but important settings visibility regression for advanced cloud workflows.

#### Major improvements
False

#### Number of major improvements
0

#### Major improvement details
None.

#### Major bugs resolved
True

#### Number of major bugs resolved
1

#### Major bug fix details
- Restored access to Cloud settings controls in Developer Mode so advanced cloud setup remains reachable.

#### Deprecated features
False

#### Number of deprecated features
0

#### Deprecated details
None.

## v0.11.168

#### Commit
`603ddfee`

#### Released at
`2026-03-17T06:27:40Z`

#### Title
Release recovery with repaired installers

#### One-line summary
Republishes the release with repaired assets; the tagged diff itself is metadata-only, while the intended Cloud tab gating fix landed in `v0.11.167`.

#### Main changes
This tag mainly recovers the release process: `v0.11.167..v0.11.168` only bumps package versions, while the user-visible Cloud settings gating change was already in the prior tag.

#### Lines of code changed since previous release
26 lines changed since `v0.11.167` (13 insertions, 13 deletions).

#### Release importance
Minor release: recovers a small settings-flow fix and restores release/install reliability without changing the product's broader behavior.

#### Major improvements
False

#### Number of major improvements
0

#### Major improvement details
None.

#### Major bugs resolved
True

#### Number of major bugs resolved
2

#### Major bug fix details
- Prevented hidden Cloud settings state from stranding Den desktop handoff flows.
- Restored frozen-lockfile release installs and the expected desktop asset publication set.

#### Deprecated features
False

#### Number of deprecated features
0

#### Deprecated details
None.

## v0.11.169

#### Commit
`9ea1957b`

#### Released at
`2026-03-18T00:11:42Z`

#### Title
Den handoff and session chrome get steadier

#### One-line summary
Keeps Den browser handoff and worker naming in sync while cleaning up session focus, reload banners, run status, and broken sidebar affordances.

#### Main changes
Hardened Den sign-in and worker-open handoff by separating browser and API base URLs and returning proxy-safe desktop auth URLs.

Also released:

- Restored composer focus, flattened reload banners, and removed the broken artifacts rail.
- Simplified OpenWork Share OG previews and cleaned up Den landing CTAs.

#### Lines of code changed since previous release
3699 lines changed since `v0.11.168` (2421 insertions, 1278 deletions).

#### Release importance
Minor release: focuses on connection reliability and session polish across existing workflows rather than reshaping the product.

#### Major improvements
False

#### Number of major improvements
0

#### Major improvement details
None.

#### Major bugs resolved
True

#### Number of major bugs resolved
5

#### Major bug fix details
- Persisted Den browser and API base URLs separately to avoid broken desktop handoff state.
- Restored proxy-safe desktop handoff and browser-facing CORS behavior for Den workers.
- Kept open-in-web links auto-connecting reliably into sessions.
- Restored composer focus after command actions and simplified session run-state feedback.
- Removed the broken artifacts rail and flattened the reload-required banner in sessions.

#### Deprecated features
False

#### Number of deprecated features
0

#### Deprecated details
None.

## v0.11.170

#### Commit
`3869313b`

#### Released at
`2026-03-19T17:27:40Z`

#### Title
OpenWork Cloud web flows and remote reconnects improve

#### One-line summary
Reworks the hosted Cloud web flow while making remote worker links, persisted share tokens, provider auth, and desktop close behavior more dependable.

#### Main changes
- Rebuilt Den web auth, checkout, and dashboard routes so hosted onboarding and billing feel like the app instead of a one-off page.
- Persisted worker share tokens and repeated deeplinks across restarts, with stronger open-in-web auto-connect and connect overlays.
- Added self-serve Cloud settings, OpenAI headless auth, and tray-on-close desktop behavior.

#### Lines of code changed since previous release
20054 lines changed since `v0.11.169` (7642 insertions, 12412 deletions).

#### Release importance
Major release: substantially changes the hosted OpenWork Cloud experience and remote-connect workflow across web, desktop, and cloud surfaces.

#### Major improvements
True

#### Number of major improvements
2

#### Major improvement details
- Tailored the hosted web app UI and Den onboarding flow for OpenWork Cloud deployments.
- Made Cloud settings self-serve and exposed OpenAI headless auth so more provider and cloud setup can happen directly in-product.

#### Major bugs resolved
True

#### Number of major bugs resolved
5

#### Major bug fix details
- Restored Polar billing flow during Den checkout.
- Persisted worker share tokens across restarts.
- Restored repeated shared-skill deeplinks in the desktop app.
- Kept open-in-web auto-connect and the worker overlay working reliably during connect.
- Improved desktop behavior by hiding to tray on close and restoring the window correctly.

#### Deprecated features
False

#### Number of deprecated features
0

#### Deprecated details
None.

## v0.11.171

#### Commit
`10ec28d6`

#### Released at
Unreleased draft release. Tagged at `2026-03-19T14:01:13-07:00`.

#### Title
Session trace rows only open when they have details

#### One-line summary
Stops empty trace rows from expanding, removes stray desktop token-store test code from releases, and moves the repo into the new apps and ee layout.

#### Main changes
- Only trace rows with real details expand, with tighter mobile wrapping and clearer tool icons.
- Removed stray token-store test code from desktop release code.
- Reorganized the repo into `apps/` and `ee/` paths without changing app behavior.

#### Lines of code changed since previous release
1577 lines changed since `v0.11.170` (986 insertions, 591 deletions).

#### Release importance
Minor release: fixes startup and session-trace issues while carrying a mostly structural repo reorganization underneath.

#### Major improvements
False

#### Number of major improvements
0

#### Major improvement details
None.

#### Major bugs resolved
True

#### Number of major bugs resolved
2

#### Major bug fix details
- Removed stray desktop token-store test code that could affect startup and release reliability.
- Made session trace rows expand only when real details exist, improving readability and reducing visual noise.

#### Deprecated features
False

#### Number of deprecated features
0

#### Deprecated details
None.

## v0.11.172

#### Commit
`d47a194d`

#### Released at
`2026-03-19T22:28:14Z`

#### Title
Server package naming and session traces line up

#### One-line summary
Renames the published server package to `openwork-server` and polishes trace-row icon and chevron alignment so session runs scan more cleanly.

#### Main changes
- Renamed the published server package to `openwork-server`, updating orchestrator, release, and dev tooling to resolve the same package consistently.
- Tightened trace-row icon and chevron alignment so session summaries read cleanly.

#### Lines of code changed since previous release
3006 lines changed since `v0.11.171` (2296 insertions, 710 deletions).

#### Release importance
Minor release: improves packaging consistency and session trace polish without materially changing user workflows.

#### Major improvements
False

#### Number of major improvements
0

#### Major improvement details
None.

#### Major bugs resolved
True

#### Number of major bugs resolved
2

#### Major bug fix details
- Resolved inconsistent server package naming across install, publish, and verification paths.
- Fixed session trace row alignment so icons and chevrons stay visually aligned with summaries.

#### Deprecated features
True

#### Number of deprecated features
1

#### Deprecated details
- Replaced prior published server package references with the standardized `openwork-server` naming.

## v0.11.173

#### Commit
`5f0e11ce`

#### Released at
`2026-03-20T00:55:12Z`

#### Title
Daytona workers report activity and local Node tools spawn reliably

#### One-line summary
Adds worker heartbeats for Daytona-backed Cloud workers while making local MCP and tool launches work in nvm-managed Node environments.

#### Main changes
- Added Daytona worker activity heartbeats so Cloud worker state stays fresher.
- Added release snapshot automation for Daytona images.
- Exposed `nvm`-managed Node paths to local spawns so MCP tools and local commands find Node more reliably.

#### Lines of code changed since previous release
805 lines changed since `v0.11.172` (762 insertions, 43 deletions).

#### Release importance
Minor release: improves worker runtime observability and local spawn compatibility without materially changing how most users operate OpenWork.

#### Major improvements
True

#### Number of major improvements
1

#### Major improvement details
- Added Daytona worker activity heartbeats to improve worker liveness tracking for cloud-worker flows.

#### Major bugs resolved
True

#### Number of major bugs resolved
1

#### Major bug fix details
- Exposed nvm-managed Node tools to local spawns so local tool execution works in more environments.

#### Deprecated features
False

#### Number of deprecated features
0

#### Deprecated details
None.

## v0.11.174

#### Commit
`9f3890f6`

#### Released at
Unreleased draft release. Tagged at `2026-03-19T18:59:35-07:00`.

#### Title
Session traces go back to the familiar behavior

#### One-line summary
Restores the original trace interaction model, brings back summary copy actions, and keeps worker names readable in narrow sidebars.

#### Main changes
- Reverted the newer expandable trace treatment and restored the original session trace behavior.
- Brought back trace summary copy actions.
- Kept worker names visible in narrow sidebars instead of collapsing them away.

#### Lines of code changed since previous release
508 lines changed since `v0.11.173` (107 insertions, 401 deletions).

#### Release importance
Minor release: rolls back confusing trace behavior and repairs sidebar readability without changing the product's broader workflow model.

#### Major improvements
False

#### Number of major improvements
0

#### Major improvement details
None.

#### Major bugs resolved
True

#### Number of major bugs resolved
3

#### Major bug fix details
- Restored the original session trace interaction model.
- Restored trace summary copy actions.
- Preserved worker names in narrow sidebars.

#### Deprecated features
False

#### Number of deprecated features
0

#### Deprecated details
None.

## v0.11.175

#### Commit
`da0cd71c`

#### Released at
`2026-03-20T05:53:41Z`

#### Title
Authorized folders and first-run session guidance move into Settings

#### One-line summary
Adds Settings-based folder authorization and server-backed empty states, then tightens sidebar and composer labeling so navigation stays readable.

#### Main changes
Adds a server-backed way to manage authorized folders and to seed first-run session empty states from workspace blueprints.

Also released:

- Cleaner sidebar titles, status labels, footer pinning, and hidden generated timestamps.
- Restored composer action labels and removed the dead artifacts rail.

#### Lines of code changed since previous release
1685 lines changed since `v0.11.174` (1313 insertions, 372 deletions).

#### Release importance
Minor release: adds focused settings and onboarding improvements while mainly polishing existing app-shell and sidebar behavior.

#### Major improvements
True

#### Number of major improvements
2

#### Major improvement details
- Added authorized-folder management directly in Settings.
- Added server-backed session empty states to guide first-run and worker setup more clearly.

#### Major bugs resolved
True

#### Number of major bugs resolved
4

#### Major bug fix details
- Restored composer action labels.
- Removed the session sidebar artifacts rail.
- Kept workspace actions visible and quieter status labels easier to scan in the sidebar.
- Fixed sidebar footer pinning, title truncation, timestamp readability, and flex overflow issues.

#### Deprecated features
True

#### Number of deprecated features
1

#### Deprecated details
- Removed the session sidebar artifacts rail in favor of a cleaner sidebar flow.
