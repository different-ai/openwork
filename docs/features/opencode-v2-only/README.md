# OpenCode v2 only (`opencodeV2Only`)

- **Feature key:** `opencodeV2Only`
- **Deployments:** cloud and self-hosted
- **Default:** off
- **Author:** benjaminshafii

## What a person gets

On a signed-in desktop whose organization has the rollout on:

- Every chat runs on OpenCode v2. If the desktop was still on OpenCode v1, it
  moves to v2 as soon as v1 has no running task (it never strands a running
  v1 turn; it waits and tries again on the next policy check).
- Switching to OpenCode v1 is turned off. The command palette and
  **Settings › Advanced › OpenCode engine** still show OpenCode v1, locked, with
  "Your organization runs every chat on OpenCode v2." The server refuses a v1
  switch with `409 engine_v2_only`.
- OpenCode v2 starts directly and upstream migrates the selected database in
  place. Existing populated separate v2 stores remain selected. There is no
  custom history copy, migration command, disk preflight or history lock.

This is the user-visible half of making OpenCode v2 the only engine. The v1
engine still ships and still backs provider sign-in on this release; removing
it is a separate change once this rollout is on everywhere.

## How it is resolved

The server reads the flag from the same verified `/v1/me/desktop-config`
response as `liveProviderSync` (`opencodeV2Only: true|false`). It is never
saved locally: signed out, an older Den without the field, or Den unreachable
all mean off. The renderer only reads the server's effective state
(`GET /experimental/engine-v2-preview/status` → `v2Only`).

## How to try it

1. In `/admin`, turn `opencodeV2Only` on for one organization.
2. Sign in to the desktop app as a member of that organization.
3. Within one provider-sync pass (on sign-in, then every interval) the status
   reports `v2Only: true`, chats route to v2, and the v1 option is locked.

## Turning it off (kill switch)

Turning it off only unlocks the v1 option. It does **not** move anyone back to
OpenCode v1 or change saved routing: the engine state
file keeps `enabled: true`, `chatRouting: true` and `engineOrigin: "forced"`,
which older desktop builds also read as "v2". People can switch engines
manually again afterwards.

## Safety guarantees it relies on (always on, not behind the flag)

- The engine state file always includes `enabled`, `chatRouting` and
  `engineOrigin`, so older builds keep selecting v2 after a downgrade. A state
  file written by the reverted v2-only build (no `enabled`) is read as v2.
- Stale copy fences, leases, staging files and receipts from older builds do
  not gate startup. They are preserved for recovery, not deleted or resumed.
- Split or partially copied histories are not merged. Existing v2 chats remain
  available; uncopied v1 data remains in its original database and backups.

See `docs/opencode-engine-migration.md` for the full lifecycle.

## What to watch

- Normal engine startup errors in `lastError`, including upstream conversion failures.
- Server warnings prefixed `OpenCode v2 only:` (for example waiting for v1
  tasks) in `lastWarning`.
- `409 engine_v2_only` responses mean something still tried to select v1.
