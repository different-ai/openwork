# Release Changelog Tracker

Internal preparation file for release summaries. This is not yet published to the changelog page or docs.

## v0.18.47

#### Commit
`65c4286a`

#### Released at
`2026-09-15T04:52:05Z`

#### Title
MCP Apps become easier to set up and safer to use

#### One-line summary
Improves MCP App setup and layout while making app actions, live sessions, and cloud runtime behavior more dependable.

#### Main changes
- Shows external setup URLs and allows MCP Apps to use bound resources.
- Adds a read-only execution boundary for live apps.
- Presents MCP Apps in a more compact masonry dashboard layout.
- Keeps app actions, errors, discovery, and approvals more reliable across refreshes and slow startup.
- Improves session navigation, message continuity, previews, models, cloud instances, and provider handling.

#### Lines of code changed since previous release
197480 lines changed since `v0.18.46` (184657 insertions, 12823 deletions).

#### Release importance
Minor release: adds MCP App and cloud runtime capabilities while delivering broad reliability improvements without a major-version change.

#### Major improvements
True

#### Number of major improvements
3

#### Major improvement details
- Shows external setup URLs and allows bound MCP App resources.
- Adds a read-only execution boundary for live apps.
- Adds a compact masonry layout for MCP Apps in the dashboard.

#### Major bugs resolved
True

#### Number of major bugs resolved
5

#### Major bug fix details
- Removes redundant MCP App action confirmations and supports in-app approval for gated actions.
- Preserves MCP App actions and errors across refreshes and keeps slow discovery visible in chat.
- Keeps browser access available without open tabs and preserves same-origin preview API mounts.
- Preserves workbench continuity during thread navigation and keeps prompt order during new-thread streaming.
- Preserves granted OAuth scopes across token refreshes and restores Ollama as a dedicated Settings option.

#### Deprecated features
False

#### Number of deprecated features
0

#### Deprecated details
None.
