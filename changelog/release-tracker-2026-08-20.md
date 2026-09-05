# Release Changelog Tracker

Internal preparation file for release summaries. This is not yet published to the changelog page or docs.

## v0.18.34

#### Commit
`03507e5d`

#### Released at
`2026-08-20T19:28:27Z`

#### Title
MCP Apps guide connection setup and Desktop automations recover cleanly

#### One-line summary
Adds first-party MCP App cards for connection flows, strengthens Desktop automation recovery, and renames Programs to Workflows.

#### Main changes
- Added first-party MCP App cards that guide connection, plugin, and skill-created flows directly in chat.
- Desktop automations now report outcomes, open their execution threads, and recover missed runs and credential failures.
- Renamed Programs to Workflows and retired legacy MCP App surfaces and selection tools.
- Hardened MCP recovery, OAuth grant liveness, server credentials, and connection error handling.
- Added current product screenshots, enterprise desktop deployment guidance, and an Automation deployment kill switch.

#### Lines of code changed since previous release
63338 lines changed since `v0.18.33` (58371 insertions, 4967 deletions).

#### Release importance
Major release: expands interactive MCP Apps, makes Desktop automations recoverable, and simplifies Workflows across the product.

#### Major improvements
True

#### Number of major improvements
4

#### Major improvement details
- Added first-party MCP App cards for connection, plugin, and skill-created flows.
- Added Desktop automation outcome reporting and direct execution-thread access.
- Renamed Programs to Workflows and removed obsolete selection surfaces.
- Added current product documentation and an Automation deployment kill switch.

#### Major bugs resolved
True

#### Number of major bugs resolved
3

#### Major bug fix details
- Recovered missed Desktop automation occurrences and rejected credentials.
- Kept Desktop server credentials coherent during managed MCP recovery.
- Hardened MCP connection failures, protocol compatibility, OAuth liveness, and reconnect bursts.

#### Deprecated features
True

#### Number of deprecated features
2

#### Deprecated details
- Retired legacy MCP App surfaces.
- Removed obsolete Program selection tools in favor of Workflows.

## v0.18.35

#### Commit
`13504969`

#### Released at
`2026-08-20T20:14:28Z`

#### Title
Desktop respects Automation deployment controls

#### One-line summary
Keeps Automation routes, proposals, and Desktop runners off unless the connected deployment explicitly enables them.

#### Main changes
- Desktop now reads Automation availability from the connected deployment.
- Automation navigation, proposals, and runner registration stay disabled unless the deployment explicitly opts in.
- Older or self-hosted deployments that do not advertise availability fail closed.

#### Lines of code changed since previous release
123 lines changed since `v0.18.34` (86 insertions, 37 deletions).

#### Release importance
Minor release: completes the Automation deployment control by enforcing it throughout Desktop.

#### Major improvements
True

#### Number of major improvements
1

#### Major improvement details
- Enforced deployment-level Automation availability across Desktop routes, proposals, and runner registration.

#### Major bugs resolved
False

#### Number of major bugs resolved
0

#### Major bug fix details
None.

#### Deprecated features
False

#### Number of deprecated features
0

#### Deprecated details
None.
