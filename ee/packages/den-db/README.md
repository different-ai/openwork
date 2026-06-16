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
  which alters pre-existing tables), so an empty database cannot be built
  by replaying migrations. Create fresh databases with `db:push` (dev) and
  use `db:baseline` + `db:migrate` for databases that already have the schema.
- `db:generate` is the default path for new migration files.
- `drizzle/meta/` must stay in sync with the SQL migration history so future generation stays incremental.
- Only repair `drizzle/meta/` manually when recovering broken Drizzle history.
