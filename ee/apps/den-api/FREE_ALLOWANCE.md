# Free Luna: Den Integration

Den uses the shared exports in `@openwork/types/den/inference`. See
`../inference/FREE_ALLOWANCE.md` for execution and accounting authority.

## Desktop Contract

`GET /v1/inference/access` accepts the existing authenticated session and active
organization context (`x-openwork-org-id` when explicitly scoped). A joined,
non-removed member is required. There is no client-supplied enrollment or user ID.
The response is private and `Cache-Control: no-store`:

```ts
import type { InferenceAccess } from "@openwork/types/den/inference"

type InferenceAccessResponse = {
  access: InferenceAccess & { canUpgrade: boolean }
  upgradePath: "/dashboard/billing" | null
}
```

`access` contains `kind: paid | free | exhausted | unavailable`, `modelID`,
`weeklyLimitUsd`, `usedUsd`, `reservedUsd`, `remainingUsd`, `resetsAt`, `reason`
and `canUpgrade`. The numeric fields are USD, not internal accounting units.
`resetsAt` is the next Monday at 00:00 UTC. Paid access has null free-allowance
fields and does not fall through to free when a paid limit is reached.

The allowance is **usage-metered**, not a strict USD spending cap. `usedUsd` is
settled actual provider cost. `reservedUsd` is only an estimated pending cost,
not actual spend or a guaranteed charge ceiling. `remainingUsd` is
`max(0, weeklyLimitUsd - usedUsd)` and does not subtract the pending estimate.
Admission checks actual weekly usage and limits request size, output and
concurrency. The final admitted reply may cross the weekly limit; its full
actual cost remains visible and subsequent requests are exhausted. The request
caps do not establish a formal maximum USD overage.

A pending current-week request returns `kind: free` with
`reason: free_request_in_progress`. Keep the managed provider and its credentials;
this is neither an upgrade requirement nor a provisioning failure. The proxy
returns HTTP 423 for a busy person, with no automatic retry/Retry-After or upsell.
An old-week pending request can still block admission even when this current-week
status shows an unused balance. Status is not admission authorization.

The route schema uses `z.enum(INFERENCE_ACCESS_REASONS)` from the shared inference
module, so its reason values follow the backend contract without a second list.
The generated OpenAPI operation ID is `getV1InferenceAccess`, with response
component `InferenceAccessResponse`. The existing `pnpm sdk:generate` pipeline
reads Den's current OpenAPI schema and updates `packages/sdk/src/gen`; run
`pnpm sdk:check` afterward. No separate catalog registration or handwritten SDK
method is needed. SDK regeneration belongs to the main integration handoff.

`canUpgrade` follows the existing owner/admin role hierarchy. `upgradePath` is a
fixed relative Den Web path for those roles, otherwise null; resolve it against
the configured Den Web origin, never an inference/provider URL. Members should
ask a workspace admin to upgrade. `GET/PATCH /v1/inference` remains admin-only.

Status aggregates by the authenticated **user ID**, not member, organization or
key: Den reads that person's current `InferenceFreeUsageBucketTable` row. No row
means unused allowance. A failed bucket read returns `accounting_unavailable`
with unknown usage/remaining fields, never an optimistic free balance.

Provision through the existing lifecycle:

- `GET /v1/llm-providers` (default `scope=usable`) enrolls/repairs the member's
  ordinary `source: openwork`, `providerId: openwork` provider.
- `GET /v1/llm-providers/:llmProviderId/connect` returns the existing connection
  shape and ordinary member inference bearer key. It checks current eligibility
  and repairs its own managed key. Ineligible callers with an existing grant get
  200 with null credentials, preserving the published desktop sync contract.
- Member-added hooks also provision free access after the joined membership is
  persisted; member removal revokes its keys and managed provider.
- Models remain discoverable through `GET /v1/llm-provider-catalog/openwork`,
  including paid entries for contextual upgrade UI. Catalog presence is not
  execution authority; the inference proxy rejects non-Luna free requests.

Enrollment/repair never writes desktop preferences, default models or paid
policies. Existing managed provider IDs, model rows and configuration survive
key repair and billing downgrade. BYOK/custom/catalog `lpr_*` providers and their
credentials are not modified. New-cohort default model selection belongs to
Desktop, not Den.

## Enrollment And Disablement

New organizations currently start with limits metadata, not an inference deny.
With rollout enabled, an active joined member in a never-subscribed organization
with no inference/offer metadata causes Den to persist
`inferenceFree: { offerAllowed: true }`. This is serialized with provider/key
repair under organization and member row locks. The key, provider and member
grant commit together, and repeated/concurrent repair reuses the valid key.

Explicit `inference.enabled: false` or `inferenceFree.offerAllowed: false` denies
free access. Malformed/unknown inference metadata does not enroll. Better Auth's
raw organization-create hook strips client-submitted `inference` and
`inferenceFree`; ordinary Den organization settings already allowlist fields.
After raw creation, Den stores the remaining metadata as an object in its JSON
column rather than Better Auth's text-column encoding, preserving unrelated
fields when enrollment adds the offer.

Admin `setInferenceEnabled(false)` persists `offerAllowed: false`, revokes all
organization inference keys and deletes only managed OpenWork providers. These
local changes commit before upstream paid-key deletion, so failure stays closed.

Stripe callers pass `source: billing`. Stopping paid inference removes its tier,
permits free fallback unless already administratively disabled, and revokes the
old member keys without deleting model/configuration rows. The next member read
repairs the key. Repeated downgrade events leave an already-free key alone.
Billing activation never undoes an explicit admin disable; an admin must enable
paid inference explicitly through the existing subscribed-only route.

**Legacy limit:** before this change, disablement deleted inference metadata.
For organizations with any inference subscription history and missing metadata,
the intent cannot be recovered safely. They do not auto-enroll on reads. A new
billing transition can record the offer, but old ambiguous records require an
explicitly reviewed migration/opt-in; this change does not run one or add an
opt-in UI.

Organization-wide shared-worker materialization has no authenticated person, so
it excludes free `source: openwork` keys rather than choosing a member's budget.
Paid managed inference and BYOK retain their existing path. Person-scoped cloud
worker support is deferred.

## Rollout And Checks

Mirror only these non-secret fields in Den and inference:

```text
INFERENCE_FREE_ENABLED=false
INFERENCE_FREE_WEEKLY_BUDGET_USD=1
INFERENCE_FREE_MODEL_ID=openai/gpt-5.6-luna
```

`INFERENCE_FREE_UPSTREAM_API_KEY` is never read or stored by Den. Den status is
an entitlement/accounting projection, not a probe of inference-secret readiness
or an admission guarantee. Deploy migration 0093 and configure inference before
enabling the mirrored rollout flags; this integration does not deploy or change
live settings.

Focused checks from `ee/apps/den-api` (existing dependencies required):

```sh
bun test --conditions development test/llm-provider-access-parity.test.ts
bun test --conditions development test/stripe-billing.test.ts
bun test --conditions development test/cloud-provider-materialization.test.ts
bun test --conditions development test/cloud-provider-materialization-read-retry.test.ts
bun test --conditions development test/route-access-policy.test.ts -t 'member inference access'
./node_modules/.bin/tsc --noEmit --pretty false
```

The provider-access test uses real local MySQL fixtures and mocks all external
fetches; it requires the migrated test database. It covers concurrent repair,
person-wide quota identity across two organizations, peer isolation, busy-provider
continuity, metered overage/exhaustion and blocked states, preserved
configuration/BYOK, billing fallback, admin and membership disablement, client
metadata spoofing, catalog visibility and the generated OpenAPI reason enum.
These focused checks are not final journey evidence. Integrated inference and
Desktop proof remains with the covering free-allowance journey.
