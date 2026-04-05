# Release Changelog Tracker

Internal preparation file for release summaries. This is not yet published to the changelog page or docs.

## v0.11.201

#### Commit
`15725dfb`

#### Released at
`2026-04-04T01:59:47Z`

#### Title
Workspace lists collapse cleanly and Den organization setup recovers more reliably.

#### One-line summary
Hides collapsed workspace task rows, steadies session loading, and fixes Den skill saving plus organization draft and invite recovery.

#### Main changes
- Collapsed workspaces now hide task rows, empty states, and loading shells until reopened.
- Session loading stops refetch churn and early stream flicker.
- Den now saves skill metadata from frontmatter and restores pending org drafts and invite counts.

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

## v0.11.202

#### Commit
`ff981742`

#### Released at
`2026-04-04T20:45:30Z`

#### Title
Translations fill out across the app and shared skill imports work again.

#### One-line summary
Adds Thai, restores missing page translations, fixes migrated shared-skill links, and tightens docs and local desktop dev setup.

#### Main changes
Completed localization coverage across the app and added Thai as a selectable language.

Also released:

- Restored shared-skill import links and canonical bundle fetch URLs.
- Added clearer automations and skill-import docs.
- Stopped desktop dev from reusing another checkout's Vite server.

#### Lines of code changed since previous release
8103 lines changed since `v0.11.201` (7198 insertions, 905 deletions).

#### Release importance
Minor release: expands localization coverage and fixes important import and desktop-dev paths without changing the core product model.

#### Major improvements
True

#### Number of major improvements
1

#### Major improvement details
- Added Thai and completed translation coverage across the app's shipped locales.

#### Major bugs resolved
True

#### Number of major bugs resolved
3

#### Major bug fix details
- Restored missing page translations and corrected locale labels so translated screens stop falling back unexpectedly.
- Restored migrated shared-skill links and canonical bundle fetch URLs so docs imports work again.
- Stopped desktop dev from reusing another checkout's Vite server.

#### Deprecated features
False

#### Number of deprecated features
0

#### Deprecated details
None.
