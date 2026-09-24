# OpenCode engine selection and history migration

The command palette offers **Switch to OpenCode v1**, **Switch to OpenCode v2**,
and **Migrate chats to OpenCode v2**. Advanced settings uses the same engine
commands and migration consent dialog. Switching engines never migrates history.
V1 remains the default. Desktop packages include both pinned native executables;
v2's download fallback remains available for standalone servers.

## What migration does

Migration requires the OpenWork host token and explicit confirmation. It snapshots
the active profile's v1 SQLite database using SQLite backup (or `VACUUM INTO` on Bun), including committed
WAL writes, without modifying the original. A temporary, isolated instance of the
pinned v2 engine opens that snapshot and performs OpenCode's native conversion.
OpenWork waits for `/api/experimental/migration/v1` to report completion, then
exports converted chats and imports them into the existing v2 engine using its
native APIs. Parents precede children. Existing IDs return a conflict and are
skipped, so retries preserve v2 conversations and do not duplicate imports.
Temporary snapshots and the converter are cleaned up afterward.

Migration keeps the selected engine. It can partially complete if a chat fails;
retrying imports the remaining chats. Existing imported IDs are never overwritten,
so later edits in v1 do not sync. Stop active tasks before taking the snapshot.
The migration includes local history across workspaces in the active profile,
not history on connected remote servers. Development profiles remain isolated.

OpenCode's conversion resets session permissions and revert state, converts
interrupted tool activity, and may omit malformed rows or unsupported attachments.
Its transfer API exports settled messages. Review permissions before continuing
migrated chats. V1 plugin implementations require v2-compatible replacements;
this operation does not rewrite configuration, skills, or plugin files.

## Upstream contract reviewed

Implementation was checked against the published `@opencode-ai/core`,
`@opencode-ai/protocol`, and `@opencode-ai/server` packages at the repository pin,
`0.0.0-beta-19086`, and against the upstream v2 sources:

- [Native migration](https://github.com/anomalyco/opencode/blob/v2/packages/core/src/database/v1-migration.bun.ts)
- [Migration status API](https://github.com/anomalyco/opencode/blob/v2/packages/protocol/src/groups/migration.ts)
- [Native session transfer](https://github.com/anomalyco/opencode/blob/v2/packages/core/src/session/transfer.ts)
- [V1 compatibility guide](https://github.com/anomalyco/opencode/blob/v2/services/www/src/docs/content/migrate-v1.mdx)

## Verification

`apps/server/src/opencode-v2-migration.test.ts` checks WAL snapshots and missing
history. Its opt-in real-engine test creates v1 parent/child sessions, verifies
converted text, keeps an existing v2 chat, retries without duplicates, and checks
the source database hash. Run it with `OPENWORK_MIGRATION_LIVE_TEST=1`,
`OPENWORK_MIGRATION_V1_BIN`, and `OPENWORK_OPENCODE2_BIN` set to the pinned binaries.

The desktop `opencode-v2-chat-routing.e2e.test.ts` exercises both palette switches,
the warning and cancellation from settings and palette, and real chat turns on
both engines. UI consent/blocked/progress tests and desktop target mapping tests
also run in the core checks.

Design: P3 (details disclosure), P5 (existing ToggleGroup, Button and AlertDialog),
P9 (migration data and risks), P10 (desktop screenshots), S2 (settings rows), S6
(shared commands), C1 (verb-first actions), C6 (retryable errors).
