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

This is a product/source rename, not a domain, identity, or database migration:

- Hosted endpoint URLs, `/api/v1/*`, `/v1/inference*`, webhook and rollup paths,
  API response wrappers, SDK methods, and shared `inference` types stay stable.
- Existing `ow_inf_` bearer keys, hashes, encrypted keys, `ipr_`/`ink_` TypeIDs,
  database tables/columns, and Models entitlement metadata are unchanged.
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

No deployment is performed by this rename. Ordinary image upgrades roll pods;
changing Helm selectors or image repositories is deliberately not part of it.
