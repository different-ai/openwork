# Where inference attribution belongs

## Recommendation: both, with different trust boundaries

Use OpenWork's existing AI gateway and member-scoped credentials for first-party
headless inference. Keep this PR's optional header adapter for direct connections
to an operator's external gateway. Do not replace authenticated gateway identity
with a caller-supplied attribution header. No gateway fold-in is implemented here.

This is per-member inference cost allocation, budgets and audit, not product
analytics. The AI inference gateway is `ee/apps/gateway`, not Den's MCP gateway.

## Current implementation (base `25b99c96f0`)

- `ee/apps/gateway/src/middleware/gateway-auth.ts` authenticates `ow_gw_` keys
  and derives organization, membership and key identity from stored credentials.
  `src/keys.ts` requires active membership and distinguishes Gateway and Models keys.
- `src/gateway.ts` authorizes model grants, resolves the organization/member's
  provider credential and admits usage with authenticated `orgMembershipId`.
  `src/request-log.ts` records that identity; `src/usage-limits.ts` and
  `ee/packages/den-db/src/gateway-usage-limits.ts` support member/team/org limits.
  Per-user LiteLLM keys deliberately defer budgeting to LiteLLM.
- Gateway egress uses an allowlist (`src/protocols.ts`), not unrestricted header
  passthrough. `X-User-Id`, `X-Member-Id` and `x-portkey-user-id` do not simply
  survive that hop.
- The managed Models proxy (`src/proxy.ts`) already overwrites OpenRouter
  `body.user` with authenticated membership and supplies request/key trace
  identity. Its organization-pooled allowance is distinct from provider Gateway
  usage limits; `src/webhooks.ts` checks identity when settling charges.
- Den's `src/workbot/gateway-model.ts` and `gateway-keys.ts` issue a member-bound
  route/key as per-turn `modelAccess`. `src/headless-runner/resume-grants.ts`
  reauthorizes on resume. Runner model pinning and required-access checks prevent
  fallback to a shared deployment key when scoped access is required.

## Options

| Option | Benefits | Costs / risks |
| --- | --- | --- |
| Runner only | Minimal direct external-gateway integration; protocol neutral; works without OpenWork Gateway | Does not fix shared-key identity at OpenWork Gateway; downstream headers are filtered; runner-only coverage |
| Gateway only | One authenticated attribution authority across clients; central disclosure policy and upstream mapping | Does not help deployments bypassing our gateway; requires new gateway configuration and protocol/provider coverage |
| Both (recommended) | First-party accounting stays authoritative; direct operator gateways remain supported | Two explicitly scoped egress adapters; must avoid double mapping and never trust forwarded headers for identity |

A future gateway implementation should derive configured provider-specific egress
headers from **authenticated gateway membership**, overwrite/reject claimed values,
and test streaming, retries, redirects, protocol conversion, budgets, and audit.
That is separate work, not this rebase.

## Changes in PR #6039

Retain `HEADLESS_MODEL_USER_HEADER` / `_FORMAT` and off-by-default
`headlessModelAttribution` for the direct adapter. Document that these headers do
not change OpenWork Gateway accounting or bypass its upstream-header allowlist.
Preserve current scoped routes, pinning and reauthorization during rebase; extend
attribution to OpenAI Responses and steps, and propagate fresh identity through
resume/refresh (omission clears prior identity). Add feature metadata/docs and a
reusable recording gateway world. Do not modify gateway routing/accounting.

The fake world verifies transport using a mocked trusted Den issuer, not real
Den login/database membership, gateway budgets, or a vendor's enforcement. Those
trust boundaries are intentionally distinct.
