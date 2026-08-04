# Release Changelog Tracker

Internal preparation file for release summaries. This is not yet published to the changelog page or docs.

## v0.18.9

#### Commit
`1d86565d`

#### Released at
`2026-07-28T09:49:35Z`

#### Title
Linux AppImage installs repair themselves

#### One-line summary
Integrates Linux AppImages with the desktop, silently repairs the launcher after updates, and stops Den workers from wedging on existing sandboxes.

#### Main changes
- Linux AppImages now integrate with the desktop and the launcher repairs itself silently after updates.
- Update chain-repair budgets widened so repairs finish on slow networks.
- Den workers now adopt an existing Daytona sandbox instead of wedging forever during provisioning.

#### Lines of code changed since previous release
2279 lines changed since `v0.18.8` (2079 insertions, 200 deletions).

#### Release importance
Minor release: focuses on Linux install and update reliability plus cloud worker recovery without adding new product capability.

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
- Fixed Linux AppImage desktop integration so installs land with proper launcher entries.
- Fixed the AppImage launcher to repair itself silently after updates, with wider repair budgets for slow networks.
- Fixed Den worker provisioning to adopt an existing Daytona sandbox instead of blocking the worker forever.

#### Deprecated features
False

#### Number of deprecated features
0

#### Deprecated details
None.

## v0.18.10

#### Commit
`ff93acce`

#### Released at
`2026-07-29T05:37:14Z`

#### Title
Org connections reach the desktop and cloud providers turn dependable

#### One-line summary
Lets members manage organization connections from the desktop and reworks cloud LLM provider delivery so org-approved models reliably reach the engine.

#### Main changes
- Organization connections can be connected, reconnected, and disconnected directly from the desktop Extensions surface.
- Cloud LLM providers are materialized server-side, made engine-global, and verified from the instance so they actually reach the engine.
- Cloud workspaces gained a status and version overlay with one-click update, boot states took over the main area, and the OpenWork Models startup dialog became a quiet inline hint.
- Den invite lifecycles were fixed and the BYOK provider editor was redesigned with auto-naming and a sticky save bar.

#### Lines of code changed since previous release
23146 lines changed since `v0.18.9` (21354 insertions, 1792 deletions).

#### Release importance
Major release: reworks how cloud providers reach the engine and brings organization connection management into the desktop app.

#### Major improvements
True

#### Number of major improvements
3

#### Major improvement details
- Added desktop management of organization connections, including connect, reconnect, and disconnect flows.
- Made cloud LLM providers engine-global with atomic server-side materialization so org-approved models work dependably.
- Added a cloud workspace overlay with status, version, and one-click update.

#### Major bugs resolved
True

#### Number of major bugs resolved
3

#### Major bug fix details
- Fixed Den invite lifecycles so already-accepted invites resolve, member removal sticks, and re-invited members revive cleanly.
- Fixed den-api to tolerate sandboxes older than itself instead of rolling back working credentials.
- Fixed the composer so attachments work before a session exists and model access can be retried from the inline hint.

#### Deprecated features
False

#### Number of deprecated features
0

#### Deprecated details
None.

## v0.18.11

#### Commit
`ed16748e`

#### Released at
`2026-07-29T22:16:08Z`

#### Title
Live agent runs stop getting interrupted

#### One-line summary
Keeps agent event streams alive through credential and provider changes, speeds up composer pickers, and hardens Den organization lifecycles.

#### Main changes
- Agent event streams now survive credential changes, ref-count churn, and provider re-materialization, and no-op provider patches no longer reload the engine.
- Composer skills, MCP, and extension pickers load instantly from local data while cloud results land live.
- Den organization lifecycles were hardened: serialized invitation transitions, re-invite recovery, team cleanup, legacy SSO and SCIM migration, and preserved model-access policy on rejoin.
- A malformed workspace list no longer makes the app unloadable, and much of the remaining diff is internal evals lab infrastructure.

#### Lines of code changed since previous release
26773 lines changed since `v0.18.10` (23326 insertions, 3447 deletions).

#### Release importance
Minor release: concentrates on streaming reliability, Den lifecycle hardening, and internal test infrastructure rather than a new product surface.

#### Major improvements
True

#### Number of major improvements
1

#### Major improvement details
- Made composer skills, MCP, and extensions load instantly with local-first data while cloud results stream in.

#### Major bugs resolved
True

#### Number of major bugs resolved
4

#### Major bug fix details
- Fixed agent event streams so credential changes and ref-count churn no longer abort live runs.
- Fixed provider re-materialization and no-op provider patches so they stop interrupting the engine mid-run.
- Fixed session-group syncing to advance an event cursor instead of refetching from zero.
- Fixed workspace-list handling so a malformed list can no longer make the app unloadable.

#### Deprecated features
False

#### Number of deprecated features
0

#### Deprecated details
None.

## v0.18.12

#### Commit
`1119afb5`

#### Released at
`2026-07-30T08:30:18Z`

#### Title
Managed provider credentials reach the engine

#### One-line summary
Hotfix release that delivers managed cloud provider credentials to the engine auth API and redeploys den-api when the snapshot pin changes.

#### Main changes
Delivers managed provider credentials to the engine auth API so org-approved models authenticate correctly, and fixes the release pipeline to redeploy den-api after snapshot pin updates so pinned fixes actually take effect.

#### Lines of code changed since previous release
487 lines changed since `v0.18.11` (476 insertions, 11 deletions).

#### Release importance
Minor release: a focused hotfix for cloud provider credential delivery and release plumbing.

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
- Fixed managed provider credentials so they are delivered to the engine auth API and cloud models authenticate.
- Fixed the release pipeline to redeploy den-api after updating the sandbox snapshot pin so the pin takes effect.

#### Deprecated features
False

#### Number of deprecated features
0

#### Deprecated details
None.

## v0.18.13

#### Commit
`c7c115dc`

#### Released at
`2026-08-03T10:12:56Z`

#### Title
Extensions becomes the Library and skill sharing opens to every member

#### One-line summary
Renames Extensions to a stateful Library across desktop and web, lets any org member create and share plugins and cloud skills, and adds multiple named Google Workspace connectors.

#### Main changes
- Extensions became the Library: state tabs for ready, needs-sign-in, and needs-admin-setup, one catalog endpoint, real provider logos, and a member library on the web dashboard.
- Skill sharing opened up: org members can create plugins and cloud skills, share them from chat, and see access edge by edge through plugin access and team visibility panels.
- Organizations can add multiple named Google Workspace connectors; each member signs in per connector and agents pick accounts by name.
- Chat ergonomics improved: KaTeX math rendering, immediate submit feedback, number shortcuts for visible sessions, an attachment actions menu, and a right-panel action chooser.
- Cloud sandboxes keep chat history across recycles via engine session database checkpoints and per-instance materialization caches.

#### Lines of code changed since previous release
51224 lines changed since `v0.18.12` (48244 insertions, 2980 deletions).

#### Release importance
Major release: reshapes the extension and library experience and materially expands team skill sharing and Google Workspace connectivity.

#### Major improvements
True

#### Number of major improvements
3

#### Major improvement details
- Turned Extensions into the Library with readiness state tabs across desktop and web.
- Opened plugin and cloud skill creation and sharing to all organization members, with granular access visibility.
- Added support for multiple named Google Workspace connectors per organization.

#### Major bugs resolved
True

#### Number of major bugs resolved
3

#### Major bug fix details
- Fixed recycled cloud sandboxes so engine session history survives via database checkpoints and per-instance materialization caches.
- Fixed the artifact panel to refresh when the agent modifies the open file.
- Fixed billing to distinguish team seats from AI model access.

#### Deprecated features
False

#### Number of deprecated features
0

#### Deprecated details
None.
