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

Build and run the same immutable artifact shipped in the Den API image:

```bash
pnpm --dir ee/packages/den-db build:migration-runtime
node ee/packages/den-db/dist/migration-runtime/runner.js
```

Check database compatibility and print the pending plan without acquiring a
lock or changing the database:

```bash
node ee/packages/den-db/dist/migration-runtime/runner.js --check
```

The runtime emits JSON Lines. Its stable failure exit codes are:

| Exit | Category |
| ---: | --- |
| `2` | Configuration invalid |
| `3` | Database unreachable |
| `4` | TLS verification failed |
| `5` | Database incompatible |
| `6` | Migration lock unavailable |
| `7` | Migration statement failed |
| `8` | Verification failed |
| `10` | Released migration artifact invalid |
| `130` / `143` | Process interrupted / terminated |
| `137` | Process killed by the runtime, commonly an OOM kill |

The runner uses `MIGRATION_LOCK_TIMEOUT_SECONDS` (default `30`) and a renewable
`MIGRATION_LOCK_LEASE_SECONDS` lease (default `300`). Completed runs are
idempotent: the immutable ledger is verified before any pending migration is
applied, required indexes are created idempotently, and the final schema is
verified against release metadata.

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
  the immutable runner (or `db:bootstrap`, which builds and invokes it). The
  release artifact contains a generated full-schema bootstrap, records the
  reviewed migration baseline, and then verifies the database. Use `db:push`
  only for development.
- `db:generate` is the default path for new migration files.
- `drizzle/meta/` must stay in sync with the SQL migration history so future generation stays incremental.
- Only repair `drizzle/meta/` manually when recovering broken Drizzle history.
