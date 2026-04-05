# Release Changelog Tracker

Internal preparation file for release summaries. This is not yet published to the changelog page or docs.

## v0.11.100

#### Commit
`a4601059`

#### Released at
`2026-02-19T17:49:05Z`

#### One-line summary
Stops long prompts from disappearing while typing, making the session composer reliable again.

#### Main changes
- Fixed a composer regression where long prompts could be overwritten by stale draft echoes.
- Hardened draft retention so typed text stays stable during longer session inputs.
- Shipped the fix in the `0.11.100` release with the usual package and metadata refresh.

#### Lines of code changed since previous release
98 lines changed since `v0.11.99` (58 insertions, 40 deletions).

#### Release importance
Minor release: restores composer draft stability so long prompts no longer disappear while typing.

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
- Fixed a session composer bug where long prompts could appear to clear or get replaced while you were typing.

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

## v0.11.101

#### Commit
`87fda845`

#### Released at
`2026-02-19T21:26:55Z`

#### One-line summary
Improves local session recovery first, then makes Soul easier to steer and cleans up compact controls across key app surfaces.

#### Main changes
- Added a local recovery flow for broken OpenCode migrations so desktop startup can repair itself instead of leaving users stuck.
- Improved Soul starter observability and steering so users can inspect and guide Soul behavior with clearer in-app controls.
- Refreshed compact action buttons across settings and sidebars to make update and connection actions easier to scan.

#### Lines of code changed since previous release
1248 lines changed since `v0.11.100` (933 insertions, 315 deletions).

#### Release importance
Minor release: improves local recovery, Soul steering, and interface clarity without changing the product's overall shape.

#### Major improvements
True

#### Number of major improvements
1

#### Major improvement details
- Added clearer Soul starter observability and steering controls in the app.

#### Major bugs resolved
True

#### Number of major bugs resolved
1

#### Major bug fix details
- Added a migration recovery flow so broken local OpenCode database state can be repaired from the app experience.

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

## v0.11.102

#### Commit
`f728cc3b`

#### Released at
`2026-02-20T00:00:11Z`

#### One-line summary
Clarifies when migration recovery is available so troubleshooting local startup issues feels more predictable.

#### Main changes
- Added clearer in-app feedback about whether migration recovery tooling is available for the current setup.
- Smoothed the settings and onboarding surfaces that support the migration recovery troubleshooting flow.
- Shipped as a narrow follow-up patch focused on making the new recovery path easier to understand.

#### Lines of code changed since previous release
168 lines changed since `v0.11.101` (100 insertions, 68 deletions).

#### Release importance
Minor release: improves recovery-flow clarity with a focused troubleshooting UX patch.

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
- Users can now see more clearly when migration recovery is available instead of guessing whether the repair flow should work.

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

## v0.11.103

#### Commit
`a1b7a5e1`

#### Released at
`2026-02-20T00:41:17Z`

#### One-line summary
Hardens Soul template safety first, then makes sidebar state more predictable across different workspace roots.

#### Main changes
- Prevented Soul template prompt-injection abuse so unsafe template content is less likely to steer users into unintended behavior.
- Scoped sidebar synchronization to the active workspace root so switching between workspaces feels more predictable.
- Kept the patch tightly focused on safety and multi-workspace consistency rather than adding new visible workflows.

#### Lines of code changed since previous release
83 lines changed since `v0.11.102` (47 insertions, 36 deletions).

#### Release importance
Major release: patches a meaningful Soul template security issue while also improving core multi-workspace behavior.

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
- Blocked Soul template prompt-injection behavior in app surfaces that expose Soul flows.
- Fixed sidebar sync so state no longer bleeds across different workspace roots as easily.

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

## v0.11.104

#### Commit
`091f13d2`

#### Released at
`2026-02-20T04:45:27Z`

#### One-line summary
Makes session follow-scroll user-controlled so reviewing earlier output is less likely to be interrupted.

#### Main changes
- Changed session follow-scroll behavior so users stay in control when they scroll away from the latest output.
- Reduced unwanted auto-follow jumps while active runs continue streaming into the session view.
- Focused the patch on reading comfort and session stability rather than broader feature work.

#### Lines of code changed since previous release
211 lines changed since `v0.11.103` (123 insertions, 88 deletions).

#### Release importance
Minor release: fixes an annoying session reading behavior without materially changing the surrounding workflow.

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
- Fixed session follow-scroll so it respects user scrolling instead of repeatedly pulling the view back to the live tail.

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

## v0.11.105

#### Commit
`45f5f07d`

#### Released at
`2026-02-20T05:12:11Z`

#### One-line summary
Removes automatic session scroll following so the timeline stops fighting users who are reading older output.

#### Main changes
- Removed automatic session scroll following from the session view so the app no longer keeps trying to drag users back downward.
- Simplified scrolling behavior around active runs so reading earlier content feels steadier.
- Shipped as a very narrow patch focused on the remaining session auto-scroll regression.

#### Lines of code changed since previous release
129 lines changed since `v0.11.104` (25 insertions, 104 deletions).

#### Release importance
Minor release: removes a disruptive session auto-scroll behavior with a tightly scoped UI fix.

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
- Removed the automatic session scroll-follow behavior that was still causing unwanted movement while users reviewed prior output.

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

## v0.11.106

#### Commit
`4e9260b9`

#### Released at
`2026-02-20T05:19:07Z`

#### One-line summary
Refreshes release metadata only, with no clear user-facing product change in this patch.

#### Main changes
- No notable end-user app, web, or desktop workflow changes appear in this release beyond release-metadata refresh work.
- Kept package resolution and shipped artifacts aligned after the prior patch release.
- Delivered as a maintenance-only follow-up with no visible feature or UX intent.

#### Lines of code changed since previous release
26 lines changed since `v0.11.105` (13 insertions, 13 deletions).

#### Release importance
Minor release: refreshes release metadata only, with no intended user-facing product change.

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

## v0.11.107

#### Commit
`76a307fc`

#### Released at
`2026-02-20T05:40:27Z`

#### One-line summary
Stops sessions from repeatedly snapping back to the top, making long conversations easier to stay anchored in.

#### Main changes
- Fixed a session bug that could repeatedly reset the view to the top during use.
- Made scroll position feel more stable while moving around active session content.
- Shipped as another narrow session UX patch rather than a broader workflow update.

#### Lines of code changed since previous release
43 lines changed since `v0.11.106` (29 insertions, 14 deletions).

#### Release importance
Minor release: fixes another focused session scrolling regression without changing the overall product experience.

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
- Fixed repeated session resets to the top of the timeline.

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

## v0.11.108

#### Commit
`3ae49df6`

#### Released at
`2026-02-20T18:14:52Z`

#### One-line summary
Adds readable share bundle pages first, then makes Soul enable flows sturdier and preserves unsent drafts across tab switches.

#### Main changes
- Added human-readable share bundle pages with JSON fallback so shared bundles are easier to inspect in a browser.
- Hardened Soul enable flows and steering audit behavior so enabling and reviewing Soul actions feels more reliable.
- Preserved composer drafts across tab switches so unsent work is less likely to disappear mid-session.

#### Lines of code changed since previous release
1160 lines changed since `v0.11.107` (966 insertions, 194 deletions).

#### Release importance
Minor release: adds a meaningful sharing improvement and reliability fixes without materially reshaping how OpenWork works overall.

#### Major improvements
True

#### Number of major improvements
1

#### Major improvement details
- Added browser-friendly share bundle pages with automatic JSON fallback.

#### Major bugs resolved
True

#### Number of major bugs resolved
2

#### Major bug fix details
- Hardened Soul enable and steering audit flows so they fail less often in user-visible app paths.
- Preserved composer drafts when switching tabs.

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

## v0.11.109

#### Commit
`a896defd`

#### Released at
`2026-02-20T20:51:01Z`

#### One-line summary
Makes automation setup less confusing while expanding skill discovery and MCP configuration support for more flexible setups.

#### Main changes
- Gated automations behind scheduler installation so users are not prompted into automation flows before the required tooling exists.
- Added support for skills grouped in domain folders so more organized skill libraries work correctly.
- Added global MCP configuration support so shared machine-level MCP servers can be picked up alongside project config.

#### Lines of code changed since previous release
410 lines changed since `v0.11.108` (321 insertions, 89 deletions).

#### Release importance
Minor release: improves setup predictability and expands advanced configuration support without changing the core product model.

#### Major improvements
True

#### Number of major improvements
2

#### Major improvement details
- Added support for domain-grouped skill folders.
- Added support for global MCP configuration alongside project-local config.

#### Major bugs resolved
True

#### Number of major bugs resolved
1

#### Major bug fix details
- Prevented automations from appearing as available before the scheduler dependency is installed.

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

## v0.11.110

#### Commit
`8f869772`

#### Released at
`2026-02-20T22:35:16Z`

#### One-line summary
Improves release and deployment plumbing behind the scenes, with no clear new end-user product behavior in this patch.

#### Main changes
- No notable user-facing app or workflow changes appear in this release beyond release-process hardening.
- Made updater platform metadata deterministic so shipped update manifests are generated more consistently.
- Reduced deployment risk by skipping unnecessary desktop builds during share-service Vercel deploys.

#### Lines of code changed since previous release
294 lines changed since `v0.11.109` (269 insertions, 25 deletions).

#### Release importance
Minor release: hardens release and deploy infrastructure without introducing intended user-facing product changes.

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

## v0.11.111

#### Commit
`12847be3`

#### Released at
`2026-02-20T23:04:52Z`

#### One-line summary
Ships synchronized version metadata only, with no distinct user-facing change evident in this release.

#### Main changes
- No notable end-user app, web, or desktop behavior changes are visible in this release.
- Kept package versions, runtime metadata, and dependency pins aligned for the shipped build.
- Served as a release-consistency checkpoint rather than a feature or UX update.

#### Lines of code changed since previous release
26 lines changed since `v0.11.110` (13 insertions, 13 deletions).

#### Release importance
Minor release: keeps release metadata aligned only, with no intended user-facing change.

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

## v0.11.112

#### Commit
`a0ceeae0`

#### Released at
`2026-02-21T01:19:34Z`

#### One-line summary
Cleans up the session tool timeline by removing step lifecycle noise so active runs are easier to scan.

#### Main changes
- Removed step start and finish noise from the tool timeline so sessions read more like a clean sequence of meaningful work.
- Improved grouping around reasoning and tool boundaries so the timeline feels easier to follow during complex runs.
- Shipped the rest of the patch as release and deployment support work rather than additional visible product changes.

#### Lines of code changed since previous release
233 lines changed since `v0.11.111` (178 insertions, 55 deletions).

#### Release importance
Minor release: improves session readability with a focused UI cleanup while the rest of the patch stays behind the scenes.

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
- Removed noisy lifecycle rows from the session tool timeline so users can scan meaningful progress more easily.

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

## v0.11.113

#### Commit
`83af293a`

#### Released at
`2026-02-21T01:58:50Z`

#### One-line summary
Speeds up session work with a new Cmd+K command palette for jumping between sessions and changing key chat settings in place.

#### Main changes
- Added a Cmd+K quick-actions palette so users can trigger common session actions without leaving the chat view.
- Made it faster to jump between sessions by searching and filtering them from the keyboard-first palette.
- Let users switch models and adjust thinking settings directly from quick actions during an active session.

#### Lines of code changed since previous release
558 lines changed since `v0.11.112` (534 insertions, 24 deletions).

#### Release importance
Minor release: adds a focused productivity feature that makes everyday session navigation and configuration faster.

#### Major improvements
True

#### Number of major improvements
1

#### Major improvement details
- Added a keyboard-first quick-actions palette for session navigation plus model and thinking controls.

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

## v0.11.114

#### Commit
`28596bf7`

#### Released at
`2026-02-22T06:00:46Z`

#### One-line summary
Introduces OpenWork Cloud workers through Den with a new web setup flow, persisted workers, and a much more complete remote-connect path.

#### Main changes
- Added the Den control plane and web app so users can provision real cloud workers through a guided 3-step setup flow.
- Made cloud workers easier to reconnect by persisting worker records, surfacing OpenWork connect credentials, and returning compatible workspace-scoped connect links.
- Improved cloud reliability and access control with completed OAuth setup, asynchronous worker provisioning with auto-polling, and Polar-gated paid access.

#### Lines of code changed since previous release
6726 lines changed since `v0.11.113` (6593 insertions, 133 deletions).

#### Release importance
Major release: introduces OpenWork Cloud worker provisioning and connect flows that materially change how users can start and use remote workers.

#### Major improvements
True

#### Number of major improvements
4

#### Major improvement details
- Added the Den control plane with real Render-backed cloud workers inside OpenWork.
- Shipped a new 3-step cloud worker setup experience in the web app.
- Persisted user workers and removed manual worker ID recovery from the hosted flow.
- Gated cloud workers behind Polar entitlements with a default hosted worker plan.

#### Major bugs resolved
True

#### Number of major bugs resolved
5

#### Major bug fix details
- Completed the provider OAuth connect flow inside the app modal.
- Returned compatible worker tokens for remote connect.
- Returned workspace-scoped connect URLs so cloud workers open with the right workspace context.
- Switched worker launch to asynchronous provisioning with auto-polling for better setup reliability.
- Fixed editor-mode file opening and removed reasoning text noise from the session timeline.

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

## v0.11.115

#### Commit
`74048ebb`

#### Released at
`2026-02-22T07:45:08Z`

#### One-line summary
Makes Telegram identity setup safer with private bot pairing codes and improves hosted auth recovery when the web proxy gets bad upstream responses.

#### Main changes
- Added a Telegram private bot pairing gate so private chats require an explicit `/pair <code>` flow before linking to a workspace.
- Surfaced the private bot pairing setup in OpenWork identities so users can complete messaging setup more clearly.
- Improved Den web auth reliability by failing over when the auth proxy receives broken 5xx HTML responses.

#### Lines of code changed since previous release
790 lines changed since `v0.11.114` (700 insertions, 90 deletions).

#### Release importance
Minor release: tightens messaging security and fixes a focused hosted auth reliability issue without changing the broader product shape.

#### Major improvements
True

#### Number of major improvements
1

#### Major improvement details
- Added a private Telegram bot pairing workflow that requires explicit approval before a chat can link to a workspace.

#### Major bugs resolved
True

#### Number of major bugs resolved
1

#### Major bug fix details
- Added auth-proxy failover for 5xx HTML responses so hosted sign-in flows recover more gracefully.

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

## v0.11.116

#### Commit
`a7b88238`

#### Released at
`2026-02-22T18:26:36Z`

#### One-line summary
Simplifies cloud-worker connection with a cleaner list-detail web flow and desktop deep links that open remote connects more directly.

#### Main changes
- Reworked the cloud worker web UI into a simpler list-detail layout so picking and connecting to workers feels less cluttered.
- Wired desktop deep links for `connect-remote` flows so hosted worker actions hand off into the app more smoothly.
- Tightened the cloud connect controls and layout to make the remote-connect path easier to follow.

#### Lines of code changed since previous release
870 lines changed since `v0.11.115` (664 insertions, 206 deletions).

#### Release importance
Minor release: improves a focused cloud-worker flow by making remote connection clearer across web and desktop.

#### Major improvements
True

#### Number of major improvements
2

#### Major improvement details
- Added a list-detail cloud worker connect experience in the web app.
- Wired desktop deep links so hosted remote-connect actions can open directly in the app.

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

## v0.11.117

#### Commit
`adeafe5a`

#### Released at
`2026-02-23T01:09:20Z`

#### One-line summary
Improves hosted worker management and session readability while hardening messaging and Den reliability in several user-visible failure paths.

#### Main changes
- Redesigned the cloud worker shell into a cleaner full-page experience with progressive disclosure, worker deletion, and custom worker domains.
- Split session turns into intent, execution, and result so tool-heavy chats are easier to scan.
- Fixed several high-friction reliability issues across hosted workers and messaging, including softer 502 handling, empty router reply recovery, and protection against transient Den database disconnects.

#### Lines of code changed since previous release
2207 lines changed since `v0.11.116` (1719 insertions, 488 deletions).

#### Release importance
Minor release: meaningfully improves hosted worker usability and session readability while staying within the existing product model.

#### Major improvements
True

#### Number of major improvements
3

#### Major improvement details
- Added worker delete support in the hosted cloud flow.
- Added custom worker domain support for hosted workers.
- Introduced explicit session turn segmentation into intent, execution, and result.

#### Major bugs resolved
True

#### Number of major bugs resolved
4

#### Major bug fix details
- Hardened Den against transient MySQL disconnect and reset conditions.
- Recovered messaging from empty router prompt replies.
- Stopped inbox refresh churn caused by auth memo changes.
- Softened hosted 502 failures and restored the worker detail pane layout.

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

## v0.11.118

#### Commit
`108d4efe`

#### Released at
`2026-02-23T02:49:35Z`

#### One-line summary
Makes long sessions feel faster and clearer while reducing technical noise in hosted worker controls.

#### Main changes
- Reduced composer latency in large conversations so typing stays responsive deeper into long sessions.
- Replaced technical timeline labels with clearer user-facing segment names for session turns.
- Hid advanced cloud worker controls behind disclosure and fixed hosted delete and vanity-domain edge cases for a cleaner default worker flow.

#### Lines of code changed since previous release
758 lines changed since `v0.11.117` (555 insertions, 203 deletions).

#### Release importance
Minor release: improves responsiveness and clarity in existing session and hosted-worker flows without changing core behavior.

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
- Reduced typing lag in long sessions by cutting composer layout churn.
- Updated session labels to use clearer, user-facing wording.
- Fixed hosted worker delete responses and added a safer fallback path for vanity domains.

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

## v0.11.119

#### Commit
`67844b38`

#### Released at
`2026-02-23T05:13:07Z`

#### One-line summary
Keeps long chats more responsive and polishes the landing and hosted web surfaces for a cleaner first-run experience.

#### Main changes
- Further reduced session composer reflow cost so long chats stay smoother while typing.
- Stretched cloud shell panels to the viewport so hosted worker screens use space more consistently.
- Refined the landing experience with clearer Den calls to action and a cleaner hero treatment.

#### Lines of code changed since previous release
308 lines changed since `v0.11.118` (197 insertions, 111 deletions).

#### Release importance
Minor release: focuses on performance polish and presentation improvements across existing session and onboarding surfaces.

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
- Reduced long-session composer reflow work to improve typing responsiveness in heavy chats.

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

## v0.11.120

#### Commit
`6cf077b3`

#### Released at
`2026-02-23T06:19:35Z`

#### One-line summary
Stabilizes session switching across workers and refreshes the landing hero so the product is easier to navigate and read.

#### Main changes
- Kept session lists visible when switching between workers so navigation stays stable across workspaces.
- Refreshed the landing hero shader and removed visual clutter for a cleaner first impression.
- Improved hero readability with stronger contrast, slower background motion, and simpler sticky navigation styling.

#### Lines of code changed since previous release
150 lines changed since `v0.11.119` (94 insertions, 56 deletions).

#### Release importance
Minor release: fixes a core navigation annoyance and adds focused landing-page polish.

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
- Fixed sidebar behavior so sessions remain visible while users switch across workers.

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

## v0.11.121

#### Commit
`b5f7814f`

#### Released at
`2026-02-23T06:46:26Z`

#### One-line summary
Makes session timelines read more naturally and improves the speed of quick actions, search, and composing in active chats.

#### Main changes
- Replaced technical session meta labels with a more human narrative flow in the timeline.
- Improved worker quick actions and composer responsiveness so common chat actions feel faster.
- Added in-message search match highlighting to make scanning session content easier.

#### Lines of code changed since previous release
485 lines changed since `v0.11.120` (311 insertions, 174 deletions).

#### Release importance
Minor release: improves the feel and readability of the core session experience without changing the broader workflow model.

#### Major improvements
True

#### Number of major improvements
1

#### Major improvement details
- Added in-message search match highlighting while improving worker quick actions and composer responsiveness.

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

## v0.11.122

#### Commit
`dfa41808`

#### Released at
`2026-02-26T01:34:07Z`

#### One-line summary
Expands hosted onboarding and sharing in a big way while making long sessions, desktop shutdown, and several app surfaces more reliable.

#### Main changes
- Streamlined cloud onboarding with Open in App handoff, GitHub sign-in, a dedicated download page, and stronger hosted auth and callback handling.
- Added richer sharing flows with workspace profile and skills-set sharing plus deep-linked bundle imports into new workers.
- Improved day-to-day app usability with grouped exploration steps, faster markdown rendering in long sessions, clearer workspace and share surfaces, and better file-link handling.

#### Lines of code changed since previous release
5651 lines changed since `v0.11.121` (4835 insertions, 816 deletions).

#### Release importance
Major release: substantially expands how users sign up, connect, share, and navigate OpenWork across hosted and desktop flows.

#### Major improvements
True

#### Number of major improvements
5

#### Major improvement details
- Added Open in App handoff for hosted remote-connect flows.
- Simplified get-started signup and added GitHub sign-in.
- Added a dedicated download page with platform anchors and a stronger docs entrypoint.
- Added workspace profile and skills-set sharing flows.
- Added bundle-share deep links that open directly into new-worker imports.

#### Major bugs resolved
True

#### Number of major bugs resolved
5

#### Major bug fix details
- Grouped exploration steps and cached markdown rendering to keep long sessions responsive.
- Fixed workspace-relative markdown file references so local file links open correctly.
- Stabilized workspace actions, improved share modal mobile readability, wrapped long connection URLs, and clamped long skill triggers.
- Hardened hosted auth with cookie preservation, trusted-origin defaults, callback fixes, and Polar access backfill.
- Retried transient Den signup database reads and stopped the desktop orchestrator daemon cleanly on app close.

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

## v0.11.123

#### Commit
`dfd331da`

#### Released at
`2026-02-26T05:45:34Z`

#### One-line summary
Refreshes sharing to match OpenWork’s visual identity and adds a built-in local server restart action for easier recovery.

#### Main changes
- Redesigned the Share Workspace modal so creating share links feels more polished and consistent with the OpenWork app.
- Restyled generated bundle pages to carry the same OpenWork visual identity when links are opened outside the app.
- Added a local server restart action in Settings so users can recover local runtime issues without leaving OpenWork.

#### Lines of code changed since previous release
1480 lines changed since `v0.11.122` (1027 insertions, 453 deletions).

#### Release importance
Minor release: introduces two focused user-facing improvements that make sharing and local recovery noticeably better.

#### Major improvements
True

#### Number of major improvements
2

#### Major improvement details
- Added a local server restart action in Settings.
- Redesigned the share modal and generated bundle page styling to match OpenWork’s product identity.

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

## v0.11.124

#### Commit
`3237bfab`

#### Released at
`2026-02-26T19:33:56Z`

#### One-line summary
Applies the Orbita session layout direction to make the core OpenWork session view feel more structured, readable, and cohesive.

#### Main changes
- Reworked the session layout around the Orbita direction so inbox, composer, artifacts, and navigation feel more intentionally organized.
- Tightened sidebar and session panel presentation to improve readability and flow across the main app workspace.
- Restored theme-safe contrast while landing the new layout so the updated session view remains readable across themes.

#### Lines of code changed since previous release
734 lines changed since `v0.11.123` (451 insertions, 283 deletions).

#### Release importance
Minor release: refreshes the core session experience with a substantial layout polish pass while keeping the same underlying workflow.

#### Major improvements
True

#### Number of major improvements
1

#### Major improvement details
- Applied the Orbita session layout direction across the main session interface.

#### Major bugs resolved
True

#### Number of major bugs resolved
1

#### Major bug fix details
- Fixed theme and contrast regressions during the layout refresh so session surfaces remain readable.

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

