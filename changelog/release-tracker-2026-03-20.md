# Release Changelog Tracker

Internal preparation file for release summaries. This is not yet published to the changelog page or docs.

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

