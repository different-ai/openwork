# OpenCode engine selection and history

OpenWork keeps its existing v2 routing policy. Fresh profiles start on v2;
managed hosts automatically select v2 when the previous engine is idle, and the
`opencodeV2Only` organization policy still prevents switching back. Explicit
local support/test overrides and external-engine ownership remain respected.
The retired `engineV2ForceUpgrade` setting remains ignored.

## Upstream owns migration

OpenWork bundles vanilla OpenCode **2.2.6**, without a migration patch. It starts
the normal v2 server directly with `OPENCODE_DB` pointing at the selected history
database. Upstream converts v1 tables in place on startup, retains the original
v1 tables, and owns the `kv` / `migration.v1-v2` cursor and completion marker.
OpenWork does not reset those markers.

Removed: the custom child worker, immutable snapshots, payload externalization,
conversion workspace, cross-database transfer, copy/swap/restore and backup
rotation, disk-space preflight, copy mutex/fence and engine leases, copy startup
and connection gates, retry/resume jobs, and manual migration route/UI. There
is no migration progress dialog or “Migrate chats” command. Engine selection and
running-task switch confirmations remain.

The old preflight estimated **4 × source + target + 1 GiB**, not the amount
upstream needs for an in-place conversion. Its disk warning (including the
reported 10.2 GB requirement on v0.18.64) is gone. Upstream still needs working
disk space; real SQLite, conversion, executable and startup errors remain errors.
No free-space guarantee is implied.

## Existing installations: non-destructive selection

`apps/server/src/opencode-history.ts` selects a database before the engine starts:

| Existing state | Database opened by v2 |
| --- | --- |
| No separate OpenWork v2 database | Original v1 database; upstream migrates in place |
| Separate database is zero-byte or has an empty initialized schema | Original v1 database; empty separate file is left alone |
| Separate `<runtime>/opencode-v2/state/opencode.db` contains chats | Keep reading that database, including native v2 chats and already copied history |
| Old copy stopped after writing some chats | Keep reading the populated separate database; do not resume the custom copy or let its checkpoint block startup |
| Corrupt/unreadable separate database | Report the error, rather than silently hiding its history by selecting another store |

The chosen path is saved once as `historyDatabase` in the existing engine-state
file. This is only a database pointer, not a migration checkpoint: deleting the
last chat must not switch stores or resurrect old chats on the next boot. A
saved selection is not silently replaced by another database.

The original path honors `OPENCODE_DB`, an isolated v1 database selected by the
host after a collision, then XDG/HOME defaults. History stays profile-local.
Generated v2 configuration remains under the existing private v2 state directory;
changing the history path does not relocate configuration or provider credentials.

Old `history-copy.pending`, mutex/lease files, staging copies, backups, archive
and checkpoint tables are **ignored and preserved**, not deleted. Old automatic
copy markers and receipts no longer enter the runtime selection state. There is
no new cleanup worker, merge, database rewrite, process-signalling recovery, or
support-only startup unlock.

### Limits and risks

- A populated separate v2 database wins when history is split. V1-only chats
  that were never copied remain in the original database; unfinished copied
  chats may still be partial. Upstream cannot resume OpenWork's private copy
  checkpoints. The source, staging data and backups remain available for a
  separately reviewed recovery/export; this change does not silently merge or
  overwrite either history. Do not delete them to “fix” an upgrade.
- Stop old OpenWork instances before updating. This build never launches the old
  worker and does not signal unknown processes; it cannot safely arbitrate a
  worker from an older build still writing the same database.
- In-place adoption is one-way. The existing engine-switch fence drains incoming
  mutations, and the manual API checks v1 is idle before starting v2; “Switch
  anyway” is no longer offered for busy v1 tasks. Once the shared original store
  is adopted, v1 selection and host-forwarded v1 chat writes answer
  `409 engine_v1_history_adopted` (reads and Stop remain available). Settings show
  why v1 is unavailable. Separate, unconverted v1 stores keep their old switching
  behavior. This is an engine handoff safeguard, not a history copy lock.
  Retained v1 tables are recovery input, not live bidirectional sync: upstream
  never re-imports writes made after its completion marker. Automatic startup
  does not fall back to v1 after v2 may have converted the store. A standalone
  v1 process outside OpenWork is not controlled by this guard.
- Downgrading to a build that ignores `historyDatabase` can select its old separate
  store instead. Do not downgrade as an automatic recovery step; preserve both
  stores and use an explicitly reviewed recovery plan.
- Upstream conversion/startup errors are surfaced through normal engine status
  and restart handling. Test large histories and real low-disk behavior before
  release; removal of the false preflight is not a promise about upstream's peak
  disk or memory consumption.

## Verification

```sh
pnpm --filter openwork-server test:history-migration
bun test apps/server/test/engine-auto-upgrade.test.ts
bun test apps/server/test/engine-auto-upgrade-boot.test.ts
bun test apps/server/test/engine-v2-restart.test.ts
```

The history-selection tests cover original, empty, populated, split and partial
stores, WAL reads, upstream markers, stale artifacts and non-deletion. Startup
regressions cover stale custom state/fences with v2 directly serving history.
The automatic-engine proof uses a synthetic v1 chat and the real pinned engine
without provider credentials or production data.

For manual release verification, close older builds, launch with a disposable
v1 profile, verify its chat through v2, relaunch, then repeat with a populated
separate v2 database and stale copy artifacts. Confirm no migration UI, no
`/experimental/engine-v2-preview/migrate` route, no copy worker, and unchanged
v2-only routing. Never use production history as a test fixture.

## Upstream contract (v2.2.0)

- [Database path](https://github.com/anomalyco/opencode/blob/v2.2.0/packages/cli/src/database-path.ts)
- [In-place migration](https://github.com/anomalyco/opencode/blob/v2.2.0/packages/core/src/database/v1-migration.bun.ts)
- [V1 compatibility guide](https://opencode.ai/v2/docs/migrate-v1)

Provider catalog ownership, Connect health, config/skills and plugin API
compatibility are unchanged; see [live provider sync](live-provider-sync.md).
