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


## v0.11.176

#### Commit

`47b6f7e3`

#### Released at

Unreleased draft release. Tagged at `2026-03-20T12:51:31-07:00`.

#### One-line summary

Improves provider setup and remote messaging reliability so first-run connection flows feel less brittle.

#### Main changes

- Improved OpenAI provider onboarding so new-session setup points users into the right ChatGPT connection flow and better distinguishes local versus remote workers.
- Stabilized remote messaging router health checks so remote workers stop appearing unconfigured when messaging is actually available.
- Kept this release focused on setup and connection reliability rather than introducing broader new workflows.

#### Lines of code changed since previous release

1079 lines changed since `v0.11.175` (618 insertions, 461 deletions).

#### Release importance

Minor release: fixes provider onboarding and remote messaging reliability without materially changing the product's overall shape.

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

- Fixed provider onboarding so the new-session CTA sends users through the correct OpenAI connection flow, including remote-worker cases.
- Fixed remote messaging router health reporting so configured remote workers no longer look broken in settings and identities flows.

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

## v0.11.177

#### Commit

`9603be37`

#### Released at

`2026-03-20T20:54:48Z`

#### One-line summary

Gets new users to the right install path faster and makes orchestrator installs recover more reliably when local binaries are missing.

#### Main changes

- Routed the main landing-page CTA straight to downloads so new users land on the desktop install surface instead of an extra intermediate step.
- Added an npm install fallback to published OpenWork Orchestrator binaries so local installs can still complete when building from source is unavailable.
- Kept release outputs aligned with the shipped orchestrator build so install behavior stays more predictable across environments.

#### Lines of code changed since previous release

175 lines changed since `v0.11.176` (139 insertions, 36 deletions).

#### Release importance

Minor release: improves install-path clarity and local install resilience with a focused release-engineering patch.

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

- Fixed the landing CTA so new users reach the downloads page directly instead of taking a less useful route.
- Fixed orchestrator npm installs so they can fall back to published binaries when the local install path fails.

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

## v0.11.178

#### Commit

`1cc5360f`

#### Released at

`2026-03-22T03:08:43Z`

#### One-line summary

Redesigns core app navigation and sharing first, then makes model controls clearer and smooths several session and feedback flows.

#### Main changes

- Redesigned workspace sharing and the right sidebar, including nested child sessions and cleaner session chrome so navigation feels more structured.
- Made model behavior controls model-aware with clearer provider and picker behavior across the composer and settings.
- Routed in-app feedback to a hosted form and restored key session affordances like the in-composer Run action while polishing settings and transcript surfaces.

#### Lines of code changed since previous release

8432 lines changed since `v0.11.177` (5335 insertions, 3097 deletions).

#### Release importance

Major release: substantially reshapes navigation, sharing, and model-control flows across the app.

#### Major improvements

True

#### Number of major improvements

3

#### Major improvement details

- Redesigned workspace sharing and introduced a unified right sidebar with nested child sessions.
- Added model-aware behavior controls so provider-specific options are clearer in the composer and settings.
- Moved app feedback into a hosted feedback form that is reachable directly from app surfaces.

#### Major bugs resolved

True

#### Number of major bugs resolved

2

#### Major bug fix details

- Restored the in-composer Run action and stabilized the composer footer after recent UI regressions.
- Fixed session and settings follow-up regressions that made remote connect, picker behavior, and transcript affordances feel inconsistent.

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

## v0.11.179

#### Commit

`5f043456`

#### Released at

`2026-03-22T05:34:34Z`

#### One-line summary

Simplifies Den checkout and workspace setup flows while cleaning up a few visible desktop and sharing rough edges.

#### Main changes

- Simplified Den cloud checkout and dashboard surfaces so trial signup and cloud navigation feel lighter and more direct.
- Refreshed remote workspace creation and folder-selection flows to reduce friction when creating a new workspace.
- Improved share previews with favicon and social metadata and removed desktop tray behavior that made close and reopen behavior less predictable.

#### Lines of code changed since previous release

1025 lines changed since `v0.11.178` (539 insertions, 486 deletions).

#### Release importance

Minor release: focuses on checkout, workspace setup, and a few visible desktop/share fixes without changing the overall product model.

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

- Removed tray support so desktop close behavior no longer depends on a redundant background tray icon.
- Removed duplicate thinking labels in sessions so streamed reasoning state is easier to read.

#### Deprecated features

True

#### Number of deprecated features

1

#### Deprecated details

- Removed desktop tray support from the app.

#### Published in changelog page

False

#### Published in docs

False

## v0.11.180

#### Commit

`093ee573`

#### Released at

Unreleased draft release. Tagged at `2026-03-22T09:29:16-07:00`.

#### One-line summary

Strips down Den landing and provisioning visuals so the cloud onboarding experience feels lighter and less distracting.

#### Main changes

- Simplified the landing hero so the first impression focuses more on the core message and less on decorative UI.
- Removed the hero activity mockup from Den marketing surfaces to reduce visual noise.
- Simplified the provisioning connection animation and dropped the background cube artwork from the dashboard flow.

#### Lines of code changed since previous release

3020 lines changed since `v0.11.179` (23 insertions, 2997 deletions).

#### Release importance

Minor release: pares back visual complexity in Den onboarding surfaces without materially changing product behavior.

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

## v0.11.181

#### Commit

`abcfdfc7`

#### Released at

`2026-03-22T17:02:23Z`

#### One-line summary

Republishes the release line with synchronized package metadata and no clear additional user-facing product changes.

#### Main changes

- No material app, server, or workflow changes are visible in this release beyond the new tagged build.
- Desktop, server, orchestrator, and router package metadata were kept in sync for the `0.11.181` cut.
- This patch appears to focus on shipping refreshed artifacts rather than changing how OpenWork behaves.

#### Lines of code changed since previous release

58 lines changed since `v0.11.180` (40 insertions, 18 deletions).

#### Release importance

Minor release: primarily refreshes release artifacts and synchronized version metadata.

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

## v0.11.182

#### Commit

`7a0e31d0`

#### Released at

`2026-03-23T01:48:48Z`

#### One-line summary

Moves local workspace ownership into OpenWork server so reconnect and onboarding flows stay more reliable, while making remote connect UX simpler.

#### Main changes

- Moved local workspace ownership into OpenWork server so reconnects, starter-workspace setup, and sidebar state stay aligned across app surfaces.
- Simplified the remote workspace connect modal so adding a worker feels clearer and lighter.
- Polished session tool traces by moving the chevron affordance to the right for faster scanning.

#### Lines of code changed since previous release

1792 lines changed since `v0.11.181` (1510 insertions, 282 deletions).

#### Release importance

Major release: lands a substantial server-ownership and runtime-architecture change that materially affects core local workspace behavior.

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

- Fixed local workspace reconnect and onboarding inconsistencies by moving workspace ownership into OpenWork server.
- Fixed remote connect friction by simplifying the modal users see when attaching to a remote workspace.

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

## v0.11.183

#### Commit

`160198ab`

#### Released at

`2026-03-23T05:01:53Z`

#### One-line summary

Adds Exa to Advanced settings while backing out an unready macOS path-handling change to keep the release stable.

#### Main changes

- Added Exa to Advanced settings so power users can configure it alongside other advanced tooling in the app.
- Reverted the prior macOS path case-folding change after it proved not ready for release.
- Kept the patch narrowly focused on advanced-settings follow-up and platform stability.

#### Lines of code changed since previous release

614 lines changed since `v0.11.182` (53 insertions, 561 deletions).

#### Release importance

Minor release: adds a focused advanced-settings capability while avoiding a risky macOS path change.

#### Major improvements

True

#### Number of major improvements

1

#### Major improvement details

- Added Exa as a configurable option in Advanced settings.

#### Major bugs resolved

True

#### Number of major bugs resolved

1

#### Major bug fix details

- Reverted an unready macOS path normalization change so users do not pick up unstable workspace-path behavior.

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

## v0.11.184

#### Commit

`09204a02`

#### Released at

`2026-03-23T15:04:42Z`

#### One-line summary

Refocuses the docs around a slimmer Quickstart so the main onboarding path is easier to follow.

#### Main changes

- Simplified the docs experience around a refreshed Quickstart so new users have a clearer primary onboarding path.
- Removed older docs pages and tutorials in favor of a leaner documentation surface.
- Updated docs structure and metadata to match the reduced set of guides.

#### Lines of code changed since previous release

898 lines changed since `v0.11.183` (121 insertions, 777 deletions).

#### Release importance

Minor release: narrows the documentation surface around Quickstart without changing shipped product behavior.

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

## v0.11.185

#### Commit

`5584dfd6`

#### Released at

`2026-03-24T05:34:00Z`

#### One-line summary

Hardens sharing and messaging defaults first, then adds guided Control Chrome setup and Brazilian Portuguese localization.

#### Main changes

- Defaulted local workers to localhost-only and hardened public auth and publishing flows so sharing surfaces are safer unless users explicitly opt in.
- Put messaging behind explicit opt-in and added a warning before creating public Telegram bots so public exposure is more deliberate.
- Added a guided Control Chrome setup flow and Brazilian Portuguese localization to make setup clearer for more users.

#### Lines of code changed since previous release

5434 lines changed since `v0.11.184` (4780 insertions, 654 deletions).

#### Release importance

Major release: materially changes sharing and messaging defaults while adding meaningful setup and localization improvements.

#### Major improvements

True

#### Number of major improvements

2

#### Major improvement details

- Added a guided Control Chrome setup flow inside the app.
- Added Brazilian Portuguese (`pt-BR`) localization.

#### Major bugs resolved

True

#### Number of major bugs resolved

2

#### Major bug fix details

- Local workers now stay localhost-only by default unless users intentionally expose them for sharing.
- Hardened Den and public publishing/auth surfaces so shared flows are less likely to leak into unsafe configurations.

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

## v0.11.186

#### Commit

`30737e99`

#### Released at

`2026-03-24T06:16:26Z`

#### One-line summary

Fixes local workspace scoping during reconnects and bootstrap so sessions stay attached to the right directory.

#### Main changes

- Kept workspace history scoped to the active local workspace during reconnects so switching and reopening do not pull in the wrong session list.
- Normalized starter workspace paths during desktop bootstrap so persisted local paths reconnect to the correct directory.
- Kept this release tightly focused on local startup and reconnect reliability instead of new features.

#### Lines of code changed since previous release

397 lines changed since `v0.11.185` (343 insertions, 54 deletions).

#### Release importance

Minor release: fixes local reconnect and bootstrap scoping issues without introducing broader workflow changes.

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

- Fixed local reconnect behavior so workspace history stays scoped to the active workspace instead of a stale directory.
- Fixed starter-path handling so older persisted local paths reconnect correctly during desktop bootstrap.

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

## v0.11.187

#### Commit

`5d1c6a28`

#### Released at

`2026-03-24T15:09:03Z`

#### One-line summary

Fixes Windows path handling so session and workspace scope comparisons stay consistent across standard, verbatim, and UNC-prefixed directories.

#### Main changes

- Normalized Windows directory transport so local session create, delete, and sidebar scope checks all compare the same path shape.
- Stripped verbatim Windows path prefixes before scope comparison so reconnect and switch flows stop drifting across equivalent paths.
- Normalized verbatim UNC scope comparisons so Windows remote and local session transitions stay attached to the right workspace.

#### Lines of code changed since previous release

210 lines changed since `v0.11.186` (173 insertions, 37 deletions).

#### Release importance

Minor release: fixes a focused but important Windows path-scoping problem without changing the broader product experience.

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

- Fixed Windows directory transport mismatches that caused session and sidebar scope checks to disagree.
- Fixed verbatim path-prefix handling so equivalent Windows paths no longer compare as different workspaces.
- Fixed UNC path comparisons so Windows reconnect and worker-switch flows stay scoped correctly.

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

## v0.11.188

#### Commit

`c9e00db6`

#### Released at

`2026-03-24T16:29:47Z`

#### One-line summary

Restores the prior feedback flow by removing the Loops feedback template from the landing feedback route.

#### Main changes

- Reverted the Loops feedback template change so app feedback submissions return to the earlier behavior.
- Removed the template files and config tied to the reverted feedback email path.
- Kept this patch narrowly focused on making feedback submission behavior predictable again.

#### Lines of code changed since previous release

328 lines changed since `v0.11.187` (30 insertions, 298 deletions).

#### Release importance

Minor release: reverts a focused feedback-flow change to restore the previously working behavior.

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

- Reverted the Loops feedback template rollout so the landing feedback route goes back to the prior, more reliable submission path.

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

## v0.11.189

#### Commit

`a7fa0312`

#### Released at

`2026-03-24T17:16:24Z`

#### One-line summary

Rolls the release line forward with no visible product or workflow changes.

#### Main changes

- Kept the shipped OpenWork app, server, and cloud behavior effectively unchanged for end users.
- Refreshed release metadata so the package set stays aligned for the next follow-up patch.
- Landed as a no-op user-facing release without new workflows, fixes, or removals.

#### Lines of code changed since previous release

26 lines changed since `v0.11.188` (13 insertions, 13 deletions).

#### Release importance

Minor release: advances the release line without introducing meaningful user-facing behavior changes.

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

## v0.11.190

#### Commit

`6c22f800`

#### Released at

`2026-03-24T23:32:21Z`

#### One-line summary

Stabilizes sharing first, then smooths provider auth timing and refreshes the app shell layout.

#### Main changes

- Fixed sharing so public routes keep resolving correctly and packaged desktop builds can publish to the OpenWork share surface.
- Deferred headless OpenAI auth polling so provider connection flows are less likely to churn while waiting for authorization.
- Removed the right-sidebar-heavy shell in favor of a flatter app layout that keeps the main workspace flow more focused.

#### Lines of code changed since previous release

3837 lines changed since `v0.11.189` (2654 insertions, 1183 deletions).

#### Release importance

Minor release: improves sharing reliability, provider onboarding stability, and shell polish without materially changing the product's overall shape.

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

- Fixed share publishing so packaged desktop builds can publish from the correct desktop origin.
- Fixed share public routing so hardened public routes keep resolving instead of breaking after config changes.

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

## v0.11.191

#### Commit

`6c9700ce`

#### Released at

`2026-03-25T01:04:43Z`

#### One-line summary

Makes detached worker sharing survive restarts and tightens settings behavior around disconnected providers.

#### Main changes

- Preserved detached worker share credentials across restarts so reopened workers stay connected more reliably.
- Disabled disconnected config-backed providers correctly so settings state no longer appears active after a disconnect.
- Kept authorized-folder removal controls visible in settings so cleanup actions remain available when needed.

#### Lines of code changed since previous release

495 lines changed since `v0.11.190` (413 insertions, 82 deletions).

#### Release importance

Minor release: focuses on reliability fixes for shared workers and provider settings without adding broad new workflows.

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

- Fixed detached worker sharing so saved credentials survive app restarts instead of forcing users to reconnect.
- Fixed disconnected provider handling so config-backed providers stay disabled after users disconnect them.

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

## v0.11.192

#### Commit

`5f30ad2a`

#### Released at

`2026-03-25T22:30:34Z`

#### One-line summary

Decouples workspace switching from runtime activation, adds richer template imports, and fixes seeded starter sessions.

#### Main changes

- Made workspace switching feel safer and steadier by keeping selection separate from runtime activation and preserving sticky local worker ports.
- Expanded workspace templates so shared imports can carry extra `.opencode` files and starter sessions end to end.
- Fixed blueprint-seeded session materialization so starter conversations render correctly instead of dropping their initial state.

#### Lines of code changed since previous release

4896 lines changed since `v0.11.191` (3899 insertions, 997 deletions).

#### Release importance

Major release: materially changes how workspace switching and template-based workspace setup work across the app and server.

#### Major improvements

True

#### Number of major improvements

2

#### Major improvement details

- Added richer workspace template sharing so imports can include extra `.opencode` files.
- Added starter sessions to workspace templates so new workspaces can open with seeded conversations.

#### Major bugs resolved

True

#### Number of major bugs resolved

2

#### Major bug fix details

- Fixed workspace switching semantics so selecting a workspace no longer needlessly reconnects runtimes.
- Fixed blueprint-seeded session materialization so starter sessions load with their intended content.

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

## v0.11.193

#### Commit

`da74ba9a`

#### Released at

`2026-03-26T05:23:19Z`

#### One-line summary

Introduces Cloud team template sharing and Den organization workflows while adding safer Cloud sign-in fallbacks.

#### Main changes

- Added Cloud team template sharing flows so teams can publish and reuse workspace templates directly from the app.
- Introduced Den organizations, member permissions, and org-scoped template sharing surfaces for multi-user Cloud administration.
- Added clearer Cloud sign-in prompts and a manual fallback so team-sharing flows can recover when the automatic sign-in path stalls.

#### Lines of code changed since previous release

7841 lines changed since `v0.11.192` (6406 insertions, 1435 deletions).

#### Release importance

Major release: adds substantial new Cloud collaboration and organization-management workflows that materially change how teams use OpenWork.

#### Major improvements

True

#### Number of major improvements

2

#### Major improvement details

- Added Cloud team template sharing flows in the OpenWork app.
- Added Den organization management, permissions, and org-scoped template sharing surfaces.

#### Major bugs resolved

True

#### Number of major bugs resolved

1

#### Major bug fix details

- Added a manual Cloud sign-in fallback and clearer sign-in CTA so team-sharing flows are less likely to block on auth issues.

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

## v0.11.194

#### Commit

`41d93e2e`

#### Released at

`2026-03-26T20:46:09Z`

#### One-line summary

Turns auto compaction into a working app flow, simplifies Den local development, and keeps more settings and automation flows live in place.

#### Main changes

- Wired automatic context compaction through to OpenCode so the app's compaction control now affects real long-session behavior.
- Simplified Den local development and sandbox dashboard flows with clearer manual sandbox creation and less intrusive startup behavior.
- Kept setup and operations flows steadier by leaving custom app MCP adds in settings, polling scheduled jobs live, and routing update notices to the right settings destination.

#### Lines of code changed since previous release

5198 lines changed since `v0.11.193` (3852 insertions, 1346 deletions).

#### Release importance

Minor release: improves several active workflows and developer surfaces, but it does not substantially reshape the product's core user model.

#### Major improvements

True

#### Number of major improvements

1

#### Major improvement details

- Enabled real automatic context compaction behavior through the app's OpenCode integration.

#### Major bugs resolved

True

#### Number of major bugs resolved

3

#### Major bug fix details

- Fixed the auto compaction toggle so it actually wires through to OpenCode behavior.
- Fixed the custom app MCP add flow so users can stay in settings instead of getting bounced out of setup.
- Fixed automations polling so scheduled jobs keep refreshing while the page is open.

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

## v0.11.195

#### Commit

`9d5b14b4`

#### Released at

`2026-03-27T22:02:59Z`

#### One-line summary

Sharpens Den worker connection flows while making desktop model, update, and local workspace behavior more reliable.

#### Main changes

- Restored Den worker connect actions with smoother inline controls and less polling jank across the background agents view.
- Preserved desktop default model changes and made update badges easier to notice so session setup and maintenance feel more dependable.
- Fixed local workspace creation and remote workspace binding so switching into active workspaces completes more reliably.

#### Lines of code changed since previous release

5137 lines changed since `v0.11.194` (3875 insertions, 1262 deletions).

#### Release importance

Minor release: improves existing Den and desktop workflows with focused reliability and UX fixes rather than introducing a new product surface.

#### Major improvements

True

#### Number of major improvements

1

#### Major improvement details

- Restored full worker connect actions in Den with inline connection controls for ready workers.

#### Major bugs resolved

True

#### Number of major bugs resolved

3

#### Major bug fix details

- Fixed default model changes so workspace refreshes no longer wipe out newly chosen defaults.
- Fixed local workspace creation so the app creates them through the local host path reliably.
- Fixed remote workspace binding so connect flows finish attaching the workspace correctly.

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

## v0.11.196

#### Commit

`663e357b`

#### Released at

`2026-03-30T21:27:27Z`

#### One-line summary

Reorients the app around session-first navigation, replaces the old dashboard model, and overhauls automations and workspace state ownership.

#### Main changes

- Made OpenWork boot back into the last session and land on the session view instead of routing users through a dashboard-first shell.
- Rebuilt automations around live scheduler jobs with a dedicated Automations page and more direct settings ownership.
- Smoothed workspace startup and switching by fixing welcome-workspace bootstrap, sidebar refresh behavior, and several shell-level loading interruptions.

#### Lines of code changed since previous release

34577 lines changed since `v0.11.195` (15875 insertions, 18702 deletions).

#### Release importance

Major release: substantially changes the app's navigation model and retires the old dashboard concept in favor of a session-first experience.

#### Major improvements

True

#### Number of major improvements

2

#### Major improvement details

- Added a dedicated Automations page centered on live scheduler jobs.
- Restored last-session boot so workspaces reopen directly into the active conversation flow.

#### Major bugs resolved

True

#### Number of major bugs resolved

2

#### Major bug fix details

- Fixed welcome workspace bootstrap so first-run workspace setup behaves more predictably.
- Fixed shell and session loading churn so startup and workspace switching feel less like full reloads.

#### Deprecated features

True

#### Number of deprecated features

1

#### Deprecated details

- Removed the old dashboard-first app concept in favor of session-first navigation and settings-owned tool surfaces.

#### Published in changelog page

False

#### Published in docs

False

## v0.11.197

#### Commit

`020d7636`

#### Released at

`2026-03-31T05:21:16Z`

#### One-line summary

Hardens sharing and secret handling while cleaning up sidebar session behavior and unwanted welcome-workspace creation.

#### Main changes

- Protected workspace sharing by gating sensitive exports and forcing bundle fetches to stay on the configured publisher unless users explicitly opt into a warning-backed manual import.
- Kept orchestrator secrets out of process arguments and logs so local and hosted runs leak less sensitive data.
- Fixed sidebar and boot behavior by stopping automatic Welcome workspace creation and correcting which sessions appear in collapsed workspace lists.

#### Lines of code changed since previous release

6399 lines changed since `v0.11.196` (5657 insertions, 742 deletions).

#### Release importance

Major release: ships important security hardening around secret handling and workspace sharing while also correcting core workspace-list behavior.

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

- Fixed sensitive workspace exports so secrets can be detected and blocked before sharing.
- Fixed bundle fetch routing so publish and fetch traffic stays pinned to the configured OpenWork publisher.
- Fixed orchestrator secret handling so credentials no longer ride in argv and logs.
- Fixed workspace boot/sidebar behavior by stopping unwanted Welcome workspace creation and restoring missing root sessions.

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

## v0.11.198

#### Commit

`761796fd`

#### Released at

`2026-03-31T06:00:47Z`

#### One-line summary

Fixes a local-workspace switching race so the engine restarts correctly when moving between local workspaces.

#### Main changes

- Restarted the engine correctly when switching between local workspaces instead of reusing stale runtime state.
- Carried the previous workspace path through activation so local workspace changes are detected reliably.
- Applied the same race fix to workspace-forget flows so local engine state stays consistent during cleanup.

#### Lines of code changed since previous release

100 lines changed since `v0.11.197` (59 insertions, 41 deletions).

#### Release importance

Minor release: fixes a focused local-workspace activation bug without changing the surrounding product flow.

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

- Fixed a local workspace switching race that could skip the required engine restart when moving between local workspaces.

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

## v0.11.199

#### Commit

`4a3e43e5`

#### Released at

`2026-04-02T02:18:50Z`

#### One-line summary

Adds pricing and paid Windows flows, expands Den team capabilities, and improves debugging and session recovery across the app.

#### Main changes

- Added a new landing pricing flow with paid Windows messaging and cleaner Cloud navigation into the app.
- Expanded Den with skill hubs, a Hono-based `den-api`, and a smoother org-invite signup path for team administration.
- Improved day-to-day reliability with developer log export, per-conversation draft persistence, and recovery after immediate send failures.

#### Lines of code changed since previous release

19623 lines changed since `v0.11.198` (12501 insertions, 7122 deletions).

#### Release importance

Major release: introduces major new commercial and Den team workflows while materially improving debugging and session resilience.

#### Major improvements

True

#### Number of major improvements

3

#### Major improvement details

- Added landing pricing and paid Windows conversion flows.
- Added Den skill hubs and migrated Den onto the new Hono-based `den-api`.
- Added exportable developer logs in the app's debug surface.

#### Major bugs resolved

True

#### Number of major bugs resolved

3

#### Major bug fix details

- Fixed session send failures so conversations can recover after an immediate error.
- Fixed draft persistence so conversation drafts stay scoped to the correct conversation.
- Fixed startup and sharing edge cases such as delayed host-info checks and unreliable shared access token reveal.

#### Deprecated features

True

#### Number of deprecated features

1

#### Deprecated details

- Removed the legacy `opkg` CLI integration as part of the release cleanup.

#### Published in changelog page

False

#### Published in docs

False

## v0.11.200

#### Commit

`5cc7bbdd`

#### Released at

`2026-04-03T15:22:13Z`

#### One-line summary

Brings Cloud team skills into the app and greatly expands Den team, skill hub, and billing management flows.

#### Main changes

- Added an OpenWork Cloud team skills catalog to the app's Skills page, including refresh, install, and share-to-team flows.
- Added Den teams and full skill hub management so organizations can structure, edit, and browse shared skill collections.
- Moved billing into org creation and enforced org limits so team setup reflects plan constraints earlier in the workflow.

#### Lines of code changed since previous release

9000 lines changed since `v0.11.199` (7881 insertions, 1119 deletions).

#### Release importance

Major release: adds substantial new Cloud and Den organization capabilities that materially expand how teams discover, share, and manage skills.

#### Major improvements

True

#### Number of major improvements

3

#### Major improvement details

- Added the OpenWork Cloud team skills catalog on the app Skills page.
- Added Den teams and full skill hub management across the org dashboard.
- Added billing-aware org creation with org limit enforcement.

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

## v0.11.201

#### Commit

`15725dfb`

#### Released at

`2026-04-04T01:59:47Z`

#### One-line summary

Cleans up workspace list behavior, reduces session flicker, and fixes Den skill editing and invite-state handling.

#### Main changes

- Fully collapses workspace session lists when closed so collapsed workspaces stop showing preview rows, loading shells, or empty states.
- Reduced session load churn and stream-batch flicker so transcripts feel steadier during first load and early streaming.
- Fixed Den organization editing flows by parsing skill frontmatter on save and restoring pending-invite counts and org draft state.

#### Lines of code changed since previous release

3956 lines changed since `v0.11.200` (2440 insertions, 1516 deletions).

#### Release importance

Minor release: focuses on interface polish and workflow fixes across the app and Den without adding a substantially new product capability.

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

- Fixed collapsed workspace lists so hidden workspaces no longer leak session previews or loading states.
- Fixed session loading and streaming churn that could cause repeated fetches or visible flicker.
- Fixed Den skill saving and org management by parsing skill frontmatter correctly and restoring pending invite and draft state.

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
