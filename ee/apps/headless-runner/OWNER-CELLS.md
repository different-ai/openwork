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
2. `celld deploy` from `ee/apps/headless-runner`, with the same `HEADLESS_*` settings the Node runner has, and
   `HEADLESS_FILES=s3`. Keep `wrangler.jsonc`'s `name` and class name: celld derives every cell's identity from
   them.
3. Point `DEN_HEADLESS_RUNNER_URL` (den-api) and `WORKBOT_RUNNER_URL` (Workbot) at it. Tokens stay the same.

**Hosts with temporary disks (Render, Fargate, most containers): set `CELLD_DURABILITY=bucket` on every node.**
celld's default (`fleet`) acknowledges a write once another node has it on its local disk, before it reaches the
bucket. If every node stops at once (for example, all lose their bucket leases during one storage outage) and their
disks do not survive, celld cannot prove no acknowledged write was lost and refuses to open the affected cells. That
is correct, but leaves conversations unavailable. On a host that also restarts a process at the same private IP,
recovery waits until those IPs change. `bucket` mode acknowledges only after the bucket write, so
any node can always recover. Keep `fleet` only with persistent disks for `CELLD_WATCH` and stable node identities.
Also consider `CELLD_TTL_MS=30000` so a short storage outage does not fence every node.

**Switching starts every conversation fresh**: conversations on the Node runner stay in its SQLite file and are not
copied. A Slack or Automation run in flight at the switch ends as `unknown_session`. Pointing the URLs back at the
Node runner (kept with its disk until you are sure) returns to the earlier conversations.

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
