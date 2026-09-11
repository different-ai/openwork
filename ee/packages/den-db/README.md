# den-db

`@openwork-ee/den-db` owns the Den database schema and migration history.

## Canonical workflow

- Keep schema changes in `src/schema/**`.
- Keep generated SQL migrations in `drizzle/`.
- Always generate new migrations with Drizzle from this package.
- Do not create migrations from `den-api`, `den-controller`, or other apps.

## Commands

Generate a migration after editing the schema:

```bash
pnpm --dir ee/packages/den-db db:generate
```

Apply schema directly to a development database:

```bash
pnpm --dir ee/packages/den-db db:push
```

Run Drizzle migrations against a configured database:

```bash
pnpm --dir ee/packages/den-db db:migrate
```

Install or upgrade a production database, including empty first installs:

```bash
pnpm --dir ee/packages/den-db db:bootstrap
```

Containerized production installs run the precompiled artifact directly:

```bash
node /app/ee/packages/den-db/dist/scripts/bootstrap.js
```

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
explicit recovery, never automatic stamping. This is not production rollout
approval: the production transaction runner and generated primary-key drop/add
compatibility remain unresolved. See [0097 notes](drizzle/0097_gateway_access_matrix.md).

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

### One-time baseline

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
