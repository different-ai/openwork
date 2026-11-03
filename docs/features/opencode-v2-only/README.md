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
- Chats saved by OpenCode v1 are copied into v2 in the background after v2 is
  selected. The copy never holds v2's own history back: a copy that cannot run
  (not enough disk, another window's engine, a running task) is refused before
  v2 stops, backs off, and leaves v2 serving. **Migrate chats to OpenCode v2**
  stays available as "try again". Until a v1 chat is copied, opening it in v2
  explains that it has not been copied yet.

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
OpenCode v1, stop or roll back a copy, or change saved routing: the engine state
file keeps `enabled: true`, `chatRouting: true` and `engineOrigin: "forced"`,
which older desktop builds also read as "v2". People can switch engines
manually again afterwards.

## Safety guarantees it relies on (always on, not behind the flag)

- The engine state file always includes `enabled`, `chatRouting` and
  `engineOrigin`, so older builds keep selecting v2 after a downgrade. A state
  file written by the reverted v2-only build (no `enabled`) is read as v2.
- A history copy publishes its `history-copy.pending` fence only immediately
  before it writes the v2 database, after every refusal check (other copies,
  engines, disk). A failed copy undoes only the chats it left half-written and
  lifts its fence; only a pause (closing OpenWork) or a crash keeps it for resume.
- An engine start that finds a fence from a copy that is no longer running
  lifts it when no chat is half-written, and otherwise resumes that copy (or
  undoes its unfinished chats) before opening v2.
- An engine left running by an OpenWork that exited is stopped only when the
  copy needs exclusive access and the process is positively identified as that
  lease's `opencode serve` started before its lease. Engines owned by a running
  OpenWork (including another installed app sharing the history) are never
  stopped, and a reused pid is never signalled.

See `docs/opencode-engine-migration.md` for the full lifecycle.

## What to watch

- Engine status `migration.state: "error"` with `migration.error` (disk,
  another engine, running tasks) and `autoUpgradeRetry` backoff in
  `engine-v2-preview.json`.
- Server warnings prefixed `OpenCode v2 only:` (for example waiting for v1
  tasks) in `lastWarning`.
- `409 engine_v2_only` responses mean something still tried to select v1.
