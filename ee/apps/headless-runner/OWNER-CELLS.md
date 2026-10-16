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

## Deploy (replaces the Node runner)

1. Run celld ≥ 0.6.2 on at least two nodes sharing one bucket, behind one private address (see celld's docs for the
   bucket, TLS and peer network).
2. `celld deploy` a bundle (`tsx scripts/celld-bundle.ts <out> <vars.json>`), with the same `HEADLESS_*` settings the Node runner has, and
   `HEADLESS_FILES=s3`. Keep `wrangler.jsonc`'s `name` and class name: celld derives every cell's identity from
   them.
3. Point `DEN_HEADLESS_RUNNER_URL` (den-api) and `WORKBOT_RUNNER_URL` (Workbot) at it. Tokens stay the same.

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
Also consider `CELLD_TTL_MS=30000` so a short storage outage does not fence every node.

**Conversations only leave cells.** To move off celld, export each one and import it into a Node runner with the same
token, bucket and computer settings ([Move conversations to Node](./README.md#move-conversations-to-node)); cells answer
`405` to imports. Every deploy's preflight moves its smoke conversation into a Node runner, so that way stays open.
A run in flight at the switch ends as `unknown_session`, so pause traffic while moving. Keep celld-only code in
`src/worker/`: everything else runs on both hosts, which is what keeps the move cheap.

### Recommended production settings

Names and defaults are from [celld's docs](https://celld.dev/docs) (v0.6.2):

- `CELLD_DURABILITY=bucket` on hosts with temporary disks (above).
- `CELLD_TTL_MS=30000` (default 10000), so a short storage outage does not fence every node.
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
- Versioning on the celld bucket and the files bucket, replicated to a second bucket. Replication alone copies bad
  writes and deletes; versioning keeps the earlier copies. Expire noncurrent versions after a while, or epoch GC frees
  no space.
- `HEADLESS_COMPUTER=off` until the computer is verified on celld (see [Check it](#check-it)).

## Deploying the runner

`.github/workflows/celld-runner-deploy.yml` runs on every `dev` push that changes the runner or a package bundled
into it, and on demand (Actions → "Deploy runner to celld" → Run workflow). Each run:

1. **Checks the live runner and the new one can serve each other** (`scripts/compat-check.ts`, below).
2. Deploys to a throwaway bucket prefix and runs a real turn there.
3. Deploys to the fleet and waits until every Render instance logs `deployment_adopted` for the new version. The
   version is a content hash, so an unchanged bundle is reported as `unchanged` and nothing switches.
4. Records which commit produced the live version in `s3://openwork-celld/ci/fleet-deployed.json` (outside the
   fleet prefix; celld never reads it), for the next run's check.
5. Posts the outcome to Slack, when `CELLD_DEPLOY_SLACK_WEBHOOK_URL` is set: deployed / unchanged / failed, the
   version and the one before it, the commit and run, and how many nodes adopted it. Cells switched and cells
   force-cancelled are not counted yet: celld 0.6.2 logs no line for a forced switch.

**To set up (repository admins, in Settings → Environments → `celld-production`; not in code):**

- **Required reviewers**: add the people or team who approve runner deploys, and tick "Prevent self-review". Every
  run then waits for "Review deployments" before any step runs. Keep `CELLD_R2_ACCESS_KEY_ID`,
  `CELLD_R2_SECRET_ACCESS_KEY`, `CELLD_RUNNER_VARS` and `RENDER_API_KEY` as secrets of this environment (not
  repository secrets), so nothing reaches them without that approval.
- **`CELLD_DEPLOY_SLACK_WEBHOOK_URL`** (optional): an environment secret holding a Slack incoming-webhook URL for the
  channel that should hear about deploys. Without it the run posts nothing.

**Batch runner deploys.** Every switch cancels the turns of busy cells after `CELLD_DEPLOY_MAX_AGE_S` (60 s), so
fewer deploys means fewer interrupted people. Keep the `dev` push trigger (the runner must not fall behind Workbot
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
the runtime mid-turn, then interrupted-turn recovery and resume with nothing lost.

Not covered locally: celld's multi-node failover and bucket durability (celld's own guarantees; check them on the
real fleet before pointing production at it), and the Freestyle/Daytona computer inside celld, which bundles but
has not run there. If the computer misbehaves, keep `HEADLESS_COMPUTER=off` on the celld deployment.
