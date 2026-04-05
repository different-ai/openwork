# Release Changelog Tracker

Internal preparation file for release summaries. This is not yet published to the changelog page or docs.

## v0.11.176

#### Commit
`47b6f7e3`

#### Released at
Unreleased draft release. Tagged at `2026-03-20T12:51:31-07:00`.

#### Title
OpenAI setup points new chats the right way

#### One-line summary
Makes first-run provider setup clearer by sending new chats into the ChatGPT flow and fixing remote messaging health reporting.

#### Main changes
- Swapped the starter CTA to Connect ChatGPT and hid it once OpenAI is already connected.
- Made OpenAI auth worker-aware so remote workers use the device flow with copyable codes and manual browser launch.
- Fixed worker-scoped router health so remote messaging no longer appears unconfigured in Settings and identities.

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

## v0.11.177

#### Commit
`9603be37`

#### Released at
`2026-03-20T20:54:48Z`

#### Title
Downloads CTA and npm install fallback land

#### One-line summary
Gets desktop users to the right download path faster and lets `openwork-orchestrator` recover when npm skips its platform binary.

#### Main changes
Routes the desktop landing CTA to the Download page so the install path is clearer.

Also released:

- `openwork-orchestrator` postinstall now downloads the matching release binary when optional platform packages are missing.
- Daytona snapshot builds now use the source orchestrator binary.

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

## v0.11.178

#### Commit
`1cc5360f`

#### Released at
`2026-03-22T03:08:43Z`

#### Title
Workspace sharing and model controls get a major refresh

#### One-line summary
Redesigns workspace sharing and sidebar structure, makes reasoning controls model-aware, and adds a hosted feedback flow.

#### Main changes
- Redesigned workspace sharing and the right sidebar, including cleaner remote credentials and nested child sessions.
- Made model pickers model-aware with provider icons and per-model reasoning or behavior controls.
- Moved app feedback to a hosted form, added an Exa toggle, and stopped forcing starter workspaces on desktop boot.

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

## v0.11.179

#### Commit
`5f043456`

#### Released at
`2026-03-22T05:34:34Z`

#### Title
Den checkout and workspace setup get leaner

#### One-line summary
Simplifies Den billing and dashboard surfaces, streamlines workspace creation flows, and removes the desktop tray path.

#### Main changes
- Simplified the create-workspace and connect-remote modals so setup fields read more clearly.
- Refreshed Den checkout and dashboard screens into a flatter, cleaner shell.
- Removed desktop tray support and now requires contact details on hosted feedback submissions.

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

## v0.11.180

#### Commit
`093ee573`

#### Released at
Unreleased draft release. Tagged at `2026-03-22T09:29:16-07:00`.

#### Title
Den landing and provisioning visuals get pared back

#### One-line summary
Mostly a docs-and-artifact cleanup release, with a small Den landing and provisioning UI simplification.

#### Main changes
Mostly removes internal PR docs and screenshots, while trimming the Den landing hero and simplifying the worker provisioning animation. No clear core app, server, or developer workflow changes land in this tag.

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

## v0.11.181

#### Commit
`abcfdfc7`

#### Released at
`2026-03-22T17:02:23Z`

#### Title
Version metadata is republished in sync

#### One-line summary
Republishes synchronized package versions only, with no distinct user-facing or developer-facing workflow change.

#### Main changes
Packaging-only release that syncs version metadata across app, desktop, server, router, and orchestrator packages. No material workflow, UI, API, or docs behavior changes are visible from the code.

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

## v0.11.182

#### Commit
`7a0e31d0`

#### Released at
`2026-03-23T01:48:48Z`

#### Title
Local workspaces move under OpenWork server control

#### One-line summary
Shifts local workspace ownership into OpenWork server so creation, reconnects, config writes, and starter bootstrap stay aligned across the app.

#### Main changes
- Local workspace create, rename, delete, config writes, and reload events now go through OpenWork server first.
- First-run starter bootstrap and reconnect logic are more reliable across onboarding and sidebar flows.
- Simplified the remote connect modal, moved tool-trace chevrons right, and added Windows ARM64 dev startup support.

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

## v0.11.183

#### Commit
`160198ab`

#### Released at
`2026-03-23T05:01:53Z`

#### Title
Exa moves into OpenCode settings

#### One-line summary
Surfaces the Exa search toggle in a clearer OpenCode settings section and rolls back an unready macOS path-normalization change.

#### Main changes
- Added an OpenCode settings panel that exposes the Exa web-search toggle in a clearer place.
- Reverted the macOS path case-folding change to avoid destabilizing session and workspace matching.
- Also removed leftover docs-plan and screenshot artifacts.

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

## v0.11.184

#### Commit
`09204a02`

#### Released at
`2026-03-23T15:04:42Z`

#### Title
CLI quickstart becomes the primary docs path

#### One-line summary
Rebuilds the docs around a single CLI-first quickstart and removes older split onboarding paths that were harder to follow.

#### Main changes
Collapses the docs nav to a single quickstart, rewrites onboarding around the remote CLI plus desktop connect flow, and removes older introduction, technical, non-technical, and tutorial pages so first-run guidance is much narrower and easier to scan.

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

## v0.11.185

#### Commit
`5584dfd6`

#### Released at
`2026-03-24T05:34:00Z`

#### Title
Safer local sharing and messaging setup

#### One-line summary
Defaults local workers to loopback-only, makes public messaging exposure more deliberate, and adds guided setup for Chrome control.

#### Main changes
Local workers now stay localhost-only unless users explicitly opt into remote exposure, messaging is disabled until enabled on purpose, public Telegram bot creation shows a risk warning, and Chrome DevTools MCP gets a guided setup flow.

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

## v0.11.186

#### Commit
`30737e99`

#### Released at
`2026-03-24T06:16:26Z`

#### Title
Local reconnects stay scoped to the right workspace

#### One-line summary
Fixes restart and reconnect flows so local sessions and starter workspaces stay attached to the intended directory.

#### Main changes
Keeps local session history scoped to the active workspace during reconnects and normalizes persisted starter paths on desktop bootstrap, so restarts stop reopening or creating sessions against the wrong local directory.

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

## v0.11.187

#### Commit
`5d1c6a28`

#### Released at
`2026-03-24T15:09:03Z`

#### Title
Windows workspace scoping handles verbatim paths

#### One-line summary
Normalizes Windows path transport, verbatim prefixes, and UNC comparisons so local session scope stays consistent across directory formats.

#### Main changes
Normalizes Windows directory strings end to end, strips verbatim path prefixes, and fixes UNC comparison logic so session lists, deletes, and workspace switching all target the same local workspace scope.

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

## v0.11.188

#### Commit
`c9e00db6`

#### Released at
`2026-03-24T16:29:47Z`

#### Title
Landing feedback returns to the previous flow

#### One-line summary
Backs out the Loops feedback template so the landing feedback endpoint goes back to the simpler email-based path.

#### Main changes
Reverts the Loops-based landing feedback template and config, restoring the earlier app-feedback route behavior without introducing any broader app, worker, or docs workflow changes.

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

## v0.11.189

#### Commit
`a7fa0312`

#### Released at
`2026-03-24T17:16:24Z`

#### Title
Package metadata rolls forward only

#### One-line summary
Updates the release line with a lockfile and version sync only, without any visible product or workflow changes.

#### Main changes
Packaging-only release: version metadata and the pnpm lockfile are synchronized, with no meaningful user-facing or developer-facing workflow changes in the shipped code.

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

## v0.11.190

#### Commit
`6c22f800`

#### Released at
`2026-03-24T23:32:21Z`

#### Title
Connection guides expand while sharing and auth settle

#### One-line summary
Mostly docs-focused release that reorganizes onboarding around concrete connection guides, while fixing desktop publish routing and headless OpenAI auth timing.

#### Main changes
Mostly docs-only: the site shifts to task guides for remote setup, ChatGPT, custom providers, MCPs, sharing, and skill import, while the app fixes public share routing and waits to poll headless OpenAI auth until users actually open the browser.

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

## v0.11.191

#### Commit
`6c9700ce`

#### Released at
`2026-03-25T01:04:43Z`

#### Title
Shared detached workers survive restarts

#### One-line summary
Preserves share credentials for detached workers, hides disconnected config-backed providers, and adds clearer Slack and skill-import docs.

#### Main changes
Detached Docker-backed workers now keep the right share credentials after restart so share links and reconnect flows keep working, disconnected config-backed providers disappear cleanly from Settings, and docs add clearer Slack and skill-import walkthroughs.

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

## v0.11.192

#### Commit
`5f30ad2a`

#### Released at
`2026-03-25T22:30:34Z`

#### Title
Workspace switching stops hijacking runtime state

#### One-line summary
Separates workspace selection from runtime activation, keeps local worker ports stable, and makes shared templates carry starter content correctly.

#### Main changes
- Split selected workspace from runtime-connected workspace so browsing no longer flips the active worker.
- Kept preferred local server ports sticky and avoided collisions across workspaces.
- Let templates carry extra `.opencode` files and starter sessions, and materialized seeded sessions correctly.

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

## v0.11.193

#### Commit
`da74ba9a`

#### Released at
`2026-03-26T05:23:19Z`

#### Title
Team template sharing reaches OpenWork Cloud

#### One-line summary
Adds Save-to-team template flows in the app, while Den gains organizations, member roles, invitations, and a manual Cloud sign-in fallback.

#### Main changes
- Added Save-to-team flows for workspace templates, with org selection and Cloud sign-in prompts.
- Introduced Den organizations, member roles, invitations, custom roles, and org-scoped template APIs and screens.
- Added a manual Cloud sign-in fallback when automatic team-sharing auth stalls.

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

## v0.11.194

#### Commit
`41d93e2e`

#### Released at
`2026-03-26T20:46:09Z`

#### Title
Auto compaction and live automations become real workflows

#### One-line summary
Wires auto compaction to actual workspace config, keeps scheduled jobs live in-app, and adds a faster Den local-dev path.

#### Main changes
- Wired Auto context compaction to workspace config so the setting actually changes `compaction.auto`.
- Kept scheduled jobs live by polling while the Automations view is open.
- Added a faster Den local-dev path and expanded the Cloud dashboard with shared setups and background-agent links.

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

## v0.11.195

#### Commit
`9d5b14b4`

#### Released at
`2026-03-27T22:02:59Z`

#### Title
Local workspace creation and Den worker setup get steadier

#### One-line summary
Routes new local workspaces through the local host, persists model defaults properly, and smooths Den worker-connect and billing flows.

#### Main changes
- Created local workspaces through the local host so setup and binding finish correctly.
- Preserved workspace default model changes and added a quick compact-session action in chat.
- Simplified Den organization, worker-connect, and billing flows with less polling jank.

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

## v0.11.196

#### Commit
`663e357b`

#### Released at
`2026-03-30T21:27:27Z`

#### Title
OpenWork resumes where you left off

#### One-line summary
Boots back into the last session, routes straight into session view, and moves automations onto a live scheduler-backed page.

#### Main changes
- Reopened the last session on workspace boot and routed straight into the session view.
- Moved automations onto a dedicated page backed by live local or remote scheduler jobs.
- Fixed bootstrap and workspace switching so Welcome setup and loading states stop interrupting startup.

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

## v0.11.197

#### Commit
`020d7636`

#### Released at
`2026-03-31T05:21:16Z`

#### Title
Sharing gets safer and startup gets less noisy

#### One-line summary
Hardens workspace sharing, keeps orchestrator secrets out of CLI args and logs, and removes noisy sidebar and Welcome-workspace boot behavior.

#### Main changes
- Blocked sensitive workspace exports and showed warnings before sharing risky config or secrets.
- Trusted bundle imports only from the configured publisher unless users explicitly choose a warning-backed manual path.
- Moved OpenWork tokens off CLI args and logs, stopped auto-creating Welcome, and fixed collapsed sidebar session lists.

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

## v0.11.198

#### Commit
`761796fd`

#### Released at
`2026-03-31T06:00:47Z`

#### Title
Local workspace switches restart the right engine

#### One-line summary
Fixes a local-only switch bug so changing between local workspaces restarts the engine instead of reusing the old connection.

#### Main changes
Captures the previous local workspace path before selection changes so switching between local workspaces restarts the engine instead of reusing the old connection.

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

## v0.11.199

#### Commit
`4a3e43e5`

#### Released at
`2026-04-02T02:18:50Z`

#### Title
Pricing, skill hubs, and session recovery sharpen up

#### One-line summary
Adds pricing and paid Windows messaging, expands Den with skill hubs and `den-api`, and improves everyday session recovery and debugging.

#### Main changes
- Added a pricing page and paid Windows messaging, and sent Cloud navigation directly into the app.
- Expanded Den with skill hubs, a new `den-api`, and a smoother org-invite signup flow.
- Added developer log export, per-conversation draft persistence, and recovery after immediate send failures.

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

## v0.11.200

#### Commit
`5cc7bbdd`

#### Released at
`2026-04-03T15:22:13Z`

#### Title
Cloud skills and team limits move into the core flow

#### One-line summary
Brings Cloud team skills into the app, adds Den teams and deeper skill-hub management, and enforces org limits during creation.

#### Main changes
- Added an OpenWork Cloud skills catalog to the Skills page, with install and share-to-team flows.
- Added Den teams plus full skill hub and skill editing and visibility management.
- Moved billing into org creation and enforced organization member limits before setup finishes.

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
