# Consolidated Gateway Migration 0097

**DRAFT ONLY: deployment blocked. Not a populated-data conversion or rollout approval.**

This replaces pending 0097-0099 with one official Drizzle-generated schema
migration from the unchanged 0096 snapshot to current source at
`f128bff74a3284fac8b7ad17c6949d25ec14a671`. Work was isolated to branch
`consolidate-gateway-migration`. No database access, environment-file loading,
secret retrieval, migration application or builds occurred. Follow-up local
tooling verification is limited to offline tests with synthetic executors.

`.github/workflows/den-db-migrate.yml` automatically applies production
migrations when migration changes reach `dev`, and has scheduled retries at
minutes 23 and 53. This change does not disable that workflow. Keep the PR a
draft, do not enable auto-merge, and require an explicit deployment decision
before merging. The pending-at-0096 premise was supplied, not verified here.
The operator confirms that all eight intermediate `inference_*` tables below,
introduced in this same PR, contain no data. This is an accepted operator
premise, not a measured production row count. No backfills are required under
that premise; no database query was made to establish it.

## Generation Provenance

- Installed only the database package's workspace dependency closure:
  `pnpm --filter @openwork-ee/den-db... install --frozen-lockfile --ignore-scripts`.
- Used lockfile-pinned `drizzle-kit@0.31.9`, `drizzle-orm@0.45.2`, Node
  `v24.18.0`, and pnpm `11.4.0`.
- Copied migration history into `node_modules/.gateway-generation/drizzle` in
  this worktree. Removed 0097-0099 SQL, snapshots, notes and journal entries
  from that staging directory before generation. No source schema was changed.
- Used a separate credential-free config, never the repository config that
  imports `load-env.ts`. Generator subprocess environment contained only PATH
  and TERM; no database driver, push, migrate, introspection or export command
  was invoked.
- Ran the unmodified official CLI. A temporary PTY helper supplied only the
  reviewed create/rename keystrokes below, refusing unexpected prompts. It did
  not replace Drizzle resolvers, mutate the baseline, or author SQL.
- Copied the successful SQL and snapshot byte-for-byte into `drizzle/`.
  The generated SQL, snapshot ID, and rename metadata were not edited.
- Removed journal entries 98/99 while retaining the original index-97 entry,
  version `5`, tag and timestamp `1788895934602`. The CLI's staging timestamp
  `1789151600704` was deliberately not promoted. No new later timestamp is used
  to make old deployments replay the replacement.

Config at `node_modules/.gateway-generation/drizzle.config.ts` (schema path
resolved to this worktree's absolute path during the actual run):

```ts
export default {
  dialect: "mysql",
  schema: "./src/schema.ts",
  out: "../../../node_modules/.gateway-generation/drizzle",
};
```

Generation command, working directory `ee/packages/den-db`, after preparing the
clean staging history and credential-free config:

```sh
env -i PATH="$PATH" TERM=xterm-256color node --conditions=development --import tsx ./node_modules/drizzle-kit/bin.cjs generate --config ../../../node_modules/.gateway-generation/drizzle.config.ts --name gateway_access_matrix
```

Select these eight table renames, never DROP/CREATE replacements:

| From | To |
| --- | --- |
| inference_request_logs | gateway_request_logs |
| inference_rollup_lock | gateway_rollup_lock |
| inference_usage_rollups | gateway_usage_rollups |
| inference_provider_access | gateway_provider_access |
| inference_provider_credentials | gateway_provider_credentials |
| inference_provider_models | gateway_provider_models |
| inference_provider_oauth_states | gateway_provider_oauth_states |
| inference_providers | gateway_providers |

Select CREATE for `gateway_credential_sets`, `gateway_keys`,
`gateway_model_group_models`, and `gateway_model_groups`.

Select `inference_provider_id` -> `gateway_provider_id` in these six renamed
tables: request logs, usage rollups, provider access, provider credentials,
provider models, and provider OAuth states. Also select
`inference_provider_credential_id` -> `gateway_provider_credential_id` in request
logs. Select CREATE for every genuinely new column: never reuse an unrelated
key/reference column. The actual CLI resolved 31 prompts: 12 table choices and
19 column choices (seven renames, twelve creates). The provider's `model_ids`
addition needs no rename prompt because that table has no missing column.

Local raw CLI transcripts, staging output, verification report and disposable
helpers remain under this worktree's ignored `node_modules/`. They are not
application tooling or migration inputs. The initial CLI attempt failed before
generation because Drizzle prepended `./` to an absolute output path; the
successful attempt used the relative output path above. No dependency patch
or snapshot normalization was used to generate the SQL.

## Artifact Identity

| Artifact | Value |
| --- | --- |
| 0096 snapshot ID | `17d704e9-8fe6-4f06-8b52-e1c7d08bc3a2` |
| 0097 snapshot ID | `f7b78d83-818b-4d27-b696-73e0e3cf6dda` |
| 0097 prevId | `17d704e9-8fe6-4f06-8b52-e1c7d08bc3a2` |
| 0096 snapshot SHA-256 | `62c1d2787cd6064a258238dfc1c066bfa3bde1dbf4a33b4ebc8f1af906a74282` |
| Generated 0097 SQL SHA-256 | `96e872e1fdf004ff4cdf66715a589a442dff80170f2b47e70204b38a2fd09470` |
| Generated 0097 snapshot SHA-256 | `64a86086082e0906028aa0064514658ebee7a8fe2b0ecb2e6f589e61b9fca5b5` |

The SQL contains 98 breakpoint-delimited statements: four new tables, eight
table renames, seven column renames, and the generated column/constraint/index
changes. No table/column drops or data INSERT/UPDATE/DELETE statements occur.
The creator column is present directly in CREATE TABLE `gateway_credential_sets`;
`model_ids` is added directly with its final JSON type, default and nullability.

## Empty-Source Contract And DDL Blockers

The consolidated migration is a schema diff, not a populated-data conversion.
Required group/set/audience columns are added directly, `model_ids` has its final
empty-array default, and the nullable credential-set creator is in CREATE TABLE.
No legacy groups, sets, model selections, creators, keys or OAuth bindings need
to be backfilled for the operator-confirmed empty intermediate tables. If any
source contains rows, stop: this migration does not define a conversion for them.

Eight separate DROP PRIMARY KEY / ADD PRIMARY KEY pairs remain verbatim because
Drizzle treats table-derived primary-key names as changes. Target engines may
reject the intermediate keyless table. Index drop/re-create operations also
temporarily remove uniqueness. These generated bytes have not been edited to
work around engine restrictions; writers must remain stopped.

MySQL DDL auto-commits; failure can leave persistent partial changes. The
production runner's transaction behavior remains unresolved and is outside this
assignment. No new production runner was implemented. The local runner's guards
do not protect the production ORM migrator or authorize a rollout. MySQL/Vitess
execution, CHECK enforcement and primary-key compatibility remain unverified.
The full migration replay fixture is retained, not executed or claimed passing.

Do not apply this replacement where any old 0097-0099 migration was applied or
partially executed, including schema changes without receipts. Such deployments
need a separately approved forward/recovery plan. Retaining the old timestamp
does not reconcile hashes or make an applied migration rerun; never delete,
restamp, baseline or accept mismatching receipts to bypass that distinction.

## Offline Verification

- Compared 186 tracked historical SQL/snapshot/note files through 0096 against
  base commit bytes, including their staging copies; unchanged. Journal entries
  through 0096 were preserved exactly as objects, and the final journal edit
  removes only entries 98 and 99.
- Independently serialized current `src/schema.ts` using official
  `generateMySQLDrizzleJson`. Persisted schema structure matches after excluding
  only identity/rename metadata and JSON-serializing omitted `undefined` fields.
- Official `generateMySQLMigration(generated0097, currentSourceSnapshot)`
  returned zero statements. This verifies snapshot/source consistency, not SQL
  execution or engine compatibility.
- Verified 110 final tables, including exactly 12 gateway tables; eight table
  and seven column rename metadata entries; unrelated tables unchanged from
  0096; four CREATE TABLEs; no table/column drops or DML; eight matching primary-key
  drop/add pairs; and all 98 statement packets end in SQL semicolons.
- Verified promoted SQL and snapshot bytes equal the raw CLI output. Narrow
  offline tests cover generated SQL shape, source/snapshot semantic parity,
  prerequisite artifact hashes and synthetic local-runner safety. No database
  tests, wide typechecks, builds or database probes are part of this verification.

The disposable verification helper initially compared in-memory `undefined`
properties against serialized JSON and overmatched `ON UPDATE` defaults as
UPDATE statements. Those were helper defects, not schema differences; the
corrected check compares JSON forms and recognizes DML only at statement starts.

Local-tooling follow-up commands, from `ee/packages/den-db`, all exited 0:

```sh
env -i PATH="$PATH" node --conditions=development --import tsx --test test/gateway-preflight.test.ts
env -i PATH="$PATH" node --conditions=development --import tsx --test --test-name-pattern='local startup migration safety' test/migration-readiness.test.ts
env -i PATH="$PATH" node --conditions=development --import tsx --test --test-name-pattern='^(drizzle-kit export |migration ownership |worker seed )' test/migration-schema-parity.test.ts
env -i PATH="$PATH" node --conditions=development --import tsx scripts/dev-migrate.ts --check-artifacts
```

Results: 5, 26 and 7 tests passed respectively, with zero failures or skips in
the selected tests. The artifact check validated 97 migrations and 41 foundation
statements without connecting. The export retry tests use synthetic results;
their diagnostic messages are expected, not actual CLI failures. Database replay
tests and the package-build test were excluded, not counted as passing.

## Local Tooling

- `scripts/dev-migrate.ts` pins the raw consolidated SQL hash, verifies the
  baseline and performs read-only existence probes for all eight source tables
  before any writes when starting from 0096. With a verified 0095 baseline it
  checks all seven present sources, skipping only the rollup lock that 0096
  creates. It repeats all eight probes after 0096, before executing any 0097 SQL.
- Version, strict mode, loopback, session, schema, lock, receipt and interruption
  marker checks remain in place. Source query errors and nonempty sources abort.
  These are local-runner checks, not additions to generated SQL.
- `historyPrefix` accepts only exact hash/timestamp history. The old 0097 receipt
  alias was removed, not expanded. Applied or partially applied old 0097/0098/0099
  environments require explicit recovery, never automatic stamping or replay.
- The three obsolete `generate-gateway-*-metadata.mjs` helpers were retired.
  Their old commands are historical only and must not regenerate migration
  assets. Use official Drizzle generation as documented above for future work.

Resolve the production transaction runner and generated DDL compatibility in
separately authorized work before merging or applying. Keep the PR draft while
those blockers remain. No database access is authorized by this document.
