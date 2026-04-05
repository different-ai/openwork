# Release Changelog Tracker

Internal preparation file for release summaries. This is not yet published to the changelog page or docs.

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
