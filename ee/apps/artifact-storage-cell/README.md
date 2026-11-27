# Artifact storage on celld

OpenWork Den keeps each artifact's saved data in a separate SQLite Durable Object on [celld](https://github.com/denoland/celld). The Worker routes to a cell named `<organizationId>/<appId>`. Den authenticates users, checks their permissions, and authors all SQL. This is a private service, not an end-user SQL API. Keep the Worker and celld's operator listener off public networks.

Use celld for any Den installation outside dev mode. Den's local SQLite backend is available only with `OPENWORK_DEV_MODE=1`.

## HTTP contract

All routes except `GET /health` require `Authorization: Bearer <token>` matching `ARTIFACT_STORAGE_TOKEN`. Storage routes return 503 if the binding is missing or shorter than 24 characters. `/health` is liveness only and responds `200 { "ok": true }` even if storage is not configured.

| Method and path | JSON request | Success |
| --- | --- | --- |
| `POST /v1/databases/:organizationId/:appId/query` | `{ schema, statement }` | `200 { rows }` |
| `POST /v1/databases/:organizationId/:appId/write` | `{ schema, statements }` | `200 { changes, sizeBytes }` |
| `DELETE /v1/databases/:organizationId/:appId` | None | `204` (also when already absent) |

IDs must match `^[a-z]{2,12}_[0-9a-z]{26}$`. A statement is `{ sql: string, params?: (string \| number \| null)[] }`; row values use the same types. Den only sends read-only statements to `query`. The Worker does not sandbox the Den service token to read-only SQL. POST bodies are limited to 1 MiB, each statement list to 64 entries, and query results to 2,000 rows. Errors are JSON `{ error, message }`: invalid inputs and SQLite errors are 400 (`sql_error` for SQLite), oversized bodies 413, and bad credentials 401.

`schema` is `{ version: number, statements: string[] }` with idempotent DDL. The cell applies it before SQL on the first access to a written database in an activation, and again when a higher version arrives. A write applies DDL and the batch in one synchronous transaction. `changes[i]` counts rows written by statement `i`; `sizeBytes` is the cell's SQLite `databaseSize`, which includes runtime overhead. Reads of cells without a committed write return `rows: []` without initializing the user schema; celld may still create the cell on that first event. `deleteAll()` clears the active cell's storage, including the first-write marker; it does not promise physical erasure from retained history or backups.

Den exports by reading `sqlite_schema` (available on celld v0.6.3), excluding `sqlite_*`, `_cf_*`, and `_litestream_*`, then rebuilding ordinary tables, indexes and row values in a standalone SQLite file. No committed write or no user tables means `null`, not an empty SQLite file. A database with tables but zero rows exports its schema. This is a logical export, not a byte-for-byte copy or a snapshot across concurrent writes. It does not preserve views, triggers, or implicit row IDs of tables without an explicit integer primary key. Pause writes for a consistent export.

## Run locally

From this package, after `pnpm install` at the repository root, create `.dev.vars` (ignored) with a random, 24+ character token and run celld v0.6.3:

```sh
(umask 077; printf 'ARTIFACT_STORAGE_TOKEN=%s\n' "$(openssl rand -hex 32)" > .dev.vars)
CELLD_ESBUILD="$PWD/node_modules/.bin/esbuild" celld dev . --port 9876
```

Set these variables in Den, using the same token:

```dotenv
DEN_ARTIFACT_STORAGE_BACKEND=celld
DEN_ARTIFACT_STORAGE_CELLD_URL=http://127.0.0.1:9876
DEN_ARTIFACT_STORAGE_CELLD_TOKEN=<same token as ARTIFACT_STORAGE_TOKEN>
```

State is in `.celld/dev` and survives normal restarts. `--clean` deletes it. To run both backend contracts and verify restart persistence using a separate temporary project, from the repo root:

```sh
CELLD_BIN=/path/to/celld pnpm --filter @openwork-ee/artifact-storage-cell test:celld
```

## Deploy to a fleet

A fleet runs one app. Give artifact storage its own celld node(s) and S3-compatible bucket or dedicated bucket prefix; do not deploy this to the headless runner's fleet prefix. Configure the nodes to read the same bucket/prefix. Keep `openwork-artifact-storage` and `ArtifactDatabase` stable: changing either orphans existing databases.

Inject `ARTIFACT_STORAGE_TOKEN` from the deploy environment's secret store into `vars.ARTIFACT_STORAGE_TOKEN` in a private, generated Wrangler config beside the entry point (or in a private staging copy of the project). `celld deploy` does not read `.dev.vars` or automatically turn shell environment variables into bindings. Do not commit the generated config or log its contents; treat the deployment bucket as sensitive because it contains the Worker configuration.

From that prepared project, deploy using your fleet's object-store credentials and settings:

```sh
CELLD_ESBUILD="$PWD/node_modules/.bin/esbuild" celld deploy . --bucket "$CELLD_BUCKET"
```

For a custom S3 endpoint and region, set `S3_ENDPOINT` and `AWS_REGION` or pass `--endpoint` and `--region`. Point `DEN_ARTIFACT_STORAGE_CELLD_URL` at the protected fleet address and set `DEN_ARTIFACT_STORAGE_CELLD_TOKEN` to match.

## Verified and not yet proven

Verified on celld v0.6.3 on macOS arm64: the HTTP backend contract, paged export to a readable SQLite file, and survival of an acknowledged row across a normal single-node `celld dev` restart using the local object store. Not yet verified: a real S3 bucket or deployment, multi-node ownership moves or failover, abrupt node loss, backup/restore or historical deletion, Cloudflare workerd, production latency/load, token rotation, or exports near the configured size limits.
