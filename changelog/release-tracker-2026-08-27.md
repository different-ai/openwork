# Release Changelog Tracker

Internal preparation file for release summaries. This is not yet published to the changelog page or docs.

## v0.18.38

#### Commit
`5a7ea5af`

#### Released at
`2026-08-27T13:24:26Z`

#### Title
Split-view workflows and live sessions get more dependable

#### One-line summary
Adds cross-workspace split view and interrupted-run recovery while keeping live sessions and long-running streams responsive.

#### Main changes
- Added cross-workspace split view and transcript actions for resuming interrupted runs.
- Live session status now survives navigation, workspace switches, and reattachment while long-running streams remain responsive.
- Refined tool-call activity, thought grouping, artifact controls, and Library choices so active work is easier to follow and manage.
- Cloud extension status now reflects real connectivity, remote-session capabilities reach cloud targets, and worker recovery avoids competing owners.
- Added a pull-only Docker evaluation stack and strengthened enterprise licensing documentation and stewardship metadata.

#### Lines of code changed since previous release
12814 lines changed since `v0.18.37` (11415 insertions, 1399 deletions).

#### Release importance
Major release: adds cross-workspace split view and makes live session recovery and active work presentation more dependable.

#### Major improvements
True

#### Number of major improvements
4

#### Major improvement details
- Added cross-workspace split view.
- Added transcript actions for resuming interrupted runs.
- Refined tool-call activity, thought grouping, artifact controls, and Library choices.
- Added cloud-target remote-session capabilities and a pull-only Docker evaluation stack.

#### Major bugs resolved
True

#### Number of major bugs resolved
4

#### Major bug fix details
- Preserved live session status across navigation and workspace switches.
- Kept reattached observers live.
- Improved long-running stream responsiveness.
- Made Cloud extension status and worker recovery reflect real ownership and connectivity.

#### Deprecated features
False

#### Number of deprecated features
0

#### Deprecated details
None.

## v0.18.39

#### Commit
`63625a4b`

#### Released at
`2026-08-27T23:29:36Z`

#### Title
Richer session artifacts and more resilient agent runs

#### One-line summary
Moves session files into the artifact rail, adds richer Markdown controls, and strengthens run recovery across desktop, web, and cloud.

#### Main changes
- Session files now live in the artifact rail instead of interrupting the chat transcript, with safer badge layout and responsive behavior on narrow screens.
- Markdown can render Mermaid diagrams safely, and code blocks offer a word-wrap control for long lines.
- Agent runs recover more reliably from idle admissions, queued follow-ups, event-stream restarts, Settings visits, and large workspace session histories.
- OpenWork Cloud adds per-member managed-model credentials, paid browser access, desktop delivery for remote-session commands, and more reliable worker recovery.
- Electron file transfers now work correctly across the remote bridge, and LiteLLM examples include synchronized model metadata.

#### Lines of code changed since previous release
55851 lines changed since `v0.18.38` (53651 insertions, 2200 deletions).

#### Release importance
Major release: improves session artifact workflows and makes local, remote, and cloud agent runs substantially more resilient.

#### Major improvements
True

#### Number of major improvements
5

#### Major improvement details
- Moved session files into the artifact rail.
- Added safe Mermaid rendering and code-block word wrapping.
- Added per-member managed-model credentials.
- Added paid OpenWork browser access and desktop remote-session delivery.
- Synchronized LiteLLM example model metadata.

#### Major bugs resolved
True

#### Number of major bugs resolved
5

#### Major bug fix details
- Recovered agent runs from idle admissions and queued follow-up wedges.
- Restarted dead event streams after synchronization changes.
- Prevented Settings visits from interrupting healthy runs.
- Bounded large workspace session hydration and improved worker recovery.
- Corrected Electron remote binary transfers and narrow-screen layouts.

#### Deprecated features
True

#### Number of deprecated features
1

#### Deprecated details
- Removed the legacy cloud worker proxy path.
