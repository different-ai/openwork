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

`celld deploy` does not read `.dev.vars` or turn shell environment variables into bindings: the token has to be in `vars.ARTIFACT_STORAGE_TOKEN` of the Wrangler config it is given. `scripts/celld-deploy.sh` does that in a private staging copy inside this package (`.deploy.*`, ignored by git) that it deletes afterwards, and prints only the deployed version. celld's version is a hash of the bundle, and the bundle names its modules by their path from the staging copy, so the same source gives the same version from any checkout. Give it the fleet's object-store credentials and settings and the token from your secret store, as a file:

```sh
CELLD_BIN=/path/to/celld CELLD_BUCKET=s3://bucket/artifact-storage ARTIFACT_STORAGE_TOKEN_FILE=/path/to/token \
  pnpm --filter @openwork-ee/artifact-storage-cell deploy:celld
```

For a custom S3 endpoint and region, set `S3_ENDPOINT` and `AWS_REGION`. Add `--dry-run` to bundle and print the version without writing. Treat the deployment bucket as sensitive: it holds the Worker configuration, token included. Point `DEN_ARTIFACT_STORAGE_CELLD_URL` at the protected fleet address and set `DEN_ARTIFACT_STORAGE_CELLD_TOKEN` to match.

Running nodes adopt a new version from the bucket and log `deployment_adopted`, as the runner's do, with no restart. A fleet you run yourself gets a new Worker only when you run the script again, so run it whenever this package changes.

Before a fleet gets a new Worker, prove it on a throwaway bucket prefix. `preflight:celld` deploys there with a random token, serves it from one real node, checks the HTTP contract (`scripts/celld-smoke.mjs`), restarts the node with an empty disk and reads the same rows back from the bucket. Remove the prefix afterwards:

```sh
CELLD_BIN=/path/to/celld CELLD_BUCKET=s3://bucket/ci/<unique> pnpm --filter @openwork-ee/artifact-storage-cell preflight:celld
```

### OpenWork Cloud's fleet

`.github/workflows/celld-artifact-storage-deploy.yml` deploys OpenWork Cloud's fleet on every `dev` push that changes this package or a workspace package it depends on. It bundles the Worker and compares the version with the one the fleet runs; when they are the same it writes nothing. Otherwise it runs the preflight, deploys, and waits until every node has logged adopting the new version (`scripts/celld-wait-adopted.mjs`). Run it by hand from the Actions tab to deploy without a push.

The token is kept in one place, the fleet's Render service, and the workflow reads it from there. It also reads Den's copy and stops if the two differ, because that deploy would lock Den out of saved data. To rotate the token: change it on the fleet's service, run the workflow by hand with `allow_token_change`, then change Den's copy. Den is refused from the moment the nodes adopt the new deployment until its copy matches.

Run the nodes with the settings `ee/apps/headless-runner/OWNER-CELLS.md` recommends ("Recommended production settings"): at least two nodes, `CELLD_DURABILITY=bucket`, `CELLD_TTL_MS=60000`, an idle eviction time, LTX retention, and a shutdown grace longer than `CELLD_SHUTDOWN_TOTAL_MS`. OpenWork Cloud's fleet is checked every 15 minutes by `.github/workflows/celld-fleet-health.yml` and copied daily by `.github/workflows/celld-backup.yml`, beside the runner's.

## Verified and not yet proven

Verified on celld v0.6.3 on macOS arm64: the HTTP backend contract, paged export to a readable SQLite file, and survival of an acknowledged row across a normal single-node `celld dev` restart using the local object store.

Verified on celld v0.6.3 against a real S3-compatible bucket (Cloudflare R2, a dedicated prefix), on 27 November 2026:

- The backend contract and Den's storage service tests against one node on the bucket, and an acknowledged row read back by a fresh node with an empty disk.
- A two-node fleet on Linux x64 behind a private address: requests without the token or with a wrong one are refused (401); from the same private network a write is acknowledged in about 0.3 s (p95 0.36 s, the bucket write included) and a read in about 4 ms; 30 writes at once all succeed.
- One database filled to 18.6 MiB, just under Den's default 20 MiB cap, then read back in pages (294 rows in 0.5 s).
- Stopping and starting every node at once: both were serving again in about 15 seconds with every acknowledged row intact.
- Deleting a database (204), after which its tables are gone.
- Deploying a new version with `deploy:celld` while the fleet served: both nodes adopted it in place within about 20 seconds, and rows written under the old version were read, and added to, under the new one.

Not yet verified: abrupt loss of one node while it owns busy cells, restoring from a backup, erasure from retained history, Cloudflare workerd, sustained production load, token rotation, or a Den export near the size cap.
