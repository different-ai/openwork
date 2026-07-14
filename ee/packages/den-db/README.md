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
executing them). With no `--through` argument, this intentionally stops at
`0037_futuristic_sage`. Before recording anything, the command fingerprints
the live tables, columns, defaults, primary/unique keys, and indexes against
the committed 0037 snapshot. It fails closed when the database is older or
partially applied. `db:migrate` then inspects, repairs, and records the
non-idempotent 0038 migration statement-by-statement:

```bash
pnpm --dir ee/packages/den-db db:baseline           # dry run
pnpm --dir ee/packages/den-db db:baseline -- --yes  # record
```

Use `--through latest` only when the current schema was just applied to an
empty database (the bootstrap command does this automatically). The command
also verifies the matching latest snapshot before it writes the ledger.

Or run the `Den DB Migrate` workflow manually with `baseline: true`
(use `dry_run: true` first to see the plan).

### Migration policy

Migrations run **before** new code deploys, so they must be
expand/contract safe: additive columns are nullable or defaulted, no
renames or drops while old code still reads the schema, contract steps
ship as a later migration once no deployed code references the old shape.
For hosted deployments, make successful completion of `Den DB Migrate` a
pre-deploy gate; do not let an API rollout race the independent workflow.

## Notes

- The migration chain has no `0000` baseline (history starts at `0001`,
  which alters pre-existing tables), so empty production databases should use
  `db:bootstrap`. Before its first state push it writes a zero-timestamp marker
  into Drizzle's ignored migration ledger. A retry can therefore distinguish
  and resume an interrupted fresh push, verify the latest snapshot, finish the
  baseline, and clear the marker. A non-empty no-ledger database is adopted
  through 0037 only after the complete 0037 snapshot fingerprint passes; it is
  never versioned from table count alone. Migration 0038 is then resumed
  statement-by-statement. Use `db:push` directly only for development.
- `db:generate` is the default path for new migration files.
- `drizzle/meta/` must stay in sync with the SQL migration history so future generation stays incremental.
- Only repair `drizzle/meta/` manually when recovering broken Drizzle history.
