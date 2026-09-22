# Release Changelog Tracker

Internal preparation file for release summaries. This is not yet published to the changelog page or docs.

## v0.18.50

#### Commit
`4707262e`

#### Released at
`2026-09-22T21:19:28Z`

#### Title
Preview worlds resume reliably and connection setup stays actionable

#### One-line summary
Improves preview world recovery, connection setup, self-hosted server access, and agent gateway skill discovery.

#### Main changes
- Warm sandbox preview links now open reliably.
- Running ACME worlds can resume with AI Gateway enabled, and full ACME worlds can launch with revealed outputs.
- Chat connection questions stay actionable with a native connection card.
- Added the `openwork-server web` self-host command and agent gateway tools for listing and retrieving skills.
- Simplified Warden to security reviews with timing reports.

#### Lines of code changed since previous release
17096 lines changed since `v0.18.49` (9924 insertions, 7172 deletions).

#### Release importance
Minor release: adds preview, server, gateway, and chat capabilities without a major-version change.

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
- Warm sandbox preview links now open reliably.
- Chat connection questions no longer dead-end and use a native connection card.

#### Deprecated features
False

#### Number of deprecated features
0

#### Deprecated details
None.
