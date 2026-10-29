# The runner on celld

The same runner, the same HTTP API, URL and token, run by [celld](https://celld.dev) instead of `node dist/server.js`.
celld keeps each cell's SQLite in an S3-compatible bucket you own and moves cells between nodes, so the runner has
no disk and scales by adding nodes. Cloudflare is optional: the same `wrangler.jsonc` also runs on Workers.

```text
den-api (Slack, Automations) ─┐                          ┌─ cell "owner:wb:<person>"  Workbot: main chat, side
                              ├─ bearer token ─ router ──┤                             chats, shared memory, tasks
Workbot ── + owner header ────┘   (src/worker/index.ts)  └─ cell "session:hs_…"      one Slack/Automation chat
```

- **Workbot** sends `x-openwork-headless-owner` (derived from Den's answer about who is signed in, never from the
  browser). All of a person's chats live in one cell, so side chats' shared `memoryOf`, listing, tasks, Stop and
  live events work exactly as on Node. Deleting a chat removes only that chat.
- **Slack and Automations** send no owner and are unchanged: each conversation gets its own cell. Creating one
  picks the id in the router (`POST /v1/sessions` becomes `PUT /v1/sessions/<new id>` in that cell).
- The owner header can only be set by a caller holding the service token. A cell checks it was addressed by its own
  name, a body or query can't name another owner, and a conversation cell answers for its own conversation only.

`Store` and `Runner` are the Node runner's code; only `src/worker/` knows about cells. Saved files must use
`HEADLESS_FILES=s3` (or `off`): their bytes stay in the blob bucket, separate from celld's database bucket.

## Session cells: each Workbot chat in its own cell

Workbot connected to a current Den gives each new chat an id `hs_c_<32 hex>` and `memoryScope: "owner"`, and asks
the runner once per person to split their owner cell (`POST /v1/owner/split`). The owner cell keeps only the chat list,
the shared memory and forwarding rows, so each cell stays small however many chats a person has.

```text
                      ┌─ "owner:wb:<person>"  directory of chats in session cells, shared memory (owner_memory),
Workbot + owner ─ router                      legacy chats not yet split, forwarding rows for split ones
                      ├─ "session:hs_c_…"     one chat: its turns, tasks, files, live events; owner stored at creation
                      └─ "session:hs_wb_…"    a legacy chat after the split (same id), reached through the owner cell
```

- **Placement** (`src/worker/index.ts`): with the owner header, an id matching `^hs_c_[a-f0-9]{32}$` goes to
  `session:<id>`; any other id and every owner-level route (`GET /v1/sessions?owner=`, `POST /v1/owner/split`) go to
  the owner cell as before. Without an owner, an `hs_c_` id or `/v1/owner/*` answers `400 owner_required`.
- **A session cell checks its owner.** The request that creates the chat (`PUT`) stores the router-supplied owner in
  the cell (`cells_meta`); every later request must carry the same owner header, else `404 unknown_session` (another
  owner) or `400 owner_required` (none). The owner stays after a delete, so nobody else can take the id over. A moved
  legacy chat's cell has its owner stored by the split, and answers owner-less requests `404`.
- **Directory.** A session cell keeps its line in the owner cell (`title, ref, created_at, updated_at, has_turns,
  deleted`, versioned) with a call to the owner cell's `/internal/owner-directory`: synchronously when the chat is
  created or deleted, otherwise from a durable outbox (`directory_outbox`, background job `owner-directory`: retried
  immediately, then 30 s, 2 min, 10 min, hourly; reported after 5 failures in a row). A newer version always wins;
  a deleted chat leaves a tombstone. `GET /v1/sessions?owner=` merges legacy chats and directory rows, newest first,
  in the same shape as before; like legacy chats, only chats with a message are listed.
- **Shared memory.** `memoryScope: "owner"` (strict enum; needs an owner) puts the chat's `memory/` in the owner's
  memory (`owner_memory`), shared by all their chats. A session cell reads it from the owner cell
  (`/internal/memory`) once per turn (once per step in step mode), when it builds the system prompt, and writes through
  on each file tool call; the files API shows it too. If the owner cell doesn't answer (3 tries), the turn fails
  `memory_unavailable` (resend it) or, in step mode, the step runs again in 15 s; a file tool returns an error. The first
  time an owner's memory is used, the memory their legacy chats share becomes it (the chat most others name in
  `memoryOf`, Workbot's main chat, else the oldest chat with memory files): its files move to `owner_memory` and the
  chats sharing it switch to `memoryScope: "owner"`, in one transaction. A later `memoryOf` naming such a chat (Workbot
  with the flag off) means the owner's memory. `memoryOf` is unchanged for everything else, and on the Node host
  `memoryScope: "owner"` uses the same tables locally. The owner cell answers memory calls only from a session cell
  of a chat in its directory (not deleted) or moved out of it (a forwarding row); any other cell gets `404`. A chat
  whose directory entry is still in its outbox sends it on that `404` and asks once more.
- **Exports carry the owner's memory.** `GET /v1/sessions/:id/export` of a chat on the owner's memory includes
  `owner_memory` (each file with its `updated_at`); a Node import merges it into that owner's memory there, where
  Node's own memory access reads it: a file is written unless the owner already has a version at least as new, and
  nothing is deleted, so importing several of one person's chats keeps the newest of each file. Exports of other chats
  are unchanged.
- **Per chat, inside its cell:** live events (SSE and the hibernatable WebSocket), Stop, background tasks and reports,
  step mode, self-resume and sealing all run in the session cell, from its own alarm.
- **Delete** removes everything the session cell holds (the storage interface's delete) and its directory line.
- **Cell-to-cell calls** (`/internal/*`) carry the calling cell's name and an HMAC of both names keyed by the service
  token, and are answered only when both check out. The router answers every `/internal/*` path `404` and strips the
  call headers from public requests, so no caller reaches them.

### Splitting an owner cell

`POST /v1/owner/split` (owner header; idempotent) answers `{ split: "started" | "running" | "done" | "not_needed" }`
and starts the `owner-split` background job in the owner cell, which moves one legacy chat per alarm, most recently
used first:

1. Moves the shared memory to the owner's memory (above), if not done yet.
2. Skips a busy chat (a turn queued or running, a step scheduled, or a turn waiting to self-resume) and tries it again
   a minute later.
3. Copies every row of the chat to `session:<same id>` through `/internal/import/*`, in batches of about 2 MiB:
   `sessions` (with its Den index capability, index version and hot byte count) and every table keyed by
   `session_id` (turns with their resume grants, messages, files, saved files, step state, the segment manifest, the
   large-body map, `seal_state`), all but the pending Den index update (`index_outbox`, see 5). Then it commits there:
   the session cell checks a SHA-256 over the conversation's content and state equals the owner cell's, or throws the
   copy away. The fingerprint leaves out the storage engine's bookkeeping, which background work changes without
   changing the conversation: `sessions.hot_bytes`, `index_version`, `index_capability`, `seal_state`, the index outbox,
   pending object deletions and the directory outbox. Objects in the bucket (kept files, segments, large bodies) keep
   their keys (`sessions/<id>/…`) and are not copied: the session cell reads them where they are.
4. Then, synchronously, only if the chat is still not busy and its fingerprint unchanged: in one transaction, a
   forwarding row, its directory line and a handoff record go in, and the chat's rows (its `index_outbox` row too) and
   its pending object deletions (`storage_deletions` under `sessions/<id>/`) leave the owner cell (rows only, never
   objects). Otherwise the copy is thrown away and the chat is tried again. Live readers of the chat on the owner cell
   are ended (sockets close with 1012, SSE streams end) so they reconnect through the forward.
5. The handoff (`/internal/import/handoff`, retried with backoff until taken; the split is not `done` before): the
   owner cell's bookkeeping as it was at the move, read in that same transaction. The session cell raises the chat's
   index version to at least the owner cell's, keeps the newest capability, queues the pending object deletions
   (evaluated against its own references, so referenced objects stay), counts the hot bytes again and queues a fresh
   Den index snapshot numbered above everything the owner cell sent. From the commit until the handoff the session
   cell sends nothing to the Den index (`index_hold`), so no update from it is ever numbered below one the owner cell
   already sent. The chat keeps reporting under the same session id.
6. A crash at any point resumes from the alarm: either the chat is still in the owner cell (copied again, or finished
   from a copy the session cell confirmed with the same fingerprint) or it is forwarded. A session cell never
   overwrites a chat that lives there (`409 session_exists`; the owner cell reports `owner_split_blocked` and waits a
   day).

Forwarding keeps legacy ids working: the owner cell sends every request for a moved chat to its cell, WebSocket upgrades
included (the session cell's socket answer is passed back through the owner cell), and Workbot's usual `PUT` with
`memoryOf` keeps the chat on the owner's memory. An older router that sends an `hs_c_` id to the owner cell is forwarded
the same way. The public import route stays `405`; on the Node host `POST /v1/owner/split` answers
`{ split: "not_needed" }` and `hs_c_` ids are ordinary ids.

Verified on celld v0.6.2, v0.6.3 and wrangler (`owner-cells-e2e.ts`): a cell calling another cell's `fetch` from a
request and from its alarm (the split), the called cell calling back into the first while it waits (directory sync during
creation; celld lets an awaiting event overlap another), and returning another cell's WebSocket upgrade response from a
cell (the forwarded socket opens, gets `ready` and live events). celld refuses `PRAGMA table_info` on its own tables
(`_cf_…`, `_litestream_…`), so the split only describes the runner's tables. A forwarded socket stays open through
a celld version switch (`POST /reload`) and keeps receiving events. Not verified locally: a forwarded socket when the
owner cell moves to another node (celld closes WebSockets of a cell that moves; the client reconnects, as after any
close).

Session cells are generally available. Deploy a runner supporting session cells before GA Den. New chats use
`hs_c_` ids; existing chats retain their ids and move only through the lossless split with forwarding.
Workbot connected to older Dens still honors their optional `sessionCells` field (missing means false).

**Rollback rule: never roll back to a runner from before session cells.** It can't serve `hs_c_` chats or moved legacy
chats (an older owner cell has no forwarding rows and ignores owner memory), and it pages only the hot part of sealed
chats. If something goes wrong, roll forward with a fix. `HEADLESS_SEGMENTS=off` can prevent new seals and large bodies;
it is storage configuration, not a session-cell rollout switch. Already moved or sealed data stays readable.

## Deploy (replaces the Node runner)

1. Run celld ≥ 0.6.3 on at least two nodes sharing one bucket, behind one private address (see celld's docs for the
   bucket, TLS and peer network).
2. `celld deploy` a bundle (`tsx scripts/celld-bundle.ts <out> <vars.json>`), with the same `HEADLESS_*` settings the Node runner has, and
   `HEADLESS_FILES=s3`. Keep `wrangler.jsonc`'s `name` and class name: celld derives every cell's identity from
   them.
3. Point `DEN_HEADLESS_RUNNER_URL` (den-api) and `WORKBOT_RUNNER_URL` (Workbot) at it. Tokens stay the same.
4. For [self-resume](./README.md#self-resume), give the bundle `HEADLESS_DEN_API_URL`, `HEADLESS_DEN_CALLBACK_TOKEN` and
   `HEADLESS_GRANT_KEY`, all three or cells refuse to start: either in `CELLD_RUNNER_VARS`, or (production) as the
   `HEADLESS_DEN_API_URL` variable and the two secrets of the `celld-production` environment, which the deploy
   workflow merges only when all three are set. Without them turns wait for their
   callers after a crash or deploy, as before. With them each cell keeps a durable alarm while it has turns running or
   waiting to resume: after a node dies, the alarm wakes the cell on another node, startup recovery marks its turns
   interrupted, and the runner resumes them with fresh tokens from Den. A cell stores its own name (`cell` in its
   Durable Object storage) on its first request, so an alarm, which has no request, acts only for the cell it was set by.

**Keep the runner current.** Nodes only run what was last deployed to the bucket; they never build from the repo. In
production, `.github/workflows/celld-runner-deploy.yml` does it on every `dev` push that changes the runner or a
package bundled into it: a real turn on a throwaway prefix first, then the fleet, then it waits until every node
adopted the version. A Workbot or den-api change that needs a new runner field must not be turned on before that run
is green; older runners refuse unknown fields.

**Hosts with temporary disks (Render, Fargate, most containers): set `CELLD_DURABILITY=bucket` on every node.**
celld's default (`fleet`) acknowledges a write once another node has it on its local disk, before it reaches the
bucket. If every node stops at once (for example, all lose their bucket leases during one storage outage) and their
disks do not survive, celld cannot prove no acknowledged write was lost and refuses to open the affected cells. That
is correct, but leaves conversations unavailable. On a host that also restarts a process at the same private IP,
recovery waits until those IPs change. `bucket` mode acknowledges only after the bucket write, so
any node can always recover. Keep `fleet` only with persistent disks for `CELLD_WATCH` and stable node identities.
Also set `CELLD_TTL_MS=60000` so a short storage outage does not fence every node (below).

**Conversations only leave cells.** To move off celld, export each one and import it into a Node runner with the same
token, bucket and computer settings ([Move conversations to Node](./README.md#move-conversations-to-node)); cells answer
`405` to imports. Every deploy's preflight moves its smoke conversation into a Node runner, so that way stays open.
A run in flight at the switch ends as `unknown_session`, so pause traffic while moving. Keep celld-only code in
`src/worker/`: everything else runs on both hosts, which is what keeps the move cheap.

### Recommended production settings

Names and defaults are from [celld's docs](https://celld.dev/docs) (v0.6.3):

- `CELLD_DURABILITY=bucket` on hosts with temporary disks (above).
- `CELLD_TTL_MS=60000` (default 10000), so a short storage outage does not fence every node. A node fences once its
  lease goes unrenewed for this long, and every node renews against the same bucket, so they all fence together. On
  R2, most store outages that fenced the fleet with 30000 lasted 20–50 s. The cost: the cells of a node that dies
  without a handoff (SIGKILL, host loss) wait this long for another node; a SIGTERM hands them off at once.
- `CELLD_WATCH` on a fixed path that the start command empties before celld starts, with `CELLD_DURABILITY=bucket`
  only (every acknowledged write is then in the bucket). celld leaves the files of a process that was killed or
  fenced, and a host that restarts the process in place (Render) keeps its temporary disk; unset, celld uses a new
  `/tmp/celld-<pid>` each time.
- `CELLD_LOCAL_CACHE_MAX_BYTES` well under the temporary disk's limit (default 2 GiB; Render's `/tmp` is 2 GB). It
  bounds only idle cells' cached copies; resident cells keep one local LTX file per write until they leave memory.
- No bucket lifecycle rule that selects celld's reserved prefixes (`cells/`, `nodes/`, `log/` and the others in
  celld's guarantees). A lost `cells/<cell>/own.json` makes celld ≥ 0.6.3 refuse the cell; older nodes start it empty.
- `CELLD_LTX_RETENTION_SECS` set (for example a few days). Unset, celld never deletes old epochs and each cell's
  bucket data grows on every wake. Needs every node on ≥ 0.6.1 and a bucket with list-after-write consistency (R2
  and S3 have it).
- `CELLD_IDLE_EVICT_S` set, so idle cells leave memory. Unset, only memory pressure or the residency cap evicts them.
- `CELLD_DEPLOY_MAX_AGE_S` left at its default (60 s): how long a busy cell may stay on the old runner after a deploy
  before celld cancels its work.
- Platform shutdown grace above `CELLD_SHUTDOWN_TOTAL_MS` (default 40 s), or SIGKILL cuts the cell handoff.
- At least 2 nodes, for failover.
- A supervisor that always restarts, with no attempt limit: a node that loses its lease exits, and only a restart
  brings it back.
- A backup outside the live bucket. celld's replication copies bad writes and deletes too. On S3, use versioning plus
  replication to a second bucket (expire noncurrent versions, or epoch GC frees no space). R2 has no versioning: use
  dated snapshots in a second bucket ([Backups and restore](#backups-and-restore)).
- `HEADLESS_COMPUTER=off` until the computer is verified on celld (see [Check it](#check-it)).

## Step mode: turns that outlast a deploy

A turn sent with `execution: "steps"` ([README](./README.md#step-mode); current Den and Workbot send it for all new
turns) doesn't hold its cell busy. Admitting it writes its first step to the cell's
`step_schedule` table and sets the cell's alarm; it is not run under `waitUntil`. The cell keeps one alarm, at the
earliest of its due steps and the self-resume sweep. `alarm()` runs every due step to completion (one per lane, lanes
in parallel; a failure stays with its turn), then sets the alarm again. Between two alarms the cell is idle, which is
the safe point where celld moves it to a new deployment: nothing is cancelled. The new code's constructor finds the
turn in `step_schedule` (startup recovery leaves it running) and its next alarm runs the next step, with a fresh MCP
token from the turn's resume grant (memory doesn't survive the switch).

A step that is cut off anyway (a node dies, or a step outlasts `CELLD_DEPLOY_MAX_AGE_S`) runs again from the alarm,
continuing its streamed text where the provider allows and never re-running a tool call; one that keeps dying fails
its turn with `step_crash_loop` after 5 starts. Turns sent without `execution` keep running under `waitUntil` as
before.

## Backups and restore

`.github/workflows/celld-backup.yml` copies the whole bucket (celld cells under `fleet/`, kept files under
`sessions/`, not `ci/`) once a day into `s3://$CELLD_BACKUP_BUCKET/snapshots/<UTC time>/`, with a `_snapshot.json`
recording object counts. The backup bucket's lifecycle rule deletes snapshots after 15 days, which bounds how long a
deleted conversation survives in backups. Configure it on the `celld-backup` environment: secrets
`CELLD_BACKUP_R2_ACCESS_KEY_ID` / `CELLD_BACKUP_R2_SECRET_ACCESS_KEY` (an R2 token that reads the live bucket and
writes the backup bucket, nothing else) and variables `CELLD_BACKUP_BUCKET` / `CELLD_BACKUP_S3_ENDPOINT`.

A snapshot is copied from a running fleet, so it is consistent per object, not at one instant. To restore:

1. Stop every node (scale the service to 0) so no cell writes while the bucket changes.
2. Copy the chosen snapshot back over the live bucket's `fleet/` and `sessions/`
   (`aws s3 sync s3://<backup>/snapshots/<time>/fleet s3://<live>/fleet --delete`, same for `sessions`).
3. Start the nodes. Cells restore from the restored change chains; writes after the snapshot are lost.

Rehearse a restore into a throwaway bucket prefix before relying on it.

### A lost ownership record

Each cell's ownership record, `fleet/cells/<cell>/own.json`, must stay in the bucket for the life of the cell; celld
never deletes it. If it is gone while the cell's LTX remains, celld ≥ 0.6.3 refuses the cell (requests for it fail and
nodes log `celld ownership record lost`) instead of starting it with an empty database. The daily backup fails with
"celld ownership record lost" and lists such cells. Find what deleted the record (a lifecycle rule, a script) and stop
it first. Then restore each cell as celld's guarantees describe ("The ownership record"):

1. Stop every node that served the cell with SIGTERM (restart the service), never `POST /shutdown?handoff=preserve`.
2. Wait until each stopped process's node log is recovered: its `fleet/nodes/<node>.json` is gone, has no `log`
   object, or shows `"state": "sealed"`.
3. Write `{"node": "", "epoch": <N>}` to `fleet/cells/<cell>/own.json`, where `<N>` is the highest `e<N>` under
   `fleet/cells/<cell>/ltx/`. Within 10 seconds the next request acquires the cell and restores it from the bucket.

A record written before step 2 can lose acknowledged writes, and one written while a node still serves the cell makes a
second writer.

## Long conversations on celld

Sealed segments and large bodies (README "Sealed history and large outputs") live under `sessions/<id>/segments/` and
`sessions/<id>/bodies/` in the same bucket as kept files, so the daily backup covers them. Turning it on is a runner
setting with no org context: deploy first, then set `HEADLESS_SEGMENTS=on` (it needs `HEADLESS_FILES=s3`, which cells
require anyway). In production these are plain variables of the `celld-production` environment (`HEADLESS_SEGMENTS`,
and optionally `HEADLESS_HOT_LIMIT_BYTES`, `HEADLESS_SEGMENT_TARGET_BYTES`, `HEADLESS_LARGE_BODY_BYTES`), which the
deploy workflow merges over `CELLD_RUNNER_VARS`; change one, then run the workflow (a settings change is a new bundle,
so cells switch to it). Its log says `sealing: enabled` or `disabled`. Defaults keep a cell's hot SQLite under 32 MiB (`HEADLESS_HOT_LIMIT_BYTES`), well under the 80 MiB
past which a graceful handoff has no final snapshot and the 256 MiB past which a cell waking elsewhere pages its
restore. The sealer and orphan cleanup run from the cell's alarm, between steps; the newest 30 turns and whatever the
model's context reaches stay hot, so a turn never waits on the bucket for its context. Reads of sealed history fetch
one segment (cached in the cell briefly). `HEADLESS_SEGMENTS=off` stops new seals at once; reading what was sealed
keeps working. A rollback to a runner from before sealing opens the migrated database (migrations are additive) but
pages only the hot part: sealed turns reappear once the newer runner is back.

## Deleting a conversation on celld

Verified against celld v0.6.2 and v0.6.3 (`crates/celld/storage.rs` `authorize_sql`, `allowed_sql_pragma`;
`docs/guarantees.md` "Epoch GC"):

- **What the runner does**: overwrites the conversation's content in place with zero bytes (same length, so SQLite
  rewrites the same cells, overflow pages included), deletes its rows, and deletes its segments, large bodies and
  kept files from the bucket (immediate and verifiable; retried by `segment-orphans` if a delete fails).
- **What celld refuses**: `VACUUM` and `VACUUM INTO` (they need an internal `ATTACH`, which the authorizer denies),
  `PRAGMA secure_delete`, `wal_checkpoint`, `page_count` and every pragma but `table_info`/`table_list`-style reads and
  a few booleans. There is no API to start a fresh snapshot epoch: every activation (a wake on any node, or a takeover)
  starts one by itself. `deleteAll()` drops every table of the cell, so it suits deleting a whole session cell, not one
  chat in an owner cell.
- **What remains, and for how long**:
  - In the cell's local SQLite file: zeroed cells; copies of a row's earlier versions left in a page's free space by
    rewrites made before the delete (status updates, attachments stripped) until SQLite reuses that space. Keeping
    each chat in its own small session cell bounds this to that chat's cell.
  - In the celld bucket: LTX change files written before the scrub, in the cell's epoch prefixes
    (`cells/<cell>/ltx/e<epoch>/`). With `CELLD_LTX_RETENTION_SECS` set (3 days in production), epoch GC deletes a
    prefix once it is below the restore base, keeping the cell's current epoch, the one before it, and any epoch
    younger than the retention. So the old pages are gone once the cell has been activated at least twice since the
    delete (a new epoch each time) and 3 days have passed; a cell that stays resident keeps its current epoch, and
    with it those pages, until it next moves or wakes. Without `CELLD_LTX_RETENTION_SECS`, celld never deletes them.
  - In backups: the daily snapshot copies, deleted after 15 days by the backup bucket's lifecycle rule. Bucket object
    versioning, if on, keeps deleted objects until its own expiry rule.
- **Deleting everything of a person** deletes their session cells and owner cell; the same bounds apply per cell.

## Deploying the runner

`.github/workflows/celld-runner-deploy.yml` runs on every `dev` push that changes the runner or a package bundled
into it, and on demand (Actions → "Deploy runner to celld" → Run workflow). Each run:

1. **Builds the computer snapshot when the desktop changed.** The runner accepts only computers whose desktop matches
   its own, so when the configured Freestyle snapshot was built for another desktop, the run builds
   `workbot-desktop-freestyle-<desktop>` with the runner's `FREESTYLE_API_KEY` and bundles the runner with it. A
   snapshot that already exists is reused. A failed build stops the run before the fleet changes.
2. **Checks the live runner and the new one can serve each other** (`scripts/compat-check.ts`, below).
3. Deploys to a throwaway bucket prefix and runs a real turn there.
4. Deploys to the fleet and waits until every Render instance logs `deployment_adopted` for the new version. The
   version is a content hash, so an unchanged bundle is reported as `unchanged` and nothing switches.
5. Records which commit produced the live version in `s3://openwork-celld/ci/fleet-deployed.json` (outside the
   fleet prefix; celld never reads it), for the next run's check.
6. Posts the outcome to Slack, when `CELLD_DEPLOY_SLACK_WEBHOOK_URL` is set: deployed / unchanged / failed, the
   version and the one before it, the commit and run, and how many nodes adopted it. Cells switched and cells
   force-cancelled are not counted yet: celld 0.6.3 logs no line for a forced switch.

**To set up (repository admins, in Settings → Environments → `celld-production`; not in code):**

- **Required reviewers**: add the people or team who approve runner deploys, and tick "Prevent self-review". Every
  run then waits for "Review deployments" before any step runs. Keep `CELLD_R2_ACCESS_KEY_ID`,
  `CELLD_R2_SECRET_ACCESS_KEY`, `CELLD_RUNNER_VARS` and `RENDER_API_KEY` as secrets of this environment (not
  repository secrets), so nothing reaches them without that approval.
- **`CELLD_DEPLOY_SLACK_WEBHOOK_URL`** (optional): an environment secret holding a Slack incoming-webhook URL for the
  channel that should hear about deploys. Without it the run posts nothing.
- **`HEADLESS_COMPUTER_SNAPSHOT`** (optional): a plain environment variable holding a Freestyle desktop snapshot
  slug. It overrides this field in `CELLD_RUNNER_VARS`; when unset, the JSON value remains in effect. Either way, a
  slug named by the builder for another desktop is replaced by the one the run builds, so routine desktop changes
  need neither.

**Keep the default model authorized.** `CELLD_RUNNER_VARS` carries a provider route, key, model alias and protocol as
one configuration. Before replacing a retired alias, list `/models` on the intended route with that same key and
use its exact returned id; an alias from another route is not authorization. GPT-6.1 Sol needs `openai-responses`.
A smoke `model_http_403` is a model-access failure, not the expected unauthenticated `401` assertion. The smoke logs
only a recognized terminal error code and whether the answer matched, never provider details or answer content.
Repair the environment configuration; never bypass the real turn or compatibility check to deploy it.

**Batch runner deploys.** Every switch cancels the turns of busy cells after `CELLD_DEPLOY_MAX_AGE_S` (60 s), so
fewer deploys means fewer interrupted people. Turns in [step mode](#step-mode-turns-that-outlast-a-deploy) are not
cancelled: their cell switches between two steps. Keep the `dev` push trigger (the runner must not fall behind Workbot
and den-api), and batch through the approval instead:

- Don't approve each run as it arrives. A run bundles the whole runner at its commit, so approving the newest one
  ships every change before it. Reject the older waiting runs.
- GitHub keeps one run of this workflow in progress and at most one pending; a newer push replaces the pending one.
- Approve at a quiet time of day, and as soon as a fix or a field a caller needs is waiting (next point).

**Turn caller changes on only after the runner that accepts them is live.** Render deploys Workbot and den-api from
the same push, usually before this workflow finishes, and older runners refuse unknown fields: session and turn bodies
are `.strict()` (`src/app.ts`), so a new field is a `400` from every node that hasn't switched. So:

1. Add the field to the runner first (optional, so old callers keep working).
2. Put the Workbot or den-api code that sends it behind a feature flag, off: declare it in
   `packages/features/src/registry.ts` and follow `.opencode/skills/add-a-feature`.
3. Turn the flag on from `/admin` only after this workflow's run for that runner change is green (Slack says
   `deployed` with every node adopted).

Removing a field goes the other way: stop sending it, then remove it from the runner.

**Adjacent versions must accept each other.** During a switch some cells run the new code while others, and the
router in front of them, still run the old one; celld forwards between them. A cell that switched also opens the
SQLite the older code wrote. `scripts/compat-check.ts` builds mixed bundles from the two commits and runs real turns
(mock model, a file tool, owner and owner-less conversations, listing, delete, idempotent re-send) on a local
runtime, in three set-ups: old router → new cell, new router → old cell, and conversations written by the old version
opened and continued by the new one. It also fails if `wrangler.jsonc` renames the script or the cell class.

- In CI it compares with the commit behind the live fleet version (from `fleet-deployed.json`), else the previous
  push. A real incompatibility stops the deploy before the fleet is touched. An old commit that can't be fetched, or
  doesn't bundle with today's packages, is a warning and the deploy goes on.
- Only the runner's `src/` and `wrangler.jsonc` come from the old commit; packages bundled into it (hono, zod,
  `@openwork-ee/headless-computer`, …) are the installed ones.
- When a break is intended (for example the first deploy after a cell-format change you have planned for), run the
  workflow by hand with "skip_compat_check". `compat_base` picks another commit to compare with.
- Locally, from `ee/apps/headless-runner` (it takes under a minute):

  ```sh
  pnpm --filter "@openwork-ee/headless-runner^..." --if-present run build    # the packages bundled into the runner
  pnpm exec tsx scripts/compat-check.ts --base origin/dev                     # celld on PATH, or CELLD_BIN=…
  pnpm exec tsx scripts/compat-check.ts --base origin/dev --runtime wrangler  # Cloudflare's local runtime
  ```

## Check it

```sh
pnpm --filter @openwork-ee/headless-runner worker:typecheck
pnpm --filter @openwork-ee/headless-runner test:sql-store
pnpm --filter @openwork-ee/headless-runner worker:e2e                                # Cloudflare's local runtime
CELLD_BIN=/path/to/celld pnpm --filter @openwork-ee/headless-runner worker:e2e:celld  # celld
```

`owner-cells-e2e.ts` boots the real runtime with a streaming mock model and checks: Workbot owner routing and
isolation between people; side chats sharing memory and listing; owner-less conversations; **Den's own Slack adapter**
(`headlessRemoteCall`: create, send, read to the answer, stop, unknown session); idempotent re-sends; and killing
the runtime mid-turn, then interrupted-turn recovery and resume with nothing lost, and a turn sent with a resume grant
completing after the kill with no caller re-send (its alarm, a fake Den exchange, and the runner's own resume).

Session cells: `hs_c_` placement and owner checks (another owner `404`, none `400`, `/internal/*` not public), memory
shared through the owner cell, listing merged with the directory, a step-mode turn, live events and Stop in a session
cell, delete, and an owner split killed mid-copy that resumes from the alarm, moves every legacy chat byte for byte
(their exports compared) and keeps their ids working, a forwarded WebSocket included (`scripts/session-cells.test.ts`
covers every crash point, busy chats and chats changed mid-copy).

It also sends a step-mode turn of six slow model calls and switches the runtime to new code during it. On celld,
`POST /reload` on the internal listener (printed with `celld dev --logs`) rebuilds the deployment and adopts it as a
new generation in place, the same switch a `celld deploy` makes; the check reads `GET /state` until every resident
cell runs the new generation. It must switch well inside the 60 s a forced switch waits, before the turn's last step,
and every step's model call must have been made exactly once (a forced switch would cancel a step, which then calls
the model again). On wrangler, rewriting the bundle makes `wrangler dev` reload, which cancels what runs, as a Cloudflare
deploy does; the turn still completes, with at most the cut-off step run again. Both check every step's file and the
answer.

Not covered locally: celld's multi-node failover and bucket durability (celld's own guarantees; check them on the
real fleet before pointing production at it), and the Freestyle/Daytona computer inside celld, which bundles but
has not run there. If the computer misbehaves, keep `HEADLESS_COMPUTER=off` on the celld deployment.
