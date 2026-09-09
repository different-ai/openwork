# Gateway Provider Model Universe

Additive successor to registered `0095_gateway_access_matrix`, serialized from
current schema source with Drizzle's offline API. The snapshot keeps format
version 5 and points at 0095's snapshot ID. No previous SQL/snapshot is rewritten.

`gateway_providers.model_ids` is a JSON array policy, separate from stable
`gateway_provider_models` records. An empty array follows all supported catalog
models. A nonempty array restricts to those exact upstream IDs, including IDs
that later disappear from the catalog. Group membership remains explicit.

SQL first adds the nullable column, backfills each existing provider from its
existing model records, then installs `NOT NULL DEFAULT (JSON_ARRAY())`.
Providers with no model records backfill to `[]`; they gain no group links,
credentials or grants. No existing rows, group links or access are altered.

Coordinate a writer cutover for the backfill: old writers do not maintain the
new policy, so they must not mutate model selections during/after backfill.
MySQL DDL is not transactional. If interrupted, inspect the completed statements
and resume deliberately; do not replay ADD against an existing column.

Offline generation (not migration execution):

```sh
pnpm --dir ee/packages/den-db exec node --conditions=development --import tsx scripts/generate-gateway-universe-metadata.mjs
```

The generator refuses any delta other than this column, requires 0095 to be the
journal tip, and creates 0096 without overwriting existing snapshots. It does
not load environment files, connect to a database, build packages or run tests.
The SQL intentionally stages Drizzle's single-column delta around the data
backfill. Applying this migration remains a separate, explicitly authorized step.
