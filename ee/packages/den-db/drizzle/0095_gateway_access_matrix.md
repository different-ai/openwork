# Gateway Matrix Migration 0095

Status: complete registered SQL migration and source-serialized snapshot.
Offline generation and schema-delta inspection only; no database execution,
runtime tests, service changes, commits, pushes, or deployment performed.
The authoritative batch contract is `model-access-matrix.md` from the supplied
external inference-gateway documentation; its key/matrix decisions supersede
the historical plan.

## Registration

`0095_gateway_access_matrix.sql` is registered at journal index 95, version 5.
`meta/0095_snapshot.json` is the full 110-table snapshot produced directly from
`src/schema.ts` by `drizzle-kit/api.generateMySQLDrizzleJson`, with development
conditions resolving source exports. Its id is
`77d92f5c-83db-4218-a845-cd9f71339b2a`; prevId is
`17d704e9-8fe6-4f06-8b52-e1c7d08bc3a2` (0094). Existing SQL and metadata through
0094 are unchanged. Journal registration is not a claim of database application.

At the original 0095 source revision, reproduce the offline source/snapshot
comparison from `ee/packages/den-db`:

```sh
pnpm exec node --conditions=development --import tsx scripts/generate-gateway-matrix-metadata.mjs --check
pnpm exec node --conditions=development --import tsx scripts/generate-gateway-matrix-metadata.mjs --schema-delta
```

These historical generator commands intentionally reject a newer schema or
journal tip. After later migrations, use `db:migrate:local --check-artifacts`
to inspect the registered chain; do not regenerate 0095 against current source.

The generator rejects unrelated table/view drift. The schema-delta mode uses
Drizzle's `generateMySQLMigration` on an in-memory copy of 0094 with the eight
explicit table/column/index renames accounted for, avoiding interactive rename
prompts. It never edits persisted history or executes SQL. The resulting
schema-only delta has four creates, additions/index replacements and the nullable
legacy log key change, with no table/column/primary-key drops. The actual migration
keeps the staged nullable-add/backfill/NOT-NULL order rather than executing that
schema-only delta on populated tables. MySQL's primary indexes remain `PRIMARY`;
their table-derived Drizzle snapshot labels change without rebuilding them.

## Launcher Contract

- Run registered migrations in order. A fresh database must reach 0094 before
  0095. A database created by schema push may be baselined ONLY after the launcher
  verifies the full 0094 schema, including indexes, types, nullability, encrypted
  inference_keys.encrypted_key, all eleven observation-count columns and the lock.
  Never stamp 0095 merely because current schema exports contain Gateway tables.
- Execute all statements of 0095 sequentially on ONE dedicated MySQL connection.
  Split on the standard `--> statement-breakpoint` markers. Stop on first error;
  no force/ignore mode and no separate pooled connection per statement.
- The embedded preflight is automatic: no exported helper or extra runner hook
  is required. It uses a connection-local TEMPORARY table with primary-key
  sentinels. Invalid source data attempts a duplicate sentinel INSERT, which
  raises MySQL error 1062 naming the failed check BEFORE the first persistent DDL.
  There are ten `INSERT ... SELECT '0095_...'` checks. A launcher may extract
  their SELECT portions for an earlier read-only preflight before creating its
  own durable interruption marker; the embedded checks must still execute.
- Require CREATE TEMPORARY TABLES permission, ordinary migration DDL/DML rights,
  MySQL 8.0.16+ (including 8.4), and STRICT_TRANS_TABLES or STRICT_ALL_TABLES.
  MariaDB/TiDB are explicitly refused; other drivers or serverless sessions that
  cannot preserve a temporary table across statements need a separate migration
  runner, not a preflight bypass.
- Quiesce all writers, requests, OAuth callbacks and refresh workers from
  preflight through completion. A migration lock alone does not exclude app
  writers. MySQL DDL auto-commits, so this is not an online/atomic migration.
- Record the migration receipt only after all SQL succeeds. On preflight failure,
  persistent data/schema is unchanged by 0095; close the connection to discard
  its temporary table before retrying. On failure AFTER the first rename, stop
  startup and inspect the partial state; never blindly replay or baseline it.
- Do not run schema push against pre-matrix data. Do not regenerate 0093/0094.

## Preflight Failures

| Duplicate-entry marker | Required action before retry |
| --- | --- |
| 0095_requires_mysql_8_0_16_or_later | Use a supported MySQL server, not MariaDB/TiDB |
| 0095_requires_strict_sql_mode | Enable strict SQL mode on the migration connection |
| 0095_requires_complete_0094_schema | Apply/verify schema through 0094; do not guess a baseline |
| 0095_gateway_tables_already_exist | Inspect mixed/already-migrated state and its journal; do not overwrite |
| 0095_missing_legacy_indexes | Restore/verify the required 0093 indexes before attempting 0095 |
| 0095_invalid_typeid | Inspect canonical row/reference IDs; do not truncate or reinterpret them |
| 0095_orphan_or_cross_org_resource | Resolve the operational resource ownership mismatch explicitly |
| 0095_invalid_credential_subject | Resolve subject/member mismatches or duplicate provider/subject rows with an approved preservation plan; never expose/delete secrets |
| 0095_invalid_audience | Resolve a grant with both member and team populated |
| 0095_duplicate_audience_grants | Resolve equivalent audience duplicates explicitly; no silent deduplication |

These checks do not print secret material. They deliberately do not require
historical log/rollup references to still have live parents. Their row IDs remain
validated, and historical attribution is preserved rather than linked to defaults.

## Before Any Future Execution

- Coordinate a writer cutover. MySQL DDL auto-commits; this is not an online,
  transactional or blindly rerunnable migration. Old readers/writers use names
  that will no longer exist. Drain OAuth callbacks/refreshes as part of cutover.
- No database execution or real-data preflight has happened during this batch.
  Replay/rollback-failure journeys remain deferred to the verification phase.
- Confirm MySQL with enforced CHECK support (8.0.16+), strict SQL mode, and
  support for RENAME INDEX/CHANGE COLUMN.
  Do not disable checks or silently ignore invalid source data.
- Confirm every provider ID is exactly `ipr_` plus a canonical 26-character
  TypeID suffix and every model ID is `ipm_` plus one. Suffix alphabet is
  `[0-7][0-9a-hjkmnp-tv-z]{25}`, lowercase only. No suffix truncation is used.
- Confirm models, credentials, access and OAuth states reference existing
  providers. Confirm credentials' organizations match their provider and
  subjects match `org` with null member, or the actual member ID. Confirm all
  provider creators and grant audiences are same-org members/teams.
- Confirm grants never have both `org_membership_id` and `team_id` populated.
  Both null is the organization audience and remains an explicit org-wide rule.
- Check for duplicate org-wide grants per provider. The old nullable unique
  indexes allowed them. The preflight refuses duplicates; this migration
  does NOT delete, merge, change audience, or invent a selection to conceal them.
  If found, stop for an approved preservation/remediation strategy before DDL.
- Existing orphan rows, malformed IDs, or inconsistent audiences require an
  explicit remediation plan, not `INSERT IGNORE`, inferred credentials, or row
  deletion. Validate these preconditions BEFORE the first RENAME.

The duplicate/dual-audience inspections, for later authorized preflight only:

```sql
SELECT inference_provider_id, COUNT(*) AS grant_count
FROM inference_provider_access
WHERE org_membership_id IS NULL AND team_id IS NULL
GROUP BY inference_provider_id
HAVING COUNT(*) > 1;

SELECT id, inference_provider_id
FROM inference_provider_access
WHERE org_membership_id IS NOT NULL AND team_id IS NOT NULL;
```

## Exact Backfill

| Source | Target |
| --- | --- |
| Provider `ipr_<S>` | Group `gmg_<S>`, name `All configured models` |
| Provider `ipr_<S>` | Set `gcs_<S>`, name `Default credentials` |
| Model `ipm_<M>` under `ipr_<S>` | Link `gmm_<M>` to `gmg_<S>` and the existing `ipm_<M>` row |
| Every existing `ipc_` credential | Same ID, subject, member, secret, status, leases and timestamps; set `gcs_<S>` |
| Every existing `ipa_` grant | Same ID/audience/created_at; group `gmg_<S>` and set `gcs_<S>` |
| Every existing `ipos_` state | Same ID/verifier/expiry; set `gcs_<S>`; set used_at only if previously null |
| Existing `irl_` logs | Original key/provider/actual-credential references preserved under renamed columns; new selection/key fields null |
| Existing `iur_` rollups | Original hashes, counts, timestamps and unknown observation counts preserved; new selection fields null |

Default groups/sets start active; the original provider status remains unchanged
and is still an authorization gate. This avoids requiring a second enable when
an existing disabled provider is re-enabled. Provider created_at/updated_at seed
the defaults; model created_at seeds links. Concrete credential updated_at is
explicitly retained during set attachment.

The default set copies provider credential_mode, oauth_client_id and encrypted
oauth_client_secret verbatim. The current AES-GCM format is not table/row-bound;
no decryption or secret rotation is done by SQL. Provider copies remain legacy
metadata, not an alternative source of authorization configuration.

Old OAuth states lack a set/client revision binding, so all unused states are
conservatively marked used. Previously used timestamps remain unchanged. This
requires fresh starts, not token deletion or revocation of existing credentials.

No inference key is copied. `gateway_keys` starts empty; runtime connect/member
provisioning must mint a fresh `ow_gw_` key. Rotation updates the same stable
organization/member row, including encrypted value, hash, prefix, status and
revoked_at atomically while checking current membership. Models key issuance,
OpenRouter keys, limits, buckets and ledger are untouched by this foundation.

## Canonical Database Exports

Import from `@openwork-ee/den-db` or `@openwork-ee/den-db/schema`. Existing source
files remain `src/schema/inference-providers.ts` and `src/schema/inference.ts`.

| Export | SQL table | ID type name / persisted prefix |
| --- | --- | --- |
| GatewayKeyTable | gateway_keys | gatewayKey / gky |
| GatewayProviderTable | gateway_providers | inferenceProvider / ipr |
| GatewayProviderModelTable | gateway_provider_models | inferenceProviderModel / ipm |
| GatewayModelGroupTable | gateway_model_groups | gatewayModelGroup / gmg |
| GatewayModelGroupModelTable | gateway_model_group_models | gatewayModelGroupModel / gmm |
| GatewayCredentialSetTable | gateway_credential_sets | gatewayCredentialSet / gcs |
| GatewayProviderCredentialTable | gateway_provider_credentials | inferenceProviderCredential / ipc |
| GatewayProviderAccessTable | gateway_provider_access | inferenceProviderAccess / ipa |
| GatewayProviderOauthStateTable | gateway_provider_oauth_states | inferenceProviderOauthState / ipos |
| GatewayRequestLogTable | gateway_request_logs | inferenceRequestLog / irl |
| GatewayUsageRollupTable | gateway_usage_rollups | inferenceUsageRollup / iur |
| GatewayRollupLockTable | gateway_rollup_lock | integer singleton |

Lower-camel exports also exist (`gatewayKey`, `gatewayProvider`, etc.). Relations
are `gateway<Name>Relations`, except the lock has no relations. Temporary old
Inference table and lower-camel aliases refer to the SAME table objects. There
are no old column aliases; consumers must migrate field access and SQL strings.
Old relation export names and relation property names are not retained.

- Canonical provider references: `gateway_provider_id`. `provider_id` on the
  provider is still the catalog provider slug, not an `ipr_` reference.
- Links: `model_group_id`, `gateway_provider_model_id`. Unique group/model pair
  permits the same model in several groups.
- Credential sets: `gateway_provider_id`, `name`, `credential_mode`,
  `oauth_client_id`, encrypted `oauth_client_secret`, `status`, timestamps.
- Concrete credentials: required `credential_set_id`; unique
  `(credential_set_id, subject)`, not provider/subject. Other secret fields stay.
- Grants: required `model_group_id`, `credential_set_id`, `audience_key` alongside
  `gateway_provider_id`, nullable `org_membership_id` and `team_id`.
- Canonical audience keys: `organization`, `team:<tem_...>`, `member:<om_...>`.
  CHECK ties that key to exactly one audience; unique
  `(gateway_provider_id, audience_key, model_group_id, credential_set_id)` closes
  MySQL's NULL uniqueness hole without blocking multiple audience bindings.
- OAuth states: required `credential_set_id` plus provider/member identity.
- Logs: nullable `inference_key_id`, `gateway_key_id`, `gateway_provider_id`,
  `gateway_provider_credential_id`, `model_group_id`, `credential_set_id`,
  `access_grant_id`. Actual credential ID is never replaced by a set ID.
- Rollups: nullable `gateway_provider_id`, `model_group_id`, `credential_set_id`,
  `access_grant_id`. Keep `dimension_key` as the unique 64-character hash.

Like the existing schema, relations are Drizzle relations, not physical
cross-table foreign keys. Management/runtime must validate provider/org ownership
of groups, models, sets and audiences transactionally and reauthorize on use.

## Shared Utilities

`@openwork-ee/utils/gateway-bearer-key` exports `GatewayBearerKey`,
`GATEWAY_BEARER_KEY_RANDOM_BYTES`, `GATEWAY_BEARER_KEY_PREFIX`,
`gatewayBearerKey`, `createGatewayBearerKey`, `gatewayBearerKeyLookupDigest`,
`gatewayBearerKeyStorageDigest`, `gatewayBearerKeyLookupDigests`,
`gatewayBearerKeyMatchesDigest`, `gatewayBearerKeyPrefix`.
Keys use 32 random bytes, canonical base64url, prefix `ow_gw_`, and a
Gateway-domain HMAC-SHA256 lookup/storage digest. Lookup returns only this store's
digest; no inference-key or SHA-only fallback. Existing inference crypto is
unchanged. The branded wrapper is distinct from `InferenceBearerKey`.

`@openwork-ee/utils/gateway-routing` exports `GatewayWireModelId`,
`GatewayModelSelection`, `createGatewayModelAlias`, `parseGatewayModelAlias`,
`gatewayAudienceKey`. Parsed refs are `modelGroupId: DenTypeId<gatewayModelGroup>`,
`credentialSetId: DenTypeId<gatewayCredentialSet>`,
`gatewayProviderModelId: DenTypeId<inferenceProviderModel>`.
Malformed/noncanonical aliases return null. Successful parsing is NOT permission.

`@openwork-ee/utils/gateway-rollups` exports `GatewayRollupDimensions` and
`gatewayRollupDimensionKey`. The SHA256 preimage is the JSON array of:
`openwork-gateway-rollup-dimensions-v2`, organization_id, org_membership_id,
gateway_provider_id, route, protocol, upstream_provider_id, upstream_model,
model_group_id, credential_set_id, access_grant_id, in that exact order.
All nullable inputs must be explicitly null, not guessed default resources.
New raw/hour/day aggregation must use all these dimensions, preserve legacy
unknowns, and never rewrite historical hashes in place. New tuple encoding
distinguishes null/empty and embedded separators. Actual credentials/keys are
not rollup dimensions, matching the contract.

## Source API Contracts

`@openwork/types/den/gateway` and the types root export:

- `GatewayAudience`, `GatewayModelGroupWrite`, `GatewayModelGroup`,
  `GatewayCredentialSetWrite`, `GatewayCredentialSet`, `GatewayAccessGrantWrite`,
  `GatewayAccessGrant` and the corresponding three `*Patch` types.
- `GatewayAuthorizationRequest` (`credentialSetId`, `name`, `authUrl`),
  `GatewaySelection`, `GatewaySelectionConflict`, `GATEWAY_GRANT_HEADER`.
  The conflict code is `gateway_selection_required` with named `selections`;
  this is the proposed shared wire spelling for the doc's structured conflict.
- `GatewayUsableModel`: `id`, `name`, `config` (required `id` equal to wire ID),
  `upstreamModelId`, `modelGroupId`, `modelGroupName`, `credentialSetId`,
  `credentialSetName`.
- `GatewayProviderSummary`, `GatewayProviderDetails`,
  `GatewayProviderConnectSummary`, `GatewayProviderMigration`,
  `GatewayProviderCredentialSummary`, `GatewayProviderListResponse`,
  `GatewayProviderResponse`, `GatewayProviderDetailsResponse`,
  `GatewayProviderConnectResponse`.
- `GatewayOauthStartRequest`, `GatewayDesktopOauthStartRequest`,
  `GatewayOauthStartResponse`, `GatewayDesktopOauthStartResponse`.
- Canonical `GATEWAY_*` enum constants and `Gateway*` secret/enum types alias
  the existing persisted values; canonical secret schemas/parser are also
  exported. `GATEWAY_KEY_STATUSES` and `GatewayKeyStatus` are new.

Management details require modelGroups/credentialSets/accessGrants. Group writes
use catalog model IDs, not row IDs. Credential sets include required `configured`
(configuration presence, not upstream probe) and caller-relative credentialStatus;
the boolean makes the doc's configured-versus-ready distinction explicit.
Provider-level credentialMode/credentialStatus/authUrl remain compatibility hints;
the provider's active/disabled status remains an authorization gate.
Mixed providers can return both usable models and authorizationRequests. Connect
requires apiKey/apiKeys; these must only hold the current member's Gateway key.
Legacy response envelopes and provider URLs retain `inferenceProvider(s)`.
The interfaces do not themselves enforce runtime validation or secret filtering.

Request-time selection, OAuth/key lifecycle, matrix CRUD, wire-ID rewriting and
desktop synchronization are owned by the concurrent runtime/UI batch. This
migration finalization does not modify or certify those sources. No app/API/UI
source or user process was changed by the migration work.
