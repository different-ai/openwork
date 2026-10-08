# Release Changelog Tracker

Internal preparation file for release summaries. This is not yet published to the changelog page or docs.

## v0.18.49

#### Commit
`e8c6de42`

#### Released at
`2026-09-21T23:52:35Z`

#### Title
Agent sessions recover more reliably and provider connections stay consistent

#### One-line summary
Improves conversation recovery, mobile chat, provider setup, streamed responses, and cloud connection reliability.

#### Main changes
- Removed custom agents.
- Improved conversation history loading, first-send continuity, session drafts, queued messages, and background streaming.
- Improved mobile chat submission, scrolling, keyboard behavior, sidebar layout, and prompt suggestions.
- Preserved proxied and streamed response bodies while making cancelled reads and provider credential loading more reliable.
- Added readable linked task references, alpha build metadata, and per-member usage limit policies.

#### Lines of code changed since previous release
156928 lines changed since `v0.18.48` (151927 insertions, 5001 deletions).

#### Release importance
Minor release: broad reliability, chat, provider, and cloud workflow improvements without a major-version change.

#### Major improvements
False

#### Number of major improvements
0

#### Major improvement details
None.

#### Major bugs resolved
True

#### Number of major bugs resolved
5

#### Major bug fix details
- Filled underfilled newest history pages and preserved first-send continuity when conversations are reopened or remounted.
- Preserved background streaming, proxied response bodies, streamed response integrity, and cancelled-read handling.
- Improved mobile submission, scrolling, keyboard, composer, new-turn, and sidebar behavior.
- Rejected blank provider credentials and refreshed credentials and provider readiness at the right time.
- Stabilized cloud workspace startup, gateway usage refresh, MCP readiness, and task recovery.

#### Deprecated features
True

#### Number of deprecated features
1

#### Deprecated details
- Removed custom agents.
