# Release Changelog Tracker

Internal preparation file for release summaries. This is not yet published to the changelog page or docs.

## v0.11.125

#### Commit
`7225736f`

#### Released at
`2026-02-26T22:26:17Z`

#### One-line summary
Makes navigation more consistent across dashboard and session views and prevents large downloads from freezing the UI.

#### Main changes
- Unified sidebar navigation and workspace switching so dashboard and session flows behave more consistently.
- Deduplicated equivalent remote workspace entries and relaxed stale connecting locks so workspace rows stay actionable.
- Added download throttling to prevent UI freezes during heavier transfer activity.

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

#### Published in changelog page
False

#### Published in docs
False


## v0.11.126

#### Commit
`42f68d9b`

#### Released at
`2026-02-27T15:47:46Z`

#### One-line summary
Simplifies artifact handling first, then adds quicker worker and plugin actions so common workspace management tasks take fewer steps.

#### Main changes
- Replaced the in-app artifact editor with simpler artifact actions, including reveal controls and better handling for markdown files.
- Added quick actions for workers and plugins so users can reveal workspaces, recover flows, and remove plugins directly from the UI.
- Trimmed session and dashboard complexity around artifacts so the desktop experience feels lighter and easier to scan.

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

#### Published in changelog page
False

#### Published in docs
False

## v0.11.127

#### Commit
`7f3f70b0`

#### Released at
`2026-02-28T02:48:07Z`

#### One-line summary
Makes worker recovery clearer and more reliable by adding a plain-language recovery action that keeps existing OpenWork access working.

#### Main changes
- Added a user-facing `Get back online` action in worker menus so recovery is easier to discover.
- Changed worker recovery to reuse existing OpenWork tokens instead of rotating them during sandbox restarts.
- Improved reconnection handling so recovering a worker is less likely to interrupt the current workspace flow.

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

#### Published in changelog page
False

#### Published in docs
False

## v0.11.128

#### Commit
`da183cf7`

#### Released at
`2026-03-01T18:40:52Z`

#### One-line summary
Expands remote file workflows with just-in-time file sessions and local mirror support, then makes long desktop sessions easier to read and follow.

#### Main changes
- Added just-in-time file sessions and batch sync so remote files can be opened and synced as part of the OpenWork workflow.
- Made remote worker markdown easier to work with locally by opening mirrored files through local tools such as Obsidian.
- Added desktop font zoom shortcuts and whole-webview zoom so long conversations and documents are easier to read.

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

#### Published in changelog page
False

#### Published in docs
False

## v0.11.129

#### Commit
`76a8217e`

#### Released at
`2026-03-02T02:35:51Z`

#### One-line summary
Adds self-serve billing controls in the web cloud dashboard and expands messaging connectors with first-class media delivery.

#### Main changes
- Added billing subscription controls in the web cloud worker dashboard so users can manage subscriptions directly.
- Added invoice visibility in the billing flow so past charges are easier to review.
- Added first-class media transport for Slack and Telegram so OpenWork router messages can carry richer content.

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

#### Published in changelog page
False

#### Published in docs
False

## v0.11.130

#### Commit
`d1dee3ce`

#### Released at
`2026-03-02T16:58:05Z`

#### One-line summary
Makes local connectivity more dependable by hardening router startup, adding restart controls, and smoothing checkout return handling in billing.

#### Main changes
- Hardened desktop router startup so local services come up more predictably.
- Added in-app service restart controls so users can recover local connectivity without leaving the app.
- Recovered billing sessions after checkout redirects so returning from subscription flows lands back in a usable state.

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

#### Published in changelog page
False

#### Published in docs
False

## v0.11.131

#### Commit
`de9b5cc6`

#### Released at
`2026-03-04T17:15:52Z`

#### One-line summary
Upgrades long-session usability with faster rendering, clearer status feedback, and more durable session controls across the app.

#### Main changes
- Virtualized session message rendering and fixed blank transcript regressions so long conversations stay responsive.
- Added a unified status indicator with detail popover plus automatic context compaction controls for clearer session oversight.
- Added persistent language selection and improved file-open reliability for editor and artifact flows.

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

#### Published in changelog page
False

#### Published in docs
False

## v0.11.132

#### Commit
`1f641dbf`

#### Released at
`2026-03-05T00:06:28Z`

#### One-line summary
Makes session startup feel steadier by preserving empty-draft launches, opening chats at the latest messages, and reducing long-chat typing lag.

#### Main changes
- Preserved the empty-draft `/session` launch state so startup no longer forces users away from a fresh session flow.
- Fixed first-run behavior by creating an initial chat and routing non-media uploads into the inbox flow.
- Opened conversations at the latest messages and triggered transcript windowing earlier so long chats feel more responsive.

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

#### Published in changelog page
False

#### Published in docs
False

## v0.11.133

#### Commit
`f11cad48`

#### Released at
`2026-03-05T15:54:31Z`

#### One-line summary
Stabilizes active chat rendering so transcripts stop flickering while typing and long-message state holds together more reliably.

#### Main changes
- Fixed transcript flicker while typing in active chats.
- Reduced virtualized remount churn in tail-loaded conversations so long sessions feel steadier.
- Stopped collapsed long-markdown sections from resetting unexpectedly during session use.

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

#### Published in changelog page
False

#### Published in docs
False

## v0.11.134

#### Commit
`d1658182`

#### Released at
`2026-03-06T07:28:11Z`

#### One-line summary
Simplifies remote MCP connection setup and adds stronger desktop diagnostics so setup and troubleshooting are easier from inside OpenWork.

#### Main changes
- Simplified remote MCP setup for remote workspaces, including smoother auth and retry handling.
- Added exportable debug reports and config actions in Settings so troubleshooting can be done directly from the app.
- Added sandbox probe diagnostics export so desktop failures are easier to inspect and share.

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

#### Published in changelog page
False

#### Published in docs
False

## v0.11.135

#### Commit
`5d7185b4`

#### Released at
`2026-03-06T19:43:28Z`

#### One-line summary
Keeps packaged OpenCode resolution more consistent across CI, prerelease, and release paths, with no notable direct product-surface changes.

#### Main changes
- Kept fallback OpenCode resolution pinned consistently across release paths so packaged builds are less likely to drift.
- Reduced the chance of mismatched bundled behavior between prerelease and release artifacts.
- Shipped as a narrow stabilization patch with no notable new end-user features in the app or web surfaces.

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

#### Published in changelog page
False

#### Published in docs
False

## v0.11.136

#### Commit
`83593bdf`

#### Released at
`2026-03-10T04:00:32Z`

#### One-line summary
Reshapes OpenWork Share into a more capable packaging flow, upgrades it to the Next.js App Router, and lands a broad set of reliability and polish updates across app and web surfaces.

#### Main changes
- Turned OpenWork Share into a worker packager and simplified package creation so shared bundles are more useful as real setup artifacts.
- Replatformed OpenWork Share onto the Next.js App Router and refreshed its landing and bundle pages for a cleaner public sharing experience.
- Fixed provider OAuth polling and added provider disconnect controls in Settings so account connection management is more reliable.

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

#### Published in changelog page
False

#### Published in docs
False

## v0.11.137

#### Commit
`cc5700a1`

#### Released at
`2026-03-11T06:01:10Z`

#### One-line summary
Stabilizes MCP authentication and improves model picker clarity so provider connection and model selection feel more dependable.

#### Main changes
- Stabilized MCP auth browser handoff, reload, and reconnect paths so remote auth succeeds more reliably.
- Improved model picker provider sections so providers and their setup actions are easier to understand.
- Kept bundled OpenCode aligned with desktop builds so release validation and packaged behavior stay in sync.

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

#### Published in changelog page
False

#### Published in docs
False

## v0.11.138

#### Commit
`5307ce16`

#### Released at
`2026-03-11T15:19:39Z`

#### One-line summary
Fixes shared bundle imports so they route through the blueprints flow and land in the expected workspace setup path.

#### Main changes
- Routed shared bundle imports through the blueprints flow so imports follow the intended setup path.
- Improved workspace creation handoff during imports so shared bundles connect to the right setup flow.
- Updated the supporting app copy for the blueprints import path so the flow is easier to understand.

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

#### Published in changelog page
False

#### Published in docs
False

## v0.11.140

#### Commit
`77d2f1cc`

#### Released at
`2026-03-11T19:14:14Z`

#### One-line summary
Makes shared skill imports land on the newly created worker and gives users clearer sandbox startup diagnostics.

#### Main changes
- Shared bundle imports now target the worker that was just created, so imported skills land in the right place.
- Sandbox worker startup now surfaces richer diagnostics, making failed launches easier to understand and recover from.
- Workspace startup flow handling was tightened to reduce friction when bringing a worker online.

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

#### Published in changelog page
False

#### Published in docs
False

## v0.11.141

#### Commit
`9af84bd0`

#### Released at
`2026-03-12T01:33:57Z`

#### One-line summary
Keeps app and worker launches on the new session screen while improving session clarity and polishing sharing and support flows.

#### Main changes
- App and worker launch actions now keep users on the new session screen instead of pulling them into a different view unexpectedly.
- Session flow feels clearer with the todo strip docked to the composer and friendlier handling for oversized-context errors.
- Share and landing surfaces were polished with inline success feedback and a richer Book a Call form layout with conversation topics.

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

#### Published in changelog page
False

#### Published in docs
False

## v0.11.142

#### Commit
`f9b586ae`

#### Released at
`2026-03-12T01:48:01Z`

#### One-line summary
Rolls a coordinated patch cut that keeps shipped OpenWork artifacts aligned without adding material user-facing changes.

#### Main changes
- Shipped no material user-facing product changes in this release.
- Kept desktop, server, orchestrator, and router artifacts aligned on the same version so installs resolve consistently.
- Refreshed release metadata and lockfiles for a clean stable patch cut.

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

#### Published in changelog page
False

#### Published in docs
False

## v0.11.143

#### Commit
`41aeb178`

#### Released at
`2026-03-12T20:51:40Z`

#### One-line summary
Substantially expands Den by lowering signup friction, redesigning the landing flow, and improving how workers and chat errors behave.

#### Main changes
- Den now allows one free cloud worker without billing and adds Google signup, making it much easier to get started.
- The Den landing page was overhauled with a new hero, comparison, support, and CTA flow that explains the product more clearly.
- Session and sharing surfaces were polished with inline chat errors, no raw markdown flash during streaming, and refreshed share bundle pages and previews.

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

#### Published in changelog page
False

#### Published in docs
False

## v0.11.144

#### Commit
`5ddc4647`

#### Released at
`2026-03-12T22:53:50Z`

#### One-line summary
Restores reliable workspace-shell navigation and desktop recovery while polishing Den pricing surfaces and MCP browser setup.

#### Main changes
- Workspace shell navigation now stays reachable across dashboard and session flows, reducing dead-end navigation states.
- Desktop fully clears reset state on relaunch so recovery flows behave more reliably after a reset.
- Den pricing and capability cards were refined, and Control Chrome setup is seeded more predictably for MCP browser tooling.

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

#### Published in changelog page
False

#### Published in docs
False

## v0.11.145

#### Commit
`8ceed304`

#### Released at
`2026-03-13T05:47:09Z`

#### One-line summary
Adds a Den admin backoffice while sharpening Den worker flows, support capture, and desktop skill-sharing reliability.

#### Main changes
- Added a protected Den admin backoffice so internal operators can see signup, worker, and billing state without going to the database.
- Polished Den worker surfaces with clearer overview CTAs, lighter activity styling, and cleaner web/mobile actions.
- Wired enterprise contact capture into Loops and improved desktop skill sharing and hot-reload feedback.

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

#### Published in changelog page
False

#### Published in docs
False

## v0.11.146

#### Commit
`8809a801`

#### Released at
`2026-03-13T19:14:51Z`

#### One-line summary
Adds direct failed-worker recovery and smarter shared-skill importing while refreshing the workspace shell toward a calmer operator layout.

#### Main changes
- Den now offers a redeploy action for failed workers, giving users a direct recovery path instead of leaving the worker stuck.
- Shared skill import now asks users to choose a destination worker before importing, preventing skills from landing in the wrong place.
- The workspace shell was restyled closer to the operator layout, with steadier footer behavior and a Chrome-first browser quickstart.

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

#### Published in changelog page
False

#### Published in docs
False

## v0.11.147

#### Commit
`a829371b`

#### Released at
`2026-03-14T01:31:52Z`

#### One-line summary
Expands shared-skill importing to existing workers and makes Share more reliable for long skills and Den worker provisioning.

#### Main changes
- Shared skills can now be imported into an existing worker through a dedicated in-app flow.
- OpenWork Share handles long pasted skills better and adds a local Docker publisher flow for self-hosted publishing.
- Den and desktop setup flows were tightened with clearer Chrome extension guidance and fresher bundled OpenCode behavior for workers.

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

#### Published in changelog page
False

#### Published in docs
False

## v0.11.148

#### Commit
`9a3aef42`

#### Released at
`2026-03-14T22:28:03Z`

#### One-line summary
Redesigns Den onboarding into a guided stepper and simplifies OpenWork Share around publishing a single skill.

#### Main changes
- Den onboarding is now a guided stepper with clearer loading, provisioning, and browser-access states.
- OpenWork Share now centers on publishing a single skill, with cleaner frontmatter handling and a smoother import path.
- Settings gained a polished feedback entrypoint, while session surfaces were tightened with slimmer sidebars and clearer quickstart tips.

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

#### Published in changelog page
False

#### Published in docs
False

## v0.11.149

#### Commit
`6acc6f79`

#### Released at
`2026-03-14T23:56:20Z`

#### One-line summary
Simplifies shared skill pages and stabilizes both skill importing and staying pinned to the latest reply during long chats.

#### Main changes
- Shared skill pages were simplified and now show richer workspace previews before import.
- Shared skill import flow was steadied so destination selection and import actions behave more predictably.
- Session view stays pinned to the latest response more reliably while the assistant is still thinking.

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

#### Published in changelog page
False

#### Published in docs
False

## v0.11.150

#### Commit
`4f89e04d`

#### Released at
`2026-03-15T01:05:19Z`

#### One-line summary
Smooths session setup and chat rendering while routing in-app feedback to the team inbox and keeping settings layout steady.

#### Main changes
- Session setup now prioritizes common providers and removes a redundant ChatGPT prompt.
- Chat rendering reduces inline image churn so long conversations feel steadier.
- Settings keeps a more stable shell width and sends feedback directly to the team inbox.

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

#### Published in changelog page
False

#### Published in docs
False


