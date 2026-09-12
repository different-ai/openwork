# Release Changelog Tracker

Internal preparation file for release summaries. This is not yet published to the changelog page or docs.

## v0.18.45

#### Commit
`c744e2d7`

#### Released at
`2026-09-10T01:29:01Z`

#### Title
Cloud connections unify and desktop recovery gets stronger

#### One-line summary
Centralizes Workspace support on Cloud Connect while improving desktop recovery, browser controls, and release reliability.

#### Main changes
- Centralized Google Workspace support on Cloud Connect and added working Gmail, Calendar, Drive, Sheets, and Microsoft 365 actions.
- Improved desktop recovery for credentials, cloud sessions, native updates, startup errors, and renderer failures.
- Added native page context menus and native right-click menus.
- Made launchable openwork-server and AUR binaries available and added blank published desktop release previews.
- Improved automation warm-up, analytics pagination, browser policy handling, Gmail draft attachments, and session transcript loading.

#### Lines of code changed since previous release
45901 lines changed since `v0.18.44` (37059 insertions, 8842 deletions).

#### Release importance
Minor release: broad connection, desktop recovery, browser, automation, and release reliability improvements without a major-version change.

#### Major improvements
True

#### Number of major improvements
2

#### Major improvement details
- Centralized Google Workspace support on Cloud Connect and added working Gmail, Calendar, Drive, Sheets, and Microsoft 365 actions.
- Added native page context menus and native right-click menus.

#### Major bugs resolved
True

#### Number of major bugs resolved
5

#### Major bug fix details
- Recovered credentials before engine readiness and restored cloud sessions after runtime replacement.
- Restored startup recovery button contrast and showed a recovery screen instead of a blank window when rendering throws.
- Waited for native update readiness before restarting and kept launchable openwork-server and AUR binaries shipping.
- Kept analytics refresh from dropping paginated tasks and waited for engine warm-up before Cloud automation runs.
- Fulfilled Gmail draft attachments through the connector and loaded the whole transcript when opening a session.

#### Deprecated features
False

#### Number of deprecated features
0

#### Deprecated details
None.
