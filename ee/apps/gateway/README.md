# OpenWork Gateway

OpenWork Gateway routes native provider requests using server-held credentials.
Run `pnpm dev:den:gateway`, or build with `pnpm --filter @openwork-ee/gateway build`.
The app lives at `ee/apps/gateway`; `ee/apps/den-gateway` is a separate service.
OpenWork Models remains the name of the managed model catalog, not this gateway.

## Operator Configuration

Set these on Gateway; also set the proxy base URL and egress allowlist on Den API:

| Canonical variable | Deprecated alias | Default |
| --- | --- | --- |
| `GATEWAY_PORT` | `INFERENCE_PORT` | `8791` |
| `GATEWAY_PROXY_BASE_URL` | `INFERENCE_PROXY_BASE_URL` | Den API: `http://127.0.0.1:8791` |
| `GATEWAY_ADMIN_TOKEN` | `INFERENCE_ADMIN_TOKEN` | Disabled |
| `GATEWAY_WEBHOOK_SECRET` | `INFERENCE_WEBHOOK_SECRET` | Unset |
| `GATEWAY_UPSTREAM_TIMEOUT_MS` | `INFERENCE_UPSTREAM_TIMEOUT_MS` | `1800000` |
| `GATEWAY_CREDITS_PER_DOLLAR` | `INFERENCE_CREDITS_PER_DOLLAR` | `1000000` |
| `GATEWAY_EGRESS_ALLOWED_ORIGINS` | `INFERENCE_EGRESS_ALLOWED_ORIGINS` | Empty (public HTTPS only) |

An explicitly set canonical value wins over its alias, including an empty value.
Invalid canonical numeric values fail startup rather than falling back to the
alias. Empty admin/webhook secrets disable those credentials; empty egress
allowlists remove all exceptions, never merge old permissions. An empty proxy
base URL uses the existing default. Configure the same egress policy in Den API
and Gateway. Origins must be exact, operator-owned origins, not wildcards.

Hosting-platform `PORT` is still supported: runtime precedence is `GATEWAY_PORT`,
then `PORT`, then `INFERENCE_PORT`, then `8791`. Local development scripts use
`GATEWAY_PORT` with the deprecated `INFERENCE_PORT` fallback. Development mode
retains its existing non-production defaults; use `.env.example` for a local setup.

## Stable Contracts

The service rename keeps deployment and Models contracts stable. The Gateway
access-matrix source batch requires registered migrations 0097 through 0099:

- Hosted endpoint URLs, `/api/v1/*`, `/v1/inference*`, webhook and rollup paths,
  API response wrappers, SDK methods, and shared `inference` types stay stable.
- Existing Models `ow_inf_` bearer keys, hashes, encrypted keys, limits, usage
  buckets, ledger and entitlement metadata are unchanged. Gateway provider IDs
  remain `ipr_`; Gateway requests now require independent `ow_gw_` keys.
- `OPENWORK_INFERENCE_BASE_URL` remains the managed desktop sync environment
  contract. `STRIPE_INFERENCE_PRICE_ID` still configures OpenWork Models billing.
- Helm keeps `inference.*`, `config.inference.*`, internal URL overrides, secret
  keys, release/service/container names and selectors. Do not rename installed
  releases or services for this change. The chart continues emitting legacy env
  names so pinned older images still work; the new runtime accepts them.
- `packaging/docker/Dockerfile.gateway` still publishes to
  `ghcr.io/different-ai/openwork-inference`. Existing image consumers need no
  repository migration. External source builds must update their app/Dockerfile
  paths; model-site builds must use `ee/apps/gateway/models-site`.
- Health/readiness paths, status codes, and checks stay stable; their display
  `service` is now `gateway`. Access log prefixes and report titles say Gateway.
  Update any external monitors that match the old display text.

No deployment or migration execution is performed by this source batch. Coordinate
the schema/writer cutover described in `ee/packages/den-db/drizzle/0097_gateway_access_matrix.md`
before running the new runtime. Do not deploy it against the old table names.

## Matrix Routing

- Provider summaries/details and the management `/models` response expose
  `modelIds: string[]` as policy, not a snapshot of resolved rows. POST defaults
  to `[]`; PATCH `[]` deliberately selects all supported catalog models. Nonempty
  policies restrict to those IDs and remain nonempty when catalog entries vanish.
- Den provider detail, list/connect sync, catalog and group-editing paths refresh
  model rows using the existing ten-minute models.dev cache. Network I/O happens
  before the provider lock; policy is reread under that lock. Failed or malformed
  catalog loads retain previous rows, filtered by the saved policy. The inference
  proxy itself does not fetch the upstream account's model catalog or grant it.
- `catalogWarning?: string` is a UI hint on summaries/details and management
  `/models`. Display it when present: "all models" means all supported catalog
  models, excluding incompatible SDK overrides or unresolved model configuration.
  Explicitly selecting an incompatible catalog model returns HTTP 400
  `unsupported_model_sdk`; refresh never relaxes those safety checks.
- Catalog refresh updates metadata without changing surviving `ipm_` IDs.
  Removed models lose all group links before their rows are deleted, atomically
  under the provider fence. Empty groups and grants remain, with no usable models.
  New or returning catalog models never rejoin existing groups automatically.
- Group `modelIds: []` means no models, never a wildcard. The initial "All
  Allowed Models" group captures resolved rows only at creation and remains
  visible when empty until explicitly deleted. No credential
  or access grants are inferred from provider policy. Runtime authorization,
  including OAuth and pre-egress checks, intersects group links with current
  `gateway_providers.model_ids` even when materialized rows are stale.

- Models `/api/v1/chat/completions` and `/api/v1/models` only authenticate the
  original inference-key store. Gateway `/api/v1/providers/:ipr/*` only accepts
  canonical `ow_gw_` keys with active same-organization membership. Neither key
  type authenticates the other route; Gateway does not require a Models tier.
- Requests resolve configured provider model rows and active group/set grants.
  Explicit aliases constrain candidates before member > team > organization
  priority. Equal-priority different sets return HTTP 409 with the shared
  `{error: "gateway_selection_required", message, selections}` contract. Equivalent
  grants using one set select the lexicographically smallest winning grant ID.
- `gwm_<gmg suffix>_<gcs suffix>_<ipm suffix>` is selection, not permission.
  The gateway verifies all references and rewrites body/path models to `model_id`
  before provider-specific Vertex rewrites or AWS signing. Unambiguous raw model
  IDs also work; response model fields are not rewritten.
- GET provider `/models` is a local, non-cacheable list of accessible combinations,
  not the provider-account catalog. Each entry has the alias in both `id` and
  `config.id`, raw `upstreamModelId`, and group/set IDs and names. A listed grant
  does not guarantee its member token is ready; management supplies per-set
  `authorizationRequests`. The listing never materializes a credential.
- Provider management requires an organization admin or higher role; writes
  additionally require fresh authentication. Provider identity and destination
  settings are immutable after creation. Names, model selection and status may
  be edited. Members retain granted connect/sign-in/revocation flows for their
  own member-mode credentials, not access to shared credential administration.
- `x-openwork-gateway-grant-id` is a selection hint for model requests, never
  permission by itself. It is reauthorized and is not forwarded upstream.
- JSON model extraction also applies to embeddings and other supported native
  model operations without a usage parser. Conflicting body/path selectors,
  OpenRouter routing arrays/plugins and missing models fail before credential
  lookup. Upstream requests are limited to explicitly supported POST model
  operations. File/account/fine-tuning management, batches/assistant runs and
  unrecognized operations return `unsupported_gateway_operation`; non-JSON
  payloads, including multipart uploads, return `unsupported_media_type`.
  Provider-stored resources, prior-response/conversation references and hosted
  tools return `unsupported_gateway_resource` until ownership checks exist.
  Caller-selected OpenAI organization/project headers and Bedrock guardrail
  references are also rejected before credential lookup.
  Inline content and client-executed function tools remain supported.
- Credentials are selected by set + subject (`org` or the requesting member).
  Set mode and OAuth client configuration are authoritative. OAuth refresh leases
  recheck active membership/key/provider/group/set/grant/model links and current
  client configuration under local row locks; no lock crosses token HTTP calls.
  Recheck after token work and accounting awaits; never fall back to another set.
- `openwork_auth_required` responses identify `provider_id` and
  `credential_set_id`. Invalid/foreign selections fail closed with
  `invalid_gateway_selection`, `model_access_denied` or `provider_access_denied`.
  Concurrent revocation returns `gateway_selection_revoked`; credential changes
  return `provider_credential_retry` without forwarding the old secret.
- Logs use `gateway_request_logs`: Models fill only `inference_key_id`; Gateway
  fills `gateway_key_id`, `gateway_provider_id`, actual
  `gateway_provider_credential_id`, `model_group_id`, `credential_set_id` and
  `access_grant_id` when selected. Existing route values stay unchanged.
  Rollups use the shared `gatewayRollupDimensionKey` with nullable selection
  dimensions. Historical hashes/unknown observation counts are not rewritten;
  bounded source claims, transactional consumption and update-only finalization
  remain unchanged.
  Neither requests nor rollups record a team ID. Team usage is grouped dynamically
  by current memberships; members in multiple teams contribute to each team, so
  summing team totals can exceed the organization total.

This batch has not run tests, typechecks or builds. Migration 0098 uses offline
Drizzle serialization only; no migration has been applied. Existing source fixtures
under this app are updated. The separately owned `evals/specs/inference-gateway-*`
journeys still need Gateway key, matrix seeding and renamed SQL/column updates
before the next authorized verification run.
