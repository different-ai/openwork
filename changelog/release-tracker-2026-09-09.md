# Release Changelog Tracker

Internal preparation file for release summaries. This is not yet published to the changelog page or docs.

## v0.18.43

#### Commit
`60d27d29`

#### Released at
`2026-09-09T03:28:56Z`

#### Title
Desktop connections unify and agent work recovers more reliably

#### One-line summary
Unifies desktop connection status while making browser tasks, sessions, sign-in, and managed capabilities more dependable.

#### Main changes
- Uses one native desktop connection card for every status response.
- Browser tasks now support site tools, page controls, tab suspension and reload, selected-login sync, and user takeover.
- Improved session recovery, stop responsiveness, stalled sends, interrupted-task resumption, message visibility, and attachment drafts.
- Added computer-use hosted approval, native preview, fresh-state recovery, scoped native sessions, and takeover continuation.
- Expanded organization access, connector setup, workflow apps, analytics, onboarding, and desktop policy controls.

#### Lines of code changed since previous release
302353 lines changed since `v0.18.42` (233793 insertions, 68560 deletions).

#### Release importance
Minor release: broad desktop, browser, session, computer-use, and organization workflow improvements without a major-version change.

#### Major improvements
True

#### Number of major improvements
4

#### Major improvement details
- Added browser task controls, including site tools, page controls, tab suspension and reload, and user takeover.
- Added computer-use hosted approval, native previews, scoped native sessions, and recovery through takeover and refresh.
- Added organization admin access through approved teams and expanded team, browser, command, and desktop policies.
- Added workflow apps, saved workflow activity, model analytics, and a cloud runtime provider contract.

#### Major bugs resolved
True

#### Number of major bugs resolved
5

#### Major bug fix details
- Unified desktop connection status in one native connection card and preserved renewed MCP credentials after stale rejection.
- Recovered dashboard sharing after identity verification and improved installed-desktop and SSO handoffs.
- Kept Stop responsive, recovered stalled sends and interrupted managed responses, and preserved session transcript and message state.
- Preserved attachment drafts and feedback, showed sent messages promptly, and scoped storage failures to the task that failed.
- Stabilized browser login sync, retained tabs within bounds, released abandoned pages, and kept browser views isolated from OpenWork.

#### Deprecated features
False

#### Number of deprecated features
0

#### Deprecated details
None.

## v0.18.44

#### Commit
`cac94b07`

#### Released at
`2026-09-09T05:32:36Z`

#### Title
Sessions preserve live progress and drafts

#### One-line summary
Preserves live session progress and composer drafts while recording shared callback modes and removing the legacy embedded connection path.

#### Main changes
- Preserved live progress when hydrating cached threads.
- Recorded the shared callback mode for isolated MCP rows with shared registrations.
- Preserved composer drafts and verified instant sends.
- Removed the legacy embedded connection app and gateway launch path.

#### Lines of code changed since previous release
4945 lines changed since `v0.18.43` (4095 insertions, 850 deletions).

#### Release importance
Minor release: focused session, composer, MCP callback, and legacy connection-path improvements without a major-version change.

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
- Preserved live progress when hydrating cached threads.
- Recorded the shared callback mode for isolated MCP rows with shared registrations.
- Preserved composer drafts and verified instant sends.

#### Deprecated features
True

#### Number of deprecated features
1

#### Deprecated details
- Removed the legacy embedded connection app and gateway launch path.
