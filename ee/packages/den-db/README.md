# den-db

`@openwork-ee/den-db` owns the Den database schema and migration history.

## Canonical workflow

- Keep schema changes in `src/schema/**`.
- Keep generated SQL migrations in `drizzle/`.
- Always generate new migrations with Drizzle from this package.
- Do not create migrations from `den-api`, `den-controller`, or other apps.

## Install or upgrade Den

| Database and starting state | What to run | What happens |
| --- | --- | --- |
| Local MySQL | Run `pnpm dev:web-local`. To inspect first, set a loopback `DATABASE_URL` and run `pnpm --dir ee/packages/den-db db:migrate:local --check`. | On first startup, the runner replays from the historical foundation. On upgrade, it checks the schema and journal before applying pending SQL. It runs repairs and verifies the final schema and receipts before services start. Stop other connections before applying. See [local startup safety](#local-startup-safety). |
| Hosted PlanetScale | The [Den DB Migrate workflow](../../../.github/workflows/den-db-migrate.yml) runs on selected pushes to `dev`, on a schedule, or by manual dispatch. | On the existing production branch it opens a DDL window for pending migrations, runs `db:migrate`, and restores safe migrations. Check the workflow result for confirmation that safe migrations were re-enabled. |
| Self-hosted Den, empty database | Run the release image's migration job before starting Den. It executes `node /app/ee/packages/den-db/dist/scripts/bootstrap.js`. | Bootstrap installs the image's current-schema snapshot and records the bundled migration history as its baseline. The historical chain starts by altering existing tables. |
| Self-hosted Den, existing database | Run the same migration job from the **new** release before rolling out its services. For a pending 0097, follow the [0097 upgrade preconditions](#production-0097-upgrade-preconditions) first. | Bootstrap checks recorded history and applies pending migrations. An existing schema without a journal or with an unknown history needs deliberate recovery. Inspect an interrupted migration before retrying. |

Hosted `db:migrate` applies journaled SQL, runs schema repairs, then reconciles
default permission sets. The workflow also runs reconciliation separately so
permission catalog changes take effect even when there is no pending migration.

The self-hosted job runs schema repairs and attempts permission reconciliation
on fresh installs as well as upgrades. Reconciliation fills missing default
Member and Admin permission rows and is idempotent. Bootstrap logs a
reconciliation failure and continues. If it reports one, correct the cause and
rerun `pnpm --dir ee/packages/den-db db:reconcile-permissions` with the same
database configuration from a source checkout. The local migration runner
handles schema and receipts only.

## Development commands

- Generate SQL after a schema edit with `pnpm --dir ee/packages/den-db db:generate`.
- Apply the guarded local upgrade directly with `pnpm --dir ee/packages/den-db db:migrate:local` and a loopback `DATABASE_URL`.
- Use `pnpm --dir ee/packages/den-db db:push` only on a disposable development database. Direct schema pushes do not record the migration history used by upgrades.
- To run self-hosted bootstrap from a source checkout, build the workspace dependencies with `pnpm --filter '@openwork-ee/den-db^...' --if-present run build`, then run `pnpm --dir ee/packages/den-db db:bootstrap` against the intended database.

## Verify installs and upgrades locally

The [MySQL fixture](test/migration-preserved-tables.mysql.test.ts) uses Linux
MySQL 8.4 with case-sensitive table names (`lower_case_table_names=0`).
Set `OPENWORK_MIGRATION_TEST_MYSQL_URL` to a disposable loopback MySQL URL
whose database name begins with `exp_`. The fixture account needs permission
to create and drop temporary databases on that server. The test skips if the
variable is absent.

Run from the repository root with workspace dependencies installed.

```sh
pnpm --filter '@openwork-ee/den-db...' --if-present run build
pnpm --dir ee/packages/den-db exec node --conditions=development --import tsx --test test/migration-preserved-tables.mysql.test.ts
```

Historical replay preserves the legacy dashboard and access-grant tables.
A fresh install from the packaged snapshot omits both. The fixture checks
both fresh layouts. For upgrades it seeds a dashboard and its access grant
at migration 0147, runs the local and packaged upgrade paths on separate
databases, and checks the rows and ordered migration receipts again at restart.

## Production 0097 upgrade preconditions

For an existing database with canonical 0097 still pending, use the compiled
`bootstrap.js` entrypoint above, not the raw `db:migrate` command. Bootstrap runs
ordinary predecessors through 0096 with Drizzle, then executes the hash-pinned
0097 compatibility path, preserving the eight existing `PRIMARY(id)` keys. It
verifies the affected source and target definitions and empty tables before
recording the original 0097 hash/timestamp. Shipped SQL and history are unchanged.

Before approving this upgrade, take and verify a restorable backup, and externally
stop and drain **all application/gateway writers, callbacks, cron jobs and competing
deploy jobs**. Keep them isolated until migration completion has been verified.
Only then acknowledge those operational actions for this migration process:

```bash
DEN_DB_0097_WRITERS_STOPPED=1 node /app/ee/packages/den-db/dist/scripts/bootstrap.js
```

Only the exact environment value `1` is accepted. **This acknowledgement does not
freeze or stop writers.** The advisory lock coordinates compatible migration
runners only. A visible-active-session check can reject competing work, but cannot
exclude sleeping connections, sessions hidden by privileges, or later arrivals.
External isolation remains required regardless of the check's result.

For Helm, the narrow boolean `migrations.writersStoppedFor0097` defaults to `false`.
After the external actions above, the reviewed deployment may set it temporarily:

```bash
helm upgrade openwork-ee ./packaging/helm/openwork-ee -f values.prod.yaml \
  --set migrations.writersStoppedFor0097=true
```

This emits only `DEN_DB_0097_WRITERS_STOPPED=1` in the migration Job, without
changing database, encryption or managed-secret settings. Helm retains supplied
values, so explicitly restore `migrations.writersStoppedFor0097=false` in subsequent
deployments and do not store a permanent acknowledgement in production values.
Old reused values with this field absent remain unacknowledged. Empty current
snapshot installs and already-receipted canonical 0097+ do not require the flag.

Pending compatibility also requires session `default_storage_engine=InnoDB`,
advisory-lock support, writable temporary storage for predecessor staging, and
verifiable direct global or exact database-wide `SELECT`, `SHOW VIEW`, `TRIGGER`
and `REFERENCES` grants. Role-only/table-level grants and partial revocations are
refused rather than treating incomplete metadata visibility as proof of absence.
Affected table/column collations must match the database defaults. The runner does
not change engine settings, PK requirements, grants, encryption or TLS.

History must be the exact canonical hash/timestamp prefix; the only exceptions
are released bodies listed in `scripts/superseded-migrations.ts`. Unknown, superseded,
unjournaled, nonempty intermediate or partial-0097 states require separately
reviewed recovery; bootstrap does not repair, replay partial DDL, or baseline them.
A failed or uncertain completion must be inspected before any restart. For callers
of the exported core function, pass the fifth argument
`{ writersStoppedFor0097: true }` only after the same external actions; its default
is unacknowledged and it never reads process environment itself.

## Local startup safety

`pnpm dev:web-local` runs guarded loopback-only migrations before application
services start. `db:migrate:local --check` reports the plan without writes and
permits active connections for inspection; apply requires them to be stopped.
An unjournaled 0096 schema may be repaired only when its remaining differences
are missing non-unique prefix indexes `account_account_id_provider_id`,
`oauth_access_token_token`, and/or `oauth_refresh_token_token`. Definitions are
checked against 0096 and the individual CREATE INDEX statements in 0046/0073.
Data guards run first; a durable interruption marker precedes index creation.
Exact schema reinspection must succeed before recording the 0096 baseline and
running 0097. This never replays 0073's email rewrite or baselines Gateway tables.
Any differently defined index, other unknown drift, or interruption marker stops
startup for deliberate recovery; do not clear the marker to force a retry.

Consolidated 0097 assumes the eight intermediate inference tables introduced in
the same PR are empty, as confirmed by the operator, so no backfills are needed.
The local runner pins the generated SQL hash and rejects nonempty sources before
writes. A verified 0095 baseline skips only its absent rollup lock, then checks
all eight sources after 0096. Old 0097/0098/0099 receipts or partial schemas require
explicit recovery, never automatic stamping. These local checks are not production
rollout approval; production uses the guarded bootstrap path and operational
preconditions above. See [0097 notes](drizzle/0097_gateway_access_matrix.md).

## Automated migrations (CI)

Two GitHub Actions workflows keep schema and database in sync:

- `.github/workflows/den-db-check.yml` — on every PR touching this package,
  runs `db:generate` and fails if the schema changed without a committed
  migration.
- `.github/workflows/den-db-migrate.yml` — applies migrations to the
  production PlanetScale database when migration files land on `dev`
  (and via manual `workflow_dispatch`).

The migrate workflow reads these repository secrets (same names as the
local env vars — see `.env.example`):

| Secret | Value |
| --- | --- |
| `DATABASE_HOST` | PlanetScale host (e.g. `aws.connect.psdb.cloud`) |
| `DATABASE_USERNAME` | PlanetScale branch password username |
| `DATABASE_PASSWORD` | PlanetScale branch password |

### Read replicas

`createDenDb` always returns `db` wrapped in Drizzle's
[`withReplicas`](https://orm.drizzle.team/docs/read-replicas). Reads
(`select`, `selectDistinct`, `$count`, `with`, `query`) go to the replica;
writes, `execute` and transactions go to the primary.

Den API and the Gateway read optional `DATABASE_READ_USERNAME` and
`DATABASE_READ_PASSWORD`: replica credentials for the same host as the primary
(`DATABASE_HOST`, or the host in `DATABASE_URL`). Without both, the replica *is*
the primary, so self-hosted and single-credential deployments behave as before.

Replicas can lag the primary slightly. A read that must see a write made
moments earlier should use `db.$primary.select()...`; Better Auth's adapter is
pinned to `db.$primary` for this reason. Migration and maintenance scripts
don't pass replica credentials and always use the primary.

### One-time baseline

This is not a recovery path for pending or partial 0097. Do not use baselining to
bypass bootstrap's canonical history or schema checks.

A database previously managed with `db:push` has no `__drizzle_migrations`
table, so the first `db:migrate` would try to replay every migration.
Record the existing history once (marks migrations as applied without
executing them):

```bash
pnpm --dir ee/packages/den-db db:baseline           # dry run
pnpm --dir ee/packages/den-db db:baseline -- --yes  # record
```

Or run the `Den DB Migrate` workflow manually with `baseline: true`
(use `dry_run: true` first to see the plan).

### Migration policy

Migrations run **before** new code deploys, so they must be
expand/contract safe: additive columns are nullable or defaulted, no
renames or drops while old code still reads the schema, contract steps
ship as a later migration once no deployed code references the old shape.

## Notes

- The migration chain has no `0000` baseline (history starts at `0001`,
  which alters pre-existing tables), so empty production databases should use
  `db:bootstrap`. It applies the build-time current-schema SQL snapshot once,
  records the migration baseline, then runs pending migrations with Drizzle ORM.
  Use `db:push` only for development.
- `db:generate` is the default path for new migration files.
- `drizzle/meta/` must stay in sync with the SQL migration history so future generation stays incremental.
- Only repair `drizzle/meta/` manually when recovering broken Drizzle history.
