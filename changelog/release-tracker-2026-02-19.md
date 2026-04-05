# Release Changelog Tracker

Internal preparation file for release summaries. This is not yet published to the changelog page or docs.

## v0.11.100

#### Commit
`a4601059`

#### Released at
`2026-02-19T17:49:05Z`

#### Title
Composer drafts stop disappearing mid-prompt

#### One-line summary
Fixes a session composer race so long prompts stay intact instead of getting replaced by stale draft echoes.

#### Main changes
- Fixed stale draft echoes overriding what you were actively typing in the session composer.
- Tightened draft state tracking so long prompts stay stable during extended writing.

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

## v0.11.101

#### Commit
`87fda845`

#### Released at
`2026-02-19T21:26:55Z`

#### Title
Local migration repair and clearer Soul controls

#### One-line summary
Adds a desktop recovery path for broken local OpenCode migrations and makes Soul setup plus compact action buttons easier to steer.

#### Main changes
Added migration repair from onboarding and Settings so broken local startup can recover without leaving OpenWork.

Also released:

- Clearer Soul starter steering and observability.
- Cleaner compact action buttons across settings and sidebars.

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

## v0.11.102

#### Commit
`f728cc3b`

#### Released at
`2026-02-20T00:00:11Z`

#### Title
Migration recovery explains when it can help

#### One-line summary
Clarifies when repair is actually available in the app and resets the landing page back to broader OpenWork messaging.

#### Main changes
- Added disabled-state feedback and clearer reasons when migration recovery is unavailable in onboarding and Settings.
- Reverted the homepage copy from a workers-heavy framing back to the broader OpenWork message.

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

## v0.11.103

#### Commit
`a1b7a5e1`

#### Released at
`2026-02-20T00:41:17Z`

#### Title
Soul setup now runs safely, and sidebar sessions stay scoped

#### One-line summary
Prevents Soul quickstart content from being injected as raw prompt text and keeps sidebar session state tied to the active workspace root.

#### Main changes
- Switched Soul enable flows to run through the slash-command path instead of sending template text directly.
- Scoped sidebar session sync by workspace root so session state does not bleed across workspaces.

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

## v0.11.104

#### Commit
`091f13d2`

#### Released at
`2026-02-20T04:45:27Z`

#### Title
Session follow mode is now in your hands

#### One-line summary
Adds explicit follow-latest and jump-to-latest controls so streaming output stops interrupting people who scroll back to read.

#### Main changes
- Added a follow-latest toggle and a jump-to-latest button in the session timeline.
- Turned off auto-follow as soon as you scroll away from the live tail.

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

## v0.11.105

#### Commit
`45f5f07d`

#### Released at
`2026-02-20T05:12:11Z`

#### Title
Session timelines stop auto-following altogether

#### One-line summary
Removes the remaining automatic follow behavior so live output no longer drags the view while you read older messages.

#### Main changes
- Removed automatic session follow scrolling during new output and sends.
- Left only a manual jump-to-latest affordance when you are away from the bottom.

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

## v0.11.106

#### Commit
`4e9260b9`

#### Released at
`2026-02-20T05:19:07Z`

#### Title
Packaging-only release lockfile maintenance

#### One-line summary
Refreshes package lock metadata for the release line, with no clear app, desktop, web, or workflow change.

#### Main changes
Updated release package metadata only, with no notable user-facing or developer-facing workflow change.

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

## v0.11.107

#### Commit
`76a307fc`

#### Released at
`2026-02-20T05:40:27Z`

#### Title
Reopening sessions no longer snaps you back to the top

#### One-line summary
Fixes a revisit-specific session bug so returning to an existing conversation preserves a steadier reading position.

#### Main changes
- Stopped reopened sessions from reinitializing scroll position back to the top.
- Limited top-of-thread initialization to the first visit for each session.

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

## v0.11.108

#### Commit
`3ae49df6`

#### Released at
`2026-02-20T18:14:52Z`

#### Title
Readable share pages, sturdier Soul flows, safer drafts

#### One-line summary
Makes shared bundles inspectable in the browser, preserves unsent draft text across tab switches, and strengthens Soul activation and audit flows.

#### Main changes
- Added human-readable bundle pages with raw JSON and download fallback for share links.
- Preserved composer drafts across tab switches.
- Hardened Soul setup and added clearer activation audit and steering flows.

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

## v0.11.109

#### Commit
`a896defd`

#### Released at
`2026-02-20T20:51:01Z`

#### Title
Safer automation setup, grouped skills, and global MCP config

#### One-line summary
Keeps automations hidden until the scheduler is installed and lets OpenWork pick up domain-organized skills plus machine-level MCP servers.

#### Main changes
- Hid Automations until the scheduler is installed.
- Added support for skills stored in domain folders.
- Included global MCP servers alongside workspace config.

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

## v0.11.110

#### Commit
`8f869772`

#### Released at
`2026-02-20T22:35:16Z`

#### Title
Release packaging and deploy hardening only

#### One-line summary
Hardens updater metadata generation and share-service deploy behavior, with no visible OpenWork app or workflow changes.

#### Main changes
Mostly packaging only: the release now publishes deterministic updater metadata and skips unnecessary desktop builds during share-service deploys.

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

## v0.11.111

#### Commit
`12847be3`

#### Released at
`2026-02-20T23:04:52Z`

#### Title
Version metadata sync only

#### One-line summary
Republishes synchronized package and desktop version metadata, with no intended OpenWork app, server, or workflow changes.

#### Main changes
Packaging only: this release just keeps version numbers and shipped metadata aligned across app, desktop, server, router, and orchestrator packages.

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

## v0.11.112

#### Commit
`a0ceeae0`

#### Released at
`2026-02-21T01:19:34Z`

#### Title
Cleaner session tool timelines

#### One-line summary
Hides step lifecycle noise and separates reasoning from tool runs so active sessions are easier to scan.

#### Main changes
- Removed step start and finish rows from the session timeline.
- Split grouped step blocks at reasoning boundaries so tool runs read in a more natural sequence.

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

## v0.11.113

#### Commit
`83af293a`

#### Released at
`2026-02-21T01:58:50Z`

#### Title
Cmd+K quick actions for session work

#### One-line summary
Adds a keyboard-first palette for jumping between sessions and changing model or thinking settings without leaving chat.

#### Main changes
- Open quick actions with Cmd+K from the session view.
- Search and jump across sessions from the same palette.
- Change the active model or thinking level in place during a live session.

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

## v0.11.114

#### Commit
`28596bf7`

#### Released at
`2026-02-22T06:00:46Z`

#### Title
OpenWork Cloud worker setup and reconnect flows

#### One-line summary
Adds a guided web flow for launching cloud workers, then makes reconnects work with saved workers, usable tokens, and workspace-scoped connect links.

#### Main changes
Adds the first full OpenWork Cloud worker setup flow in the web app.

Also released:

- A 3-step sign-in, checkout, and launch flow.
- Saved workers plus reusable tokens and workspace-scoped connect URLs.
- Background provisioning with polling and completed provider OAuth in the app.

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

## v0.11.115

#### Commit
`74048ebb`

#### Released at
`2026-02-22T07:45:08Z`

#### Title
Private Telegram bot pairing and sturdier hosted sign-in

#### One-line summary
Requires explicit pairing before a private Telegram chat can control a worker and lets hosted auth recover from broken upstream HTML responses.

#### Main changes
Private Telegram bots now stay closed until a chat is explicitly paired, and hosted sign-in fails over more cleanly when the auth proxy gets bad 5xx HTML.
    /pair ABCD-1234

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

## v0.11.116

#### Commit
`a7b88238`

#### Released at
`2026-02-22T18:26:36Z`

#### Title
Cleaner cloud-worker connect with desktop deep links

#### One-line summary
Turns the hosted worker page into a simpler list-detail picker and adds one-click desktop handoff into OpenWork's remote connect flow.

#### Main changes
- Reworked hosted workers into a clearer list-detail connect view with status and action panels.
- Added `openwork://connect-remote` deep links so the desktop app can open remote-connect details directly.
- Kept manual URL and token copy available when one-click open is unavailable.

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

## v0.11.117

#### Commit
`adeafe5a`

#### Released at
`2026-02-23T01:09:20Z`

#### Title
Hosted worker connect and cleanup flows get clearer

#### One-line summary
Reworks the web worker shell with clearer status, delete, and custom-domain handling, then makes session runs easier to scan by separating request, work, and result.

#### Main changes
- Hosted workers now use a full-page list-detail flow with progressive disclosure instead of exposing every manual control up front.
- You can delete a worker from the web flow, and custom domains resolve more cleanly when available.
- Session timelines split each turn into request, execution, and result blocks for tool-heavy chats.

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

## v0.11.118

#### Commit
`108d4efe`

#### Released at
`2026-02-23T02:49:35Z`

#### Title
Large sessions type faster, and cloud worker setup stays simpler

#### One-line summary
Cuts composer lag in big chats, renames timeline labels in plainer language, and keeps manual worker controls tucked behind advanced options.

#### Main changes
- Typing stays responsive deeper into large conversations by cutting composer layout churn.
- Session timelines swap technical segment names for clearer user-facing wording.
- Cloud worker pages hide manual URLs and tokens by default and recover safely when delete or custom-domain responses are incomplete.

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

## v0.11.119

#### Commit
`67844b38`

#### Released at
`2026-02-23T05:13:07Z`

#### Title
Long chats stay snappier, and web onboarding looks cleaner

#### One-line summary
Further trims typing lag while tightening the landing hero, Get started path, and hosted worker layout across the web experience.

#### Main changes
Further reduces composer reflow in heavy sessions, points Den visitors to a clearer Get started path, and makes both the landing hero and hosted worker panels use space more cleanly.

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

## v0.11.120

#### Commit
`6cf077b3`

#### Released at
`2026-02-23T06:19:35Z`

#### Title
Worker switching keeps session lists stable

#### One-line summary
Preserves sidebar sessions while moving between workers and refreshes the landing hero with higher contrast, calmer motion, and lighter nav chrome.

#### Main changes
- Switching workers no longer makes sidebar sessions disappear while connection state catches up.
- The landing hero gets a stronger shader, higher text contrast, slower animation, and simpler sticky navigation.

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

## v0.11.121

#### Commit
`b5f7814f`

#### Released at
`2026-02-23T06:46:26Z`

#### Title
Session timelines read naturally, and search hits stand out

#### One-line summary
Removes meta-heavy timeline labels, highlights search hits inside messages, and makes quick actions and composing feel faster in active chats.

#### Main changes
- Session runs now read like a conversation instead of showing Plan, Activity, and Answer labels.
- Search highlights matching text inside messages, not just matching rows.
- Worker quick actions and composer updates feel more responsive during active chats.

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

## v0.11.122

#### Commit
`dfa41808`

#### Released at
`2026-02-26T01:34:07Z`

#### Title
Hosted onboarding and share links become app handoffs

#### One-line summary
Adds GitHub sign-in, Open in App worker handoff, and share links for workspace profiles and skill sets while smoothing long-session and desktop reliability.

#### Main changes
Hosted OpenWork now hands people straight from the web into the app for connect and import flows.

Also released:

- GitHub sign-in plus a dedicated download page for faster first-time setup.
- Share links for workspace profiles and skill sets, with deep links that default to a new worker.
- Long sessions render more smoothly, local file links resolve correctly, and desktop shutdown is cleaner.

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

## v0.11.123

#### Commit
`dfd331da`

#### Released at
`2026-02-26T05:45:34Z`

#### Title
Clearer share links and local server recovery in Settings

#### One-line summary
Refreshes both the in-app share modal and public bundle pages, and adds a one-click local server restart when a local worker gets stuck.

#### Main changes
- Share Workspace becomes a cleaner split between live access details and public link publishing.
- Public bundle pages now look and read like OpenWork, with clearer import flows outside the app.
- Settings adds `Restart local server` so local recovery no longer means leaving OpenWork.

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

## v0.11.124

#### Commit
`3237bfab`

#### Released at
`2026-02-26T19:33:56Z`

#### Title
Orbita gives sessions a clearer three-pane workspace

#### One-line summary
Reworks the main session screen with a stronger left rail, cleaner timeline canvas, and floating composer while preserving readability across themes.

#### Main changes
Applies the Orbita direction across the session view, with a reorganized left rail for workers and sessions, lighter inbox and artifact side panels, and a clearer floating composer and message canvas.

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
