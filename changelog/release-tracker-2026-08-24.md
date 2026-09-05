# Release Changelog Tracker

Internal preparation file for release summaries. This is not yet published to the changelog page or docs.

## v0.18.36

#### Commit
`0f0c7d4e`

#### Released at
`2026-08-24T00:34:54Z`

#### Title
Hosted MCP Apps and cloud sign-in become more reliable

#### One-line summary
Routes hosted MCP Apps through the credential-bound Den gateway and hardens cloud sign-in, live sessions, updates, and MCP recovery.

#### Main changes
- Hosted MCP Apps now render through the credential-bound Den gateway, and Connect refreshes its MCP App catalog when cached inventory is incomplete.
- Fixed Den callback routing, API-origin derivation, and cookie forwarding so hosted sign-in remains on the correct domain.
- Workspace switches preserve live agent runs under load, while stale tool activity and scrolling no longer disrupt the active transcript.
- Desktop update channel selection stays stable, Automation control-plane traffic is bounded, and standalone MCP requests stop retrying indefinitely.
- Clarified the difference between local setup, managed OpenWork Cloud, OpenCode models, and OpenWork-managed models.

#### Lines of code changed since previous release
125650 lines changed since `v0.18.35` (13432 insertions, 112218 deletions).

#### Release importance
Major release: makes hosted MCP Apps, cloud authentication, live sessions, and background recovery more dependable.

#### Major improvements
True

#### Number of major improvements
2

#### Major improvement details
- Rendered hosted MCP Apps through the credential-bound Den gateway.
- Clarified local, managed Cloud, OpenCode, and OpenWork model setup.

#### Major bugs resolved
True

#### Number of major bugs resolved
4

#### Major bug fix details
- Repaired Den callback routing, API-origin derivation, and cookie forwarding.
- Preserved live agent runs across workspace switches.
- Kept desktop update channel selection stable.
- Bounded Automation and standalone MCP retry traffic.

#### Deprecated features
False

#### Number of deprecated features
0

#### Deprecated details
None.
