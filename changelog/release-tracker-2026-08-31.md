# Release Changelog Tracker

Internal preparation file for release summaries. This is not yet published to the changelog page or docs.

## v0.18.40

#### Commit
`214c32b8`

#### Released at
`2026-08-31T02:21:17Z`

#### Title
Portable Agent Plugins arrive and desktop sessions run calmer

#### One-line summary
Adds portable Agent Plugin support and workspace-pinned Automations while eliminating desktop request storms and hardening access security.

#### Main changes
- OpenWork can now import and run portable Agent Plugins, bringing Anthropic-compatible plugin packs into the desktop app.
- Automations can be pinned to an explicit workspace, and remote-session commands now arrive in native local desktop sessions.
- Fixed request storms and reload loops across Settings, desktop policies, the Library, the composer, and session search so long sessions stay fast.
- Gmail replies gained collapsible quoting and reply attachments, and OpenWork Cloud members receive complimentary OpenWork Web access.
- Strengthened SAML validation, organization API key authentication, and hosted-origin access checks, and made the desktop recover from socket and renderer crashes.

#### Lines of code changed since previous release
70230 lines changed since `v0.18.39` (63446 insertions, 6784 deletions).

#### Release importance
Major release: adds portable Agent Plugin support and remote-session delivery while stabilizing desktop performance and access security.

#### Major improvements
True

#### Number of major improvements
4

#### Major improvement details
- Added portable Agent Plugin support.
- Added workspace-pinned Automations and native delivery of remote-session commands.
- Added collapsible Gmail reply quoting and reply attachments.
- Granted complimentary OpenWork Web access to OpenWork Cloud members.

#### Major bugs resolved
True

#### Number of major bugs resolved
4

#### Major bug fix details
- Stopped settings, desktop-policy, Library, and composer request storms and reload loops.
- Kept actively streaming sessions alive through the engine drain deadline.
- Recovered desktop sessions from socket and renderer crashes.
- Validated SAML responses against the SP-advertised ACS origin and authenticated organization API keys.

#### Deprecated features
True

#### Number of deprecated features
1

#### Deprecated details
- Removed the dead legacy session surface from openwork-server.
