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

Improves local session reliability first, then adds clearer Soul controls and cleaner settings and sidebar actions.

#### Main changes

- Added a local recovery flow for broken OpenCode database migrations so local startup can repair itself.
- Improved Soul starter observability and steering so users can inspect and guide Soul behavior more clearly.
- Refreshed compact action buttons across settings and sidebars to make update and connection controls easier to scan.

#### Lines of code changed since previous release

1248 lines changed since `v0.11.100` (933 insertions, 315 deletions).

#### Release importance

Minor release: improves local recovery, Soul steering, and interface clarity without changing the product's core architecture.

#### Major improvements

True

#### Number of major improvements

2

#### Major improvement details

- Added a repair flow for failed local OpenCode database migrations from onboarding and Settings > Advanced.
- Added stronger Soul starter steering and observability controls, including clearer status and improvement actions.

#### Major bugs resolved

True

#### Number of major bugs resolved

1

#### Major bug fix details

- Fixed a local startup failure path by letting users recover from OpenCode migration issues instead of getting stuck on a broken local flow.

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
