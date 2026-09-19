# Release Changelog Tracker

Internal preparation file for release summaries. This is not yet published to the changelog page or docs.

## v0.18.48

#### Commit
`c67ba51e`

#### Released at
`2026-09-15T21:20:24Z`

#### Title
Live workflow apps and session recovery become more dependable

#### One-line summary
Adds receipt-backed live workflow authoring and generated apps while improving session, browser, and organization reliability.

#### Main changes
- Added receipt-backed live workflow authoring.
- Added caller-scoped and viewer-live generated apps with bounded refresh and invocation lifetimes.
- Improved child interactions, localized attention, session refresh, thread loading, and sidebar-created threads.
- Improved browser tab reconciliation, consent scrolling, browser-session origins, and configured API origins.
- Improved Tool Tester placement, SCIM user linking and diagnostics, and saved-app presentation.

#### Lines of code changed since previous release
25524 lines changed since `v0.18.47` (24577 insertions, 947 deletions).

#### Release importance
Minor release: adds live workflow and generated-app capabilities while strengthening session, browser, and organization flows without a major-version change.

#### Major improvements
True

#### Number of major improvements
2

#### Major improvement details
- Added receipt-backed live workflow authoring.
- Added caller-scoped and viewer-live generated apps with refresh and invocation support.

#### Major bugs resolved
True

#### Number of major bugs resolved
5

#### Major bug fix details
- Recovered child interactions and refreshed localized attention more reliably.
- Kept the send button usable when session refresh fails and reduced thread and subagent refresh work.
- Reconciled browser tabs before opening the rail and corrected browser consent scrolling and session origins.
- Opened sidebar-created threads in the main pane and shared saved-app tile presentation.
- Honored configured API origins during MCP consent and bounded live-app refresh and invocation lifetimes.

#### Deprecated features
False

#### Number of deprecated features
0

#### Deprecated details
None.
