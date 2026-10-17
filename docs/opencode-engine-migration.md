# OpenCode engine selection and history migration

On desktop, the command palette offers **Switch to OpenCode v1**, **Switch to OpenCode v2**,
and **Migrate chats to OpenCode v2**. Advanced settings uses the same engine
commands. Both hand off to one app-wide owner (`shell/engine-migration.tsx`)
for the switch check, the migration consent, and migration progress, so a
migration stays visible after the surface that started it closes. Switching
engines never migrates history. V1 remains the default. Desktop packages include
both pinned native executables; v2's download fallback remains available for
standalone servers.

## Organization-managed rollout

`engineV2ForceUpgrade` is off by default on cloud and self-hosted deployments.
When an organization's resolved flag is on, desktop and web hosts reuse the
same backup/copy migration in the background, wait for idle, and select v2
without consent. Desktop shows only the existing non-blocking progress banner;
web shows no engine upgrade UI. Fresh profiles select v2 without a history copy.
The optional desktop `engineV2Upgrade` invitation still works when force is off.
All app feature observers use the shared guarded `useOrgFeature` hook: cached
organization data cannot bypass a desktop-only guard.

Turning the flag off switches only force-owned instances back to v1, once idle.
An explicit manual engine choice clears that ownership, so it is not reverted.
Neither direction deletes history: v1 originals remain in place and new v2
chats remain in v2 storage for a later switch back. Policy updates do not abort
a copy or a running task. Failures keep v1 selected, retain a durable error and
backup receipt, and retry only on a later boot with a one-minute-to-one-day
bounded exponential backoff. Source chat changes during copying or v2 startup
prevent the switch; a later attempt restores the pre-copy v2 baseline under
the existing migration ownership lock before copying a fresh v1 snapshot.

Hosted bootstrap sets `OPENWORK_ENGINE_FORCE_POLICY=1` and an explicit
`OPENWORK_ENGINE_AUTO_UPGRADE=1` or `0`; registered runner inventory and worker
activity responses refresh the same resolved policy. An absent policy on a
standalone server does not mean an organization requested a revert. Web
snapshots bake the pinned, integrity-checked v2 executable and set
`OPENWORK_OPENCODE2_BIN`, so boot never downloads it. The sandbox's existing
checkpoint policy retains three snapshots of runtime data and engine state
as an additional safety net; there is no new restore UI.

## Running tasks, switching, and migration progress

Before switching, the app reads `GET /experimental/engine-v2-preview/activity`
(counts only) for the engine being left. Running v1 tasks keep running unseen
after a switch to v2, and switching to v1 stops the v2 sidecar, so either case
asks first ("Switch anyway" / "Stop tasks and switch").

Migration consent names running v1 tasks the same way: a chat copied mid-turn
lands in v2 half-finished while v1 keeps running it. The server enforces this:
`POST …/migrate` answers 409 `engine_migration_active_sessions` while v1 reports
busy work, unless the request sets `allowActiveSessions: true` ("Migrate
anyway"). Engine switches during a migration answer 409
`engine_migration_running`.

While a migration runs, a modal shows progress. The person can choose
**Continue using OpenWork**, which leaves a top banner ("OpenWork may be
unstable until this finishes") with **Show progress**. Status reports a
`phase` (`starting`, `converting`, `copying`) and `startedAt`; the counts only
move while copying, so the bar is indeterminate before that instead of
showing a stalled "0 of N". A finished migration offers **Switch to OpenCode
v2**; one finished in the background reports with a toast instead. A failure
brings the dialog back with **Try again**, which skips chats already copied.

Session sync keys run state by workspace and session, not by engine, and
migrated chats keep their ids. A status read is therefore only adopted by the
engine it came from, a released sync for the other engine is disposed when
chats move to a new engine, and failed status reads back off instead of
polling an unreachable engine at 4 Hz.

Connect health and repair follow the active local engine. On v2, diagnostics
read native `/api/mcp` connection status and `/api/model` tool capabilities;
they do not look for the selected model in v1's catalog or require v1 plugin
canary tools. Remote workspace diagnostics remain with their owning server.
The connector parity proof checks health, repair, and real capability execution
on both engines.

## What migration does

Migration requires the OpenWork host token and explicit confirmation. It takes
an immutable SQLite snapshot of the active profile's v1 database, including
committed WAL writes. The original database is never modified.

The copy has durable stages: snapshot, reversible payload externalization,
native conversion, payload restoration, and transactional transfer. Large JSON
strings are held in SQLite and replaced with unique references in the private
conversion workspace. The pinned native converter processes those references;
SQLite restores their exact values afterward, including inline files. No chat
is trimmed, and no whole-chat export or import body is allocated in JavaScript.

The v2 engine initializes its own schema and then closes before the transfer.
Managed engine leases and a pending-copy fence keep other managed app instances
from opening that database during an unfinished copy. Running v2 tasks prevent
the copy from starting. V1 remains available; v2 chats pause until completion.
The projected schemas must match before target writes begin.

Messages move in bounded row batches, including a single very large payload
without decoding it in JavaScript. Each batch commits its progress in the target
SQLite database. A killed worker rolls back its active transaction; retry or
restart resumes the retained workspace and committed batches. Conversion and
payload restoration have their own restart checkpoints. Errors never blacklist
a chat or mark a partial copy complete.

Existing v2 chats are skipped without changing their messages, metadata, order,
or event history. A new session and its migration checkpoint are created in one
transaction. Only that checkpoint lets the migration resume writing the session;
a matching session ID alone does not. New messages retain the native converter's
order, and event sequence allocation never rewinds.

Every original v1 message and part is also retained byte-for-byte in the target's
`openwork_v1_message` and `openwork_v1_part` archive tables, keyed by the snapshot's
SHA-256. Original session fields are retained in `openwork_v1_session`. This
preserves fields and older part types that the native v2 projection does not
represent. The archive is not a promise that v2 renders unsupported legacy items.
Source rows and projected message identities are verified before completion.
Only then is the staging workspace removed. Existing v2 history is backed up
before the transfer, and the two most recent backups remain on disk.

The saved snapshot time remains the migration cutoff after restart: chats
created in v1 after that snapshot still need a later copy. Completion/error
receipts remain visible after restart. The copy stays local to this profile;
it neither imports remote-server history nor merges later edits automatically.

OpenCode's conversion still resets session permissions and revert state and
normalizes interrupted activity. Review permissions before continuing migrated
chats. V1 plugin implementations require v2-compatible replacements; migration
does not rewrite configuration, skills, or plugin files.

## Provider catalog ownership

The optional `liveProviderSync` rollout gives the bundled OpenWork plugin
ownership of the v2 AI Gateway catalog. V1 and the flag-off path retain the
existing server materialization flow. See [live provider sync](live-provider-sync.md)
for stream convergence, account isolation, credential hand-off and kill-switch
semantics.

## Upstream contract reviewed

Implementation was checked against the native engine at the repository pin,
`2.0.26`, and its upstream source commit
`9b4ec5714d481559990db0a816d5dec19541a814`:

- [Native migration](https://github.com/anomalyco/opencode/blob/9b4ec5714d481559990db0a816d5dec19541a814/packages/core/src/database/v1-migration.bun.ts)
- [Migration status API](https://github.com/anomalyco/opencode/blob/9b4ec5714d481559990db0a816d5dec19541a814/packages/protocol/src/groups/migration.ts)
- [Native session transfer](https://github.com/anomalyco/opencode/blob/9b4ec5714d481559990db0a816d5dec19541a814/packages/core/src/session/transfer.ts)
- [V1 compatibility guide](https://github.com/anomalyco/opencode/blob/9b4ec5714d481559990db0a816d5dec19541a814/services/www/src/docs/content/migrate-v1.mdx)

## Verification

`apps/server/test/opencode-v2-staged-history.test.ts` is an isolated integration
test against the pinned real engine. It creates a 260 MiB single tool output,
Unicode text, base64 and percent-encoded files, and multiple transfer batches.
It kills a worker after a committed batch, resumes from another process,
checks complete payloads and the original database digest, leaves existing v2
chats untouched, and opens the result through a fresh native engine. It also
checks graceful shutdown and automatic startup recovery. Without a binary it
explicitly skips.

```sh
OPENWORK_OPENCODE2_BIN="$(command -v opencode2)" pnpm --filter openwork-server test:history-migration
```

The same integration can be bundled and run on Node with a small V8 heap to
exercise the desktop database implementation. No production history, provider
credentials, external records, or inference are needed.

Design: P3 (details disclosure), P5 (existing ToggleGroup, Button, AlertDialog,
Dialog, Progress and Alert), P9 (migration data and risks), P10 (desktop
screenshots), P11 (no step labels; counts appear once they move), S2 (settings
rows), S6 (one owner for palette and settings), C1 (verb-first actions), C2
(Migrate → Migrated), C5 (running tasks are a warning, not an error), C6
(retryable errors).
