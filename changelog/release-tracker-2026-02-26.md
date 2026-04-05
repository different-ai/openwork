# Release Changelog Tracker

Internal preparation file for release summaries. This is not yet published to the changelog page or docs.

## v0.11.125

#### Commit
`7225736f`

#### Released at
`2026-02-26T22:26:17Z`

#### Title
Unified workspace navigation and smoother downloads

#### One-line summary
Unifies workspace navigation across dashboard and session views while preventing download-heavy operations from freezing the app.

#### Main changes
- Reused the same workspace and session sidebar in dashboard and session views.
- Deduplicated equivalent remote workers and kept rows actionable during stale connects.
- Throttled download updates so large transfers stop freezing the desktop UI.

#### Lines of code changed since previous release
710 lines changed since `v0.11.124` (160 insertions, 550 deletions).

#### Release importance
Minor release: fixes two painful interaction problems in core navigation and system responsiveness without introducing a new workflow.

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
- Unified sidebar and workspace switching behavior so navigation stays consistent and actionable.
- Added download throttling to prevent UI freezes during large transfers.

#### Deprecated features
False

#### Number of deprecated features
0

#### Deprecated details
None.

## v0.11.126

#### Commit
`42f68d9b`

#### Released at
`2026-02-27T15:47:46Z`

#### Title
Simpler artifacts and direct workspace actions

#### One-line summary
Simplifies artifact handling and adds direct worker and plugin actions so common cleanup and file workflows take fewer steps.

#### Main changes
- Replaced the inline artifact markdown editor with simpler reveal and open actions.
- Added Open in Obsidian for markdown and Reveal in Finder or Explorer for local workers.
- Added direct plugin removal and worker reveal actions from the main UI.

#### Lines of code changed since previous release
885 lines changed since `v0.11.125` (360 insertions, 525 deletions).

#### Release importance
Minor release: simplifies artifact management and adds faster workspace controls without changing OpenWork's overall workflow model.

#### Major improvements
True

#### Number of major improvements
1

#### Major improvement details
- Added direct worker and plugin quick actions so common workspace management tasks can be done from the main app surfaces.

#### Major bugs resolved
False

#### Number of major bugs resolved
0

#### Major bug fix details
None.

#### Deprecated features
True

#### Number of deprecated features
1

#### Deprecated details
- Replaced the in-app artifact markdown editor with a simpler read-only artifact action flow.

## v0.11.127

#### Commit
`7f3f70b0`

#### Released at
`2026-02-28T02:48:07Z`

#### Title
Get back online recovery and smarter Docker dev-up

#### One-line summary
Makes worker recovery clearer and preserves existing access, while smoothing Docker dev stacks for developers using local OpenCode config.

#### Main changes
- Added a plain-language Get back online action for remote worker recovery.
- Reused existing OpenWork tokens during sandbox restarts so reconnects keep working.
- Updated `dev-up.sh` to mount host OpenCode config and auth into Docker dev stacks.

#### Lines of code changed since previous release
370 lines changed since `v0.11.126` (325 insertions, 45 deletions).

#### Release importance
Minor release: improves worker recovery clarity and token stability with a focused reliability update.

#### Major improvements
True

#### Number of major improvements
1

#### Major improvement details
- Added a clearer in-app `Get back online` recovery action for workers.

#### Major bugs resolved
True

#### Number of major bugs resolved
1

#### Major bug fix details
- Fixed worker recovery so sandbox restarts can reconnect without rotating existing OpenWork tokens.

#### Deprecated features
False

#### Number of deprecated features
0

#### Deprecated details
None.

## v0.11.128

#### Commit
`da183cf7`

#### Released at
`2026-03-01T18:40:52Z`

#### Title
Remote file sessions, Obsidian sync, and long-chat readability

#### One-line summary
Adds live remote file sessions with Obsidian-backed editing, then makes long desktop conversations easier to read and follow.

#### Main changes
- Added short-lived file sessions with catalog, event, read, write, rename, and delete batch APIs.
- Mirrored remote markdown into Obsidian and synced edits back to the worker.
- Added desktop-wide zoom shortcuts while cleaning transcript noise and live-thinking scroll behavior.

#### Lines of code changed since previous release
2719 lines changed since `v0.11.127` (2612 insertions, 107 deletions).

#### Release importance
Minor release: materially expands remote file workflows and readability, but does so as focused product improvements rather than a fundamental platform shift.

#### Major improvements
True

#### Number of major improvements
3

#### Major improvement details
- Added just-in-time file sessions for remote file workflows.
- Added batch sync support for mirrored remote files.
- Added desktop-wide font zoom shortcuts and whole-webview zoom for readability.

#### Major bugs resolved
True

#### Number of major bugs resolved
3

#### Major bug fix details
- Fixed transcript rendering so synthetic control-only parts no longer appear in the user-facing conversation.
- Fixed live thinking updates so the transcript auto-scrolls more reliably during active runs.
- Fixed recovery and desktop startup edge cases, including stale base URL restoration and blocking recover actions.

#### Deprecated features
False

#### Number of deprecated features
0

#### Deprecated details
None.

## v0.11.129

#### Commit
`76a8217e`

#### Released at
`2026-03-02T02:35:51Z`

#### Title
Self-serve billing and media-rich messaging

#### One-line summary
Expands cloud billing into a self-serve management flow and lets Slack and Telegram carry richer OpenWork Router messages.

#### Main changes
- Added billing plan details, invoices, and subscription actions in the cloud worker dashboard.
- Extended Slack and Telegram delivery to send richer media, not just plain text.
- Hardened billing lookups and post-checkout navigation so account state refreshes more reliably.

#### Lines of code changed since previous release
3238 lines changed since `v0.11.128` (3061 insertions, 177 deletions).

#### Release importance
Minor release: adds two meaningful user-facing capabilities in billing and messaging without materially changing how the core product is operated.

#### Major improvements
True

#### Number of major improvements
2

#### Major improvement details
- Added billing subscription controls and invoice history in the web cloud dashboard.
- Added first-class media transport for Slack and Telegram in OpenWork Router.

#### Major bugs resolved
True

#### Number of major bugs resolved
1

#### Major bug fix details
- Improved billing flow reliability and navigation so subscription management behaves more consistently in the web experience.

#### Deprecated features
False

#### Number of deprecated features
0

#### Deprecated details
None.

## v0.11.130

#### Commit
`d1dee3ce`

#### Released at
`2026-03-02T16:58:05Z`

#### Title
Service restarts and steadier local connectivity

#### One-line summary
Adds in-app restart controls, makes router startup recover from local port conflicts, and smooths billing returns from checkout.

#### Main changes
- Added Settings actions to restart orchestrator, OpenCode, OpenWork server, and OpenCodeRouter.
- Moved OpenCodeRouter onto conflict-free localhost health ports and retried startup failures automatically.
- Restored billing state after checkout returns and dropped Telegram self-echo loops.

#### Lines of code changed since previous release
637 lines changed since `v0.11.129` (540 insertions, 97 deletions).

#### Release importance
Minor release: focuses on service recovery and billing-flow reliability with targeted fixes and controls.

#### Major improvements
True

#### Number of major improvements
1

#### Major improvement details
- Added in-app restart controls for local services in desktop settings.

#### Major bugs resolved
True

#### Number of major bugs resolved
3

#### Major bug fix details
- Fixed router startup so local connectivity is less likely to fail during desktop launch.
- Fixed billing session recovery after checkout redirects in the web cloud flow.
- Fixed Telegram router handling so bot-authored echoes no longer create noisy loops.

#### Deprecated features
False

#### Number of deprecated features
0

#### Deprecated details
None.

## v0.11.131

#### Commit
`de9b5cc6`

#### Released at
`2026-03-04T17:15:52Z`

#### Title
Virtualized chats and clearer runtime status

#### One-line summary
Keeps long sessions responsive with virtualized rendering, clearer runtime status, and optional auto-compaction after runs finish.

#### Main changes
- Virtualized long transcripts so large chats stay responsive instead of rendering every message at once.
- Replaced split engine and server badges with one Ready indicator that opens a detailed status popover.
- Added automatic context compaction after runs, plus persistent language selection and sturdier file opening.

#### Lines of code changed since previous release
1494 lines changed since `v0.11.130` (1134 insertions, 360 deletions).

#### Release importance
Major release: substantially improves how users run and monitor long OpenWork sessions through rendering, status, and compaction changes across core app surfaces.

#### Major improvements
True

#### Number of major improvements
4

#### Major improvement details
- Added virtualized session rendering for long chats.
- Added a unified status indicator with a detail popover.
- Added an automatic context compaction toggle.
- Added persistent language selection in settings.

#### Major bugs resolved
True

#### Number of major bugs resolved
3

#### Major bug fix details
- Fixed a regression where virtualized sessions could show blank transcripts.
- Fixed editor and artifact file opening so local file targets resolve more reliably.
- Fixed cross-session visibility for pending subagent prompts so important follow-up work is easier to notice.

#### Deprecated features
False

#### Number of deprecated features
0

#### Deprecated details
None.

## v0.11.132

#### Commit
`1f641dbf`

#### Released at
`2026-03-05T00:06:28Z`

#### Title
Chat-first startup and faster long-session loading

#### One-line summary
Preserves the new-session launch state, fixes first-run setup, and makes long chats load from the latest messages with less lag.

#### Main changes
- Kept `/session` as an empty draft view instead of bouncing users into an older chat.
- Added a first-run worker empty state, created the first chat automatically, and routed non-media uploads into inbox links.
- Opened sessions at the latest messages, paged older history on demand, and collapsed oversized markdown by default.

#### Lines of code changed since previous release
611 lines changed since `v0.11.131` (447 insertions, 164 deletions).

#### Release importance
Minor release: tightens startup, first-run, and transcript responsiveness issues in the core session experience.

#### Major improvements
False

#### Number of major improvements
0

#### Major improvement details
None.

#### Major bugs resolved
True

#### Number of major bugs resolved
4

#### Major bug fix details
- Fixed startup so `/session` can remain an empty draft state instead of redirecting away unexpectedly.
- Fixed first-run chat creation so new users land in a usable conversation flow.
- Fixed non-media upload handling so those files go to the inbox flow correctly.
- Fixed conversation opening behavior so sessions land at the latest messages instead of an older position.

#### Deprecated features
False

#### Number of deprecated features
0

#### Deprecated details
None.

## v0.11.133

#### Commit
`f11cad48`

#### Released at
`2026-03-05T15:54:31Z`

#### Title
Chat transcripts stop flickering during typing

#### One-line summary
Keeps active and long-running sessions visually stable by fixing typing flicker, remount churn, and collapsed long-message resets.

#### Main changes
- Fixed transcript flicker while typing in active chats.
- Kept long sessions steadier by reducing remount churn in tail-loaded message lists.
- Preserved expanded long-markdown state instead of collapsing it again mid-session.

#### Lines of code changed since previous release
292 lines changed since `v0.11.132` (163 insertions, 129 deletions).

#### Release importance
Minor release: delivers a focused session-rendering stability pass for active and long-running chats.

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
- Fixed transcript flicker that could appear while typing in active chats.
- Fixed remount churn in tail-loaded virtualized sessions.
- Fixed long-markdown collapse state so it no longer resets unexpectedly.

#### Deprecated features
False

#### Number of deprecated features
0

#### Deprecated details
None.

## v0.11.134

#### Commit
`d1658182`

#### Released at
`2026-03-06T07:28:11Z`

#### Title
Remote MCP setup gets lighter, with exportable desktop diagnostics

#### One-line summary
Makes remote-workspace MCP connection setup clearer and adds in-app debug exports, sandbox probes, and config actions for faster troubleshooting.

#### Main changes
- Remote workspaces now steer MCP setup toward URL-based connections, with optional OAuth and safer reload prompts.
- Settings can copy or export a runtime debug report and run a sandbox probe.
- Settings can also reveal or reset workspace config without leaving the app.

#### Lines of code changed since previous release
852 lines changed since `v0.11.133` (789 insertions, 63 deletions).

#### Release importance
Minor release: improves remote setup and troubleshooting with targeted workflow and diagnostics additions.

#### Major improvements
True

#### Number of major improvements
3

#### Major improvement details
- Simplified remote MCP setup for remote workspaces.
- Added exportable debug reports and config actions in Settings.
- Added sandbox probe diagnostics export for desktop troubleshooting.

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

## v0.11.135

#### Commit
`5d7185b4`

#### Released at
`2026-03-06T19:43:28Z`

#### Title
Bundled OpenCode version stays aligned across release paths

#### One-line summary
Pins the packaged OpenCode fallback consistently across CI, prerelease, and release builds, with no notable new app workflow changes.

#### Main changes
Keeps the bundled OpenCode fallback pinned to the same version across CI, prerelease, and release artifacts so packaged builds drift less, without introducing new user-facing OpenWork workflows.

#### Lines of code changed since previous release
61 lines changed since `v0.11.134` (31 insertions, 30 deletions).

#### Release importance
Minor release: tightens release-path consistency for bundled OpenCode behavior without adding new user-facing product workflows.

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

## v0.11.136

#### Commit
`83593bdf`

#### Released at
`2026-03-10T04:00:32Z`

#### Title
OpenWork Share turns dropped files into worker packages

#### One-line summary
Adds a real worker-packaging flow in OpenWork Share, rebuilds the share site on the Next.js App Router, and makes provider connections easier to manage.

#### Main changes
- OpenWork Share now packages dropped skills, agents, commands, and MCP or OpenWork config into worker bundles.
- The share site moves to the Next.js App Router with refreshed home and bundle pages.
- Settings now lets users disconnect providers, while OAuth completion and sandbox startup recover more reliably.

#### Lines of code changed since previous release
12837 lines changed since `v0.11.135` (9531 insertions, 3306 deletions).

#### Release importance
Major release: substantially changes the share workflow and related web surfaces while also landing broad reliability and account-management improvements across core product areas.

#### Major improvements
True

#### Number of major improvements
3

#### Major improvement details
- Turned OpenWork Share into a worker packager.
- Replatformed OpenWork Share onto the Next.js App Router.
- Added provider disconnect controls in Settings.

#### Major bugs resolved
True

#### Number of major bugs resolved
3

#### Major bug fix details
- Fixed provider OAuth polling so connection flows complete more reliably.
- Fixed sandbox Docker preflight hangs that could block local startup.
- Fixed theme and workspace-state issues that made desktop and session behavior less predictable.

#### Deprecated features
False

#### Number of deprecated features
0

#### Deprecated details
None.

## v0.11.137

#### Commit
`cc5700a1`

#### Released at
`2026-03-11T06:01:10Z`

#### Title
MCP sign-in retries and model setup get clearer

#### One-line summary
Makes MCP OAuth flows recover more reliably and reorganizes the model picker so disconnected providers route users straight to setup.

#### Main changes
- MCP auth now waits through reloads, reopens the browser flow clearly, and keeps retry states visible.
- The model picker separates enabled providers from setup-needed ones and links the latter to Settings.
- Remote MCP cards now expose login actions before a server is connected.

#### Lines of code changed since previous release
734 lines changed since `v0.11.136` (562 insertions, 172 deletions).

#### Release importance
Minor release: focuses on auth and model-selection reliability with a small follow-up packaging alignment fix.

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
- Fixed MCP auth connection flows so browser handoff, retry, and reconnect behavior are more reliable.
- Fixed model picker provider grouping and routing so provider setup actions are clearer and less error-prone.

#### Deprecated features
False

#### Number of deprecated features
0

#### Deprecated details
None.

## v0.11.138

#### Commit
`5307ce16`

#### Released at
`2026-03-11T15:19:39Z`

#### Title
Shared bundle links now open the blueprints worker flow

#### One-line summary
Routes shared bundle imports into the blueprints-style worker creation path so new-worker links land in the setup flow users expect.

#### Main changes
Shared bundle deep links now open the worker-creation flow with the right blueprints preset, then continue import through the intended setup path instead of dropping users into the wrong workspace flow.

#### Lines of code changed since previous release
143 lines changed since `v0.11.137` (101 insertions, 42 deletions).

#### Release importance
Minor release: delivers a focused fix for shared bundle import routing without broader product-surface changes.

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
- Fixed shared bundle imports so they route through the blueprints flow instead of landing in the wrong setup path.

#### Deprecated features
False

#### Number of deprecated features
0

#### Deprecated details
None.

## v0.11.140

#### Commit
`77d2f1cc`

#### Released at
`2026-03-11T19:14:14Z`

#### Title
Shared bundle imports land on the intended worker

#### One-line summary
Makes shared bundle imports resolve to the exact active or newly created worker and adds more actionable sandbox startup diagnostics.

#### Main changes
- Imports now match the active or newly created worker by workspace ID, local root, or directory hint.
- Sandbox startup logs now capture resolved Docker paths and launch arguments in the debug report.
- Failed detached-worker launches surface clearer stage and spawn diagnostics.

#### Lines of code changed since previous release
460 lines changed since `v0.11.138` (364 insertions, 96 deletions).

#### Release importance
Minor release: fixes import targeting and worker startup clarity without materially changing OpenWork's overall product shape.

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
- Fixed shared skill imports so they open on the worker that was just created instead of misrouting users afterward.
- Improved sandbox startup diagnostics so failed worker launches provide clearer recovery information.

#### Deprecated features
False

#### Number of deprecated features
0

#### Deprecated details
None.

## v0.11.141

#### Commit
`9af84bd0`

#### Released at
`2026-03-12T01:33:57Z`

#### Title
App and worker opens stay on the new session screen

#### One-line summary
Keeps launch actions anchored on the new session flow while making oversized-context errors, share feedback, and support booking clearer.

#### Main changes
- Opening the app or a new worker now stays on the new-session screen instead of jumping away unexpectedly.
- The todo strip docks to the composer, and HTTP 413 errors now suggest compaction or a fresh session.
- OpenWork Share adds inline link-success feedback, and the Book a Call form gets clearer topic cards.

#### Lines of code changed since previous release
5453 lines changed since `v0.11.140` (3894 insertions, 1559 deletions).

#### Release importance
Minor release: improves session flow, share feedback, and support-entry polish without introducing a major product-level shift.

#### Major improvements
True

#### Number of major improvements
2

#### Major improvement details
- Refreshed the Book a Call form with conversation topics and a more usable layout.
- Added inline success feedback and richer content handling on OpenWork Share surfaces.

#### Major bugs resolved
True

#### Number of major bugs resolved
4

#### Major bug fix details
- Kept app and worker open actions anchored on the new session screen.
- Docked the todo strip to the composer so long session flows feel more coherent.
- Added a clearer user-facing message for HTTP 413 context-too-large failures.
- Included stage diagnostics in sandbox probe timeout errors so desktop startup failures are easier to diagnose.

#### Deprecated features
False

#### Number of deprecated features
0

#### Deprecated details
None.

## v0.11.142

#### Commit
`f9b586ae`

#### Released at
`2026-03-12T01:48:01Z`

#### Title
Version alignment patch

#### One-line summary
Republishes synchronized app, server, orchestrator, and router versions so shipped artifacts stay in lockstep, with no visible workflow changes.

#### Main changes
Republishes synchronized desktop, server, orchestrator, and router packages so installs resolve the same version everywhere. No clear user-facing or developer-facing workflow changes land in this patch.

#### Lines of code changed since previous release
26 lines changed since `v0.11.141` (13 insertions, 13 deletions).

#### Release importance
Minor release: keeps release artifacts aligned for distribution without changing how users use OpenWork.

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

## v0.11.143

#### Commit
`41aeb178`

#### Released at
`2026-03-12T20:51:40Z`

#### Title
Free first Den worker and Google signup

#### One-line summary
Lets new users create one free Den worker without billing, sign up with Google, and enter a much clearer cloud onboarding path.

#### Main changes
Den now lets new users create one free cloud worker without billing and sign up with Google.

Also released:

- Retired remaining Soul-mode surfaces across the app and server.
- Showed session errors inline, removed raw markdown flashes, and refreshed share bundle pages and previews.

#### Lines of code changed since previous release
9937 lines changed since `v0.11.142` (6244 insertions, 3693 deletions).

#### Release importance
Major release: meaningfully changes the Den onboarding and cloud-worker experience while also retiring older Soul-mode surfaces.

#### Major improvements
True

#### Number of major improvements
5

#### Major improvement details
- Refreshed the Den landing page with a much fuller hero, comparison, support, and CTA flow.
- Allowed one free cloud worker without billing.
- Added Google authentication to Den signup.
- Added Den worker runtime upgrade messaging and controls.
- Restyled shared bundle pages and Open Graph previews for public sharing.

#### Major bugs resolved
True

#### Number of major bugs resolved
2

#### Major bug fix details
- Showed session errors inline in chat instead of leaving failures harder to interpret.
- Prevented raw markdown from flashing while streaming responses render.

#### Deprecated features
True

#### Number of deprecated features
1

#### Deprecated details
- Removed remaining Soul mode surfaces from the app.

## v0.11.144

#### Commit
`5ddc4647`

#### Released at
`2026-03-12T22:53:50Z`

#### Title
Workspace shell recovery and clearer docs entrypoints

#### One-line summary
Restores reliable workspace-shell navigation and reset recovery, seeds Chrome DevTools setup correctly, and splits docs paths for technical and non-technical readers.

#### Main changes
- Kept dashboard, session, and Settings navigation inside the workspace shell so sidebars stay reachable.
- Fully cleared desktop reset state on relaunch and seeded Control Chrome as `chrome-devtools` for smoother MCP setup.
- Split docs entrypoints into technical and non-technical paths so onboarding starts in the right place.

#### Lines of code changed since previous release
1185 lines changed since `v0.11.143` (868 insertions, 317 deletions).

#### Release importance
Minor release: focuses on reliability and navigation fixes plus targeted polish to Den and MCP setup.

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
- Kept workspace shell navigation reachable across dashboard and session flows.
- Fully cleared desktop reset state on relaunch so recovery actually resets cleanly.
- Seeded Control Chrome as `chrome-devtools` so browser-tooling setup works more predictably.

#### Deprecated features
False

#### Number of deprecated features
0

#### Deprecated details
None.

## v0.11.145

#### Commit
`8ceed304`

#### Released at
`2026-03-13T05:47:09Z`

#### Title
Den admin backoffice and support routing

#### One-line summary
Adds a protected Den admin panel for support operations, routes enterprise contact submissions into Loops, and tightens desktop skill reload and settings diagnostics.

#### Main changes
- Added a protected Den admin backoffice with signup, worker, and billing visibility for internal support.
- Routed enterprise contact requests into Loops and restored a mobile logout path in Den.
- Surfaced skill reload and sharing feedback more clearly and moved runtime status into Settings > Advanced.

#### Lines of code changed since previous release
2493 lines changed since `v0.11.144` (2031 insertions, 462 deletions).

#### Release importance
Minor release: adds a focused operator capability and several UX improvements without broadly reshaping the OpenWork product.

#### Major improvements
True

#### Number of major improvements
2

#### Major improvement details
- Added a Den admin backoffice dashboard for internal support and worker operations.
- Wired enterprise contact submissions into Loops for follow-up handling.

#### Major bugs resolved
True

#### Number of major bugs resolved
2

#### Major bug fix details
- Improved skill sharing and hot-reload flows in the desktop app.
- Restored a mobile logout path in Den.

#### Deprecated features
False

#### Number of deprecated features
0

#### Deprecated details
None.

## v0.11.146

#### Commit
`8809a801`

#### Released at
`2026-03-13T19:14:51Z`

#### Title
Failed worker redeploy and safer skill imports

#### One-line summary
Adds direct Den worker redeploys, makes shared skills pick a destination worker before import, and improves both local Den setup and Chrome-first guidance.

#### Main changes
- Added a redeploy action for failed Den workers so users can recover instead of getting stuck.
- Made shared skill imports choose a destination worker before import, including new-worker and remote-worker paths.
- Added a dockerized local Den test stack and pushed browser setup toward the Chrome MCP path.

#### Lines of code changed since previous release
3499 lines changed since `v0.11.145` (2158 insertions, 1341 deletions).

#### Release importance
Minor release: improves recovery, import routing, and shell usability in focused ways without a major product-level change.

#### Major improvements
True

#### Number of major improvements
2

#### Major improvement details
- Added a failed-worker redeploy action in Den.
- Added destination-worker selection before importing shared skills.

#### Major bugs resolved
True

#### Number of major bugs resolved
2

#### Major bug fix details
- Kept the status footer more stable when moving between settings and sessions.
- Made the browser quickstart target Chrome MCP first so setup guidance matches the expected path better.

#### Deprecated features
False

#### Number of deprecated features
0

#### Deprecated details
None.

## v0.11.147

#### Commit
`a829371b`

#### Released at
`2026-03-14T01:31:52Z`

#### Title
Existing-worker imports and local Share publishing

#### One-line summary
Lets shared skills install into existing workers, adds a local Docker-backed Share publisher for self-hosted testing, and keeps Den worker provisioning current.

#### Main changes
Shared skills can now be imported straight into an existing worker from the app.

Also released:

- Added a local Docker-backed Share publisher for self-hosted dev flows.
- Bundled fresh OpenCode builds for Den workers and improved missing Chrome extension guidance.

#### Lines of code changed since previous release
1727 lines changed since `v0.11.146` (1551 insertions, 176 deletions).

#### Release importance
Minor release: extends sharing workflows and fixes setup friction without materially changing OpenWork's overall architecture.

#### Major improvements
True

#### Number of major improvements
3

#### Major improvement details
- Added an existing-worker import flow for shared skills.
- Added a local Docker publisher flow for OpenWork Share.
- Bundled OpenCode for Den Render workers so worker provisioning is more self-contained.

#### Major bugs resolved
True

#### Number of major bugs resolved
3

#### Major bug fix details
- Added in-app guidance when the Chrome control extension is missing.
- Fixed long pasted skill previews so wrapping remains readable.
- Stopped pinning stale OpenCode builds in Den worker provisioning.

#### Deprecated features
False

#### Number of deprecated features
0

#### Deprecated details
None.

## v0.11.148

#### Commit
`9a3aef42`

#### Released at
`2026-03-14T22:28:03Z`

#### Title
Guided Den onboarding and single-skill Share

#### One-line summary
Turns Den signup into a calmer guided flow with clearer provisioning states while refocusing OpenWork Share on publishing one skill well.

#### Main changes
- Rebuilt Den onboarding as a guided flow with clearer naming, intent, loading, and browser-access states.
- Simplified OpenWork Share to publish a single skill, with cleaner frontmatter and fuller shared previews.
- Added a polished feedback card and clearer import and status feedback across app surfaces.

#### Lines of code changed since previous release
4390 lines changed since `v0.11.147` (2764 insertions, 1626 deletions).

#### Release importance
Major release: substantially changes both Den onboarding and the OpenWork Share publishing flow in ways users will immediately notice.

#### Major improvements
True

#### Number of major improvements
3

#### Major improvement details
- Redesigned Den onboarding into a guided stepper flow.
- Simplified OpenWork Share to publish a single skill.
- Added a polished feedback entrypoint card in Settings.

#### Major bugs resolved
True

#### Number of major bugs resolved
2

#### Major bug fix details
- Polished the shared skill import flow so import progress and outcomes are clearer.
- Slimmed session sidebar density so active chat navigation is easier to scan.

#### Deprecated features
False

#### Number of deprecated features
0

#### Deprecated details
None.

## v0.11.149

#### Commit
`6acc6f79`

#### Released at
`2026-03-14T23:56:20Z`

#### Title
Richer skill previews and steadier jump-to-latest

#### One-line summary
Makes shared skill pages easier to evaluate before import, steadies the worker-selection flow, and keeps long chats pinned to the newest reply while thinking.

#### Main changes
- Simplified shared skill pages and added richer workspace previews before import.
- Steadied shared-skill deep-link handling and worker selection so imports fire once and land more predictably.
- Kept Jump to latest pinned during assistant thinking and reduced blank tail space in long chats.

#### Lines of code changed since previous release
3906 lines changed since `v0.11.148` (2531 insertions, 1375 deletions).

#### Release importance
Minor release: focuses on stabilizing sharing and long-chat behavior rather than introducing a new top-level workflow.

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
- Simplified shared skill pages so previews are easier to understand before import.
- Steadied the shared skill import flow so destination handling behaves more predictably.
- Kept Jump to latest pinning stable while long responses are still streaming.

#### Deprecated features
False

#### Number of deprecated features
0

#### Deprecated details
None.

## v0.11.150

#### Commit
`4f89e04d`

#### Released at
`2026-03-15T01:05:19Z`

#### Title
Faster provider setup and steadier chat rendering

#### One-line summary
Prioritizes common providers in new-session setup, reduces inline image churn while chatting, and routes feedback straight to the team inbox.

#### Main changes
- Moved common providers like OpenAI and Anthropic to the front and hid the redundant ChatGPT prompt in new-session setup.
- Reduced inline image rerender churn so active chats feel steadier.
- Kept Settings width stable and sent feedback from Settings directly to the team inbox.

#### Lines of code changed since previous release
342 lines changed since `v0.11.149` (241 insertions, 101 deletions).

#### Release importance
Minor release: delivers focused session and settings polish without materially changing OpenWork's broader workflows.

#### Major improvements
False

#### Number of major improvements
0

#### Major improvement details
None.

#### Major bugs resolved
True

#### Number of major bugs resolved
4

#### Major bug fix details
- Prioritized common providers in the auth flow so setup starts from the most likely choices.
- Hid a redundant ChatGPT prompt in the session flow.
- Reduced inline image churn during chat rendering.
- Kept the settings shell width stable and routed feedback to the team inbox.

#### Deprecated features
False

#### Number of deprecated features
0

#### Deprecated details
None.
