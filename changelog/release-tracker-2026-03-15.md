# Release Changelog Tracker

Internal preparation file for release summaries. This is not yet published to the changelog page or docs.

## v0.11.151

#### Commit
`5e606273`

#### Released at
`2026-03-15T03:20:31Z`

#### One-line summary
Makes feedback submissions reach the OpenWork team inbox reliably again.

#### Main changes
- Fixed feedback sending so in-app reports go to the team inbox instead of the wrong destination.
- Removed a small but user-visible failure point in the feedback path, making it more likely that submitted reports are actually received.
- Shipped as a narrow feedback reliability patch rather than a broader app or web workflow update.

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

#### Published in changelog page
False

#### Published in docs
False

## v0.11.152

#### Commit
`2386e59d`

#### Released at
Unreleased tag only. No published GitHub release. Tagged at `2026-03-14T20:53:19-07:00`.

#### One-line summary
Refreshes release infrastructure only, with no clear user-facing OpenWork product change in this tag.

#### Main changes
- No notable end-user app, web, or desktop workflow changes are visible in this release.
- Focused on release and CI execution changes rather than product behavior.
- Served as a maintenance checkpoint to keep shipping flows moving cleanly.

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

#### Published in changelog page
False

#### Published in docs
False

## v0.11.153

#### Commit
`f35422b7`

#### Released at
Unreleased tag only. No published GitHub release. Tagged at `2026-03-14T22:35:30-07:00`.

#### One-line summary
Restores live session streaming so conversations update in place again and stay pinned to the latest output when expected.

#### Main changes
- Restored live session updates so new assistant output appears in real time again instead of feeling stalled.
- Brought back scroll pinning behavior so active sessions stay anchored to the newest output more reliably.
- Tightened the streaming path across app and web session surfaces to make live conversation state feel coherent again.

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

#### Published in changelog page
False

#### Published in docs
False

## v0.11.154

#### Commit
`90c167f9`

#### Released at
Unreleased tag only. No published GitHub release. Tagged at `2026-03-15T07:58:03-07:00`.

#### One-line summary
Refreshes release packaging only, with no clear user-facing OpenWork product change in this tag.

#### Main changes
- No notable end-user app, web, or desktop workflow changes are visible in this release.
- Focused on release packaging streamlining rather than product behavior.
- Shipped as release-process maintenance instead of a feature, UX, or reliability patch for users.

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

#### Published in changelog page
False

#### Published in docs
False

## v0.11.155

#### Commit
`725b2117`

#### Released at
`2026-03-15T16:08:25Z`

#### One-line summary
Hardens release diagnostics behind the scenes, with no clear new end-user OpenWork behavior in this release.

#### Main changes
- No notable end-user app, web, or desktop workflow changes are visible in this release.
- Focused on fixing Windows release diagnostics and workflow wiring rather than product behavior.
- Served as a narrow release-reliability patch instead of a user-facing feature or UX update.

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

#### Published in changelog page
False

#### Published in docs
False

## v0.11.156

#### Commit
`598fed9d`

#### Released at
Unreleased tag only. No published GitHub release. Tagged at `2026-03-15T10:06:37-07:00`.

#### One-line summary
Refreshes release packaging structure only, with no clear user-facing OpenWork product change in this tag.

#### Main changes
- No notable end-user app, web, or desktop workflow changes are visible in this release.
- Focused on splitting desktop release packaging work rather than changing product behavior.
- Served as another maintenance checkpoint in the release pipeline instead of a user-facing patch.

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

#### Published in changelog page
False

#### Published in docs
False

## v0.11.157

#### Commit
`fca457be`

#### Released at
Unreleased tag only. No published GitHub release. Tagged at `2026-03-15T12:27:44-07:00`.

#### One-line summary
Makes complex sessions easier to follow by nesting subagent work correctly, cleaning up session row actions, and fixing feedback links on web.

#### Main changes
- Nested spawned subagent sessions under the task step that launched them so tool-heavy runs read as one coherent flow.
- Moved session actions into the selected row so list actions feel more local and predictable while navigating sessions.
- Fixed web feedback email links so they open directly without leaving behind an unnecessary blank tab.

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

#### Published in changelog page
False

#### Published in docs
False

## v0.11.158

#### Commit
`09837baf`

#### Released at
Unreleased tag only. No published GitHub release. Tagged at `2026-03-15T12:43:37-07:00`.

#### One-line summary
Updates release publishing plumbing only, with no clear user-facing OpenWork product change in this tag.

#### Main changes
- No notable end-user app, web, or desktop workflow changes are visible in this release.
- Focused on release publishing workflow wiring rather than product behavior.
- Served as a narrow maintenance patch to keep shipping flows working reliably.

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

#### Published in changelog page
False

#### Published in docs
False

## v0.11.159

#### Commit
`0559b341`

#### Released at
`2026-03-15T20:36:46Z`

#### One-line summary
Brings the app cloud-worker flow in line with the Den landing experience and cleans up a couple of visible web regressions around billing and marketing surfaces.

#### Main changes
- Aligned the app cloud-worker flow with the Den landing experience so hosted setup feels more consistent from first touch through worker creation.
- Fixed the Den marketing rail rendering so the hosted web surface displays correctly again.
- Removed an impossible billing navigation branch so the cloud control UI no longer exposes a path users cannot actually use.

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

#### Published in changelog page
False

#### Published in docs
False

## v0.11.160

#### Commit
`a9e56ec0`

#### Released at
`2026-03-15T23:51:50Z`

#### One-line summary
Polishes several high-traffic web and session surfaces so Den entry, downloads, and nested session browsing feel clearer and more reliable.

#### Main changes
- Simplified the Den auth screen so the hosted entry flow feels cleaner and easier to understand.
- Mapped landing download calls to action to the detected OS and architecture while also making the app shell behave better on dynamic mobile viewports.
- Restored nested subagent sessions under their parent tasks and cleaned up session list indentation so complex runs are easier to scan.

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

#### Published in changelog page
False

#### Published in docs
False

## v0.11.161

#### Commit
`4fb90428`

#### Released at
Unreleased tag only. No published GitHub release. Tagged at `2026-03-15T16:48:43-07:00`.

#### One-line summary
Refines the Den first-run experience by removing transient marketing noise and making the initial hosted setup flow feel more focused.

#### Main changes
- Improved the Den first-run flow so hosted setup feels more direct and less cluttered.
- Removed transient marketing UI that could distract from the primary first-run path.
- Kept the patch focused on first-run flow polish rather than broader app, desktop, or session changes.

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

#### Published in changelog page
False

#### Published in docs
False

## v0.11.162

#### Commit
`770c9473`

#### Released at
`2026-03-16T00:51:15Z`

#### One-line summary
Improves local Docker dev-stack defaults so OpenWork is easier to test from other devices over LAN or other public local-network paths.

#### Main changes
- Improved Docker dev defaults so local OpenWork stacks are easier to expose on LAN and similar public local-network setups.
- Reduced friction when testing from another device by making the local networking path more ready to use out of the box.
- Kept the release tightly focused on local stack accessibility rather than broader end-user app or web workflow changes.

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

#### Published in changelog page
False

#### Published in docs
False

## v0.11.163

#### Commit
`69249a20`

#### Released at
`2026-03-16T02:47:00Z`

#### One-line summary
Adds custom GitHub skill hub repositories first, then smooths session interactions so cloud and extension workflows feel more reliable.

#### Main changes
- Added support for custom GitHub skill hub repositories so teams can point OpenWork at their own skill sources.
- Kept the composer focused after Cmd+K session actions so keyboard-driven session work no longer breaks flow.
- Restored the inline skill reload banner and aligned worker status labels for clearer workspace state feedback.

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

#### Published in changelog page
False

#### Published in docs
False

## v0.11.164

#### Commit
`b88e2b53`

#### Released at
`2026-03-16T15:14:38Z`

#### One-line summary
Keeps nested task context and remote permission recovery clearer first, then broadens sharing and localization polish across the product.

#### Main changes
- Preserved child task sessions during sidebar re-syncs so nested task context stays visible instead of disappearing.
- Exposed owner tokens in remote permission prompts to make worker handoff and recovery easier to complete.
- Improved public-facing polish with HTML-first share links, refined Open Graph preview cards, and full Japanese localization coverage.

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

#### Published in changelog page
False

#### Published in docs
False

## v0.11.165

#### Commit
`d556ed53`

#### Released at
`2026-03-17T02:56:06Z`

#### One-line summary
Adds OpenWork Cloud sign-in and worker-open flows first, then makes Den auth handoff and shared bundle installs much more dependable.

#### Main changes
- Added OpenWork Cloud auth and worker-open flows in Settings so users can sign in and open cloud workers directly from the app.
- Improved Den desktop sign-in handoff through the web, including installed desktop scheme support and Better Auth trusted-origin handling.
- Restored shared bundle installs and polished share previews, while also improving provider credential cleanup and Den landing CTA routing.

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

#### Published in changelog page
False

#### Published in docs
False

## v0.11.166

#### Commit
`81882826`

#### Released at
`2026-03-17T05:45:14Z`

#### One-line summary
Introduces a Daytona-backed Den Docker development flow first, then stabilizes local org provisioning and helper scripts for cloud-worker testing.

#### Main changes
- Added a Daytona-backed Den Docker dev flow with the new `den-v2` service set, worker proxy, shared DB package, and provisioning helpers.
- Improved Den org and environment handling so local and dev setups sync more reliably and generate unique org slugs.
- Fixed the local web helper path so `webdev:local` starts reliably from the script-driven workflow.

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

#### Published in changelog page
False

#### Published in docs
False

## v0.11.167

#### Commit
`5ac86e5a`

#### Released at
Unreleased draft release. Tagged at `2026-03-16T22:50:30-07:00`.

#### One-line summary
Keeps OpenWork Cloud controls reachable in Developer Mode so advanced cloud setup does not get stranded in Settings.

#### Main changes
- Kept the Settings Cloud controls visible when Developer Mode is enabled.
- Preserved the intended Cloud-and-Debug settings layout for advanced users working with OpenWork Cloud.
- Reduced the chance of users getting stuck in a hidden-cloud-state settings flow while configuring cloud features.

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

#### Published in changelog page
False

#### Published in docs
False

## v0.11.168

#### Commit
`603ddfee`

#### Released at
`2026-03-17T06:27:40Z`

#### One-line summary
Recovers the release with the intended Cloud-settings gating behavior and repaired release assets so installs can proceed cleanly again.

#### Main changes
- Hid the Settings Cloud tab unless Developer Mode is enabled, while still showing it when advanced users intentionally turn Developer Mode on.
- Routed desktop Den handoff back to General settings when Developer Mode is off so the UI does not strand users behind a hidden Cloud state.
- Refreshed lockfile and sidecar manifests and republished the full desktop asset set so release installs work again across platforms.

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

#### Published in changelog page
False

#### Published in docs
False

## v0.11.169

#### Commit
`9ea1957b`

#### Released at
`2026-03-18T00:11:42Z`

#### One-line summary
Hardens Den web handoff and open-in-web routing first, then restores a cleaner, more predictable session and sharing experience.

#### Main changes
- Separated Den browser and API base URLs and tightened proxy-safe handoff behavior so sign-in and worker launch flows stay reliable.
- Cleaned up session UX by removing the broken artifacts rail, flattening the reload banner, restoring composer focus after command actions, and polishing run status feedback.
- Simplified OpenWork Share preview cards and updated landing/onboarding routing so CTAs and preview surfaces behave more consistently.

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

#### Published in changelog page
False

#### Published in docs
False

## v0.11.170

#### Commit
`3869313b`

#### Released at
`2026-03-19T17:27:40Z`

#### One-line summary
Tailors the hosted web app for OpenWork Cloud first, then makes remote connection, billing, and desktop share-token flows much steadier.

#### Main changes
- Tailored the hosted web app and Den onboarding flow for OpenWork Cloud with smoother app routes, checkout, and billing recovery.
- Kept remote connections steadier by persisting worker share tokens across restarts, restoring repeated shared-skill deeplinks, and preserving open-in-web auto-connect behavior.
- Improved day-to-day usability with self-serve Cloud settings, OpenAI headless auth in the provider modal, worker overlays during connect, and tray-on-close desktop behavior.

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

#### Published in changelog page
False

#### Published in docs
False

## v0.11.171

#### Commit
`10ec28d6`

#### Released at
Unreleased draft release. Tagged at `2026-03-19T14:01:13-07:00`.

#### One-line summary
Reduces desktop startup risk first, then makes session traces expand only when useful while the repo layout moves into a cleaner structure.

#### Main changes
- Removed stray desktop token-store test code that could interfere with release reliability and startup behavior.
- Changed session traces so rows only expand when they actually have details, with better mobile and wrapped-detail presentation.
- Reworked the repository folder structure to keep builds, release tooling, and package paths aligned after the workspace move.

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

#### Published in changelog page
False

#### Published in docs
False

## v0.11.172

#### Commit
`d47a194d`

#### Released at
`2026-03-19T22:28:14Z`

#### One-line summary
Standardizes the published server package name first, then tightens session trace alignment so run timelines are easier to scan.

#### Main changes
- Renamed the published OpenWork server package references to `openwork-server` so install, publish, and version checks all agree.
- Aligned session trace icons with their summaries for a cleaner timeline row.
- Centered the session trace chevrons with summaries so expansion controls read more clearly.

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

#### Published in changelog page
False

#### Published in docs
False

## v0.11.173

#### Commit
`5f0e11ce`

#### Released at
`2026-03-20T00:55:12Z`

#### One-line summary
Adds Daytona worker activity heartbeats first, then improves local tool spawning so nvm-managed Node setups work more reliably.

#### Main changes
- Added Daytona worker activity heartbeats so worker liveness and activity can be tracked more reliably.
- Added Daytona snapshot release automation so released runtime snapshots can stay in sync with the current worker environment.
- Exposed nvm-managed Node tools to local spawns so local OpenWork commands can find the expected Node toolchain.

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

#### Published in changelog page
False

#### Published in docs
False

## v0.11.174

#### Commit
`9f3890f6`

#### Released at
Unreleased draft release. Tagged at `2026-03-19T18:59:35-07:00`.

#### One-line summary
Restores the original session trace behavior first, then brings back copy actions and better worker-name readability in compact sidebars.

#### Main changes
- Restored the original session trace behavior for a more predictable run timeline.
- Brought back trace summary copy actions so users can copy key run details again.
- Preserved worker names in narrow sidebars so active context stays readable in compact layouts.

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

#### Published in changelog page
False

#### Published in docs
False

## v0.11.175

#### Commit
`da0cd71c`

#### Released at
`2026-03-20T05:53:41Z`

#### One-line summary
Adds settings-based folder authorization and clearer server-backed empty states first, then tightens sidebar and composer readability across the app shell.

#### Main changes
- Added settings support for managing authorized folders so users can control filesystem access without leaving the product flow.
- Added server-backed session empty states to give clearer first-run and worker-setup guidance.
- Refined the app shell and session sidebar by removing the artifacts rail, restoring composer action labels, and improving action, title, timestamp, and footer visibility.

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

#### Published in changelog page
False

#### Published in docs
False


