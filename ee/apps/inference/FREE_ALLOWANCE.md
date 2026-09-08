# Free Standard Luna

Approved policy: **"Usage-metered allowance (Recommended)"**. Check server weekly
actual usage before a request, cap request size/output and concurrency, and settle
actual cost. The final in-flight reply can exceed USD 1. This is not a mathematically
strict USD 1 spending cap; no formal maximum overage is promised.

Free access is an entitlement, not a model discount. The managed alias/upstream
is `openai/gpt-5.6-luna`, with the original catalog prices and usage factor 1.
Paid organization limits, paid provider credentials and BYOK are unchanged.

## Server Configuration

Mirror these non-secret settings in Den and inference:

```text
INFERENCE_FREE_ENABLED=false
INFERENCE_FREE_WEEKLY_BUDGET_USD=1
INFERENCE_FREE_MODEL_ID=openai/gpt-5.6-luna
```

Enable the flag when configuring the offer. The default remains off for an
unconfigured installation; there is no permanent pricing-unavailable gate.
The enabled flag accepts `true`/`false` or `1`/`0`. The budget is finite,
nonnegative, and safely representable in integer inference units. Zero disables
admission through exhaustion. Only the reviewed standard Luna alias is accepted.

Set `INFERENCE_FREE_UPSTREAM_API_KEY` only in inference's server environment.
No organization upstream key or paid subscription is provisioned for free users.
Free requests use that credential only at
`https://openrouter.ai/api/v1/chat/completions`; redirects and provider fallbacks
are disabled. Missing credentials never fall through to a paid organization key.

Configure OpenRouter usage export to `/webhooks/openrouter`, authenticated by
`INFERENCE_WEBHOOK_SECRET`, as the fallback when response usage is missing or
cannot be settled. Neither secret belongs in status responses or client config.
Apply the additive `0093_free_inference_allowance` migration before enablement.

## Den Contract

Shared exports are in `@openwork/types/den/inference`:

- `readFreeInferenceConfig(process.env)` returns validated non-secret settings.
- `inferenceAccessMode(metadata)` gives paid tiers precedence. Den explicitly
  writes `metadata.inferenceFree = { offerAllowed: true }` for eligibility and
  preserves `{ offerAllowed: false }` on administrative disable. An absent paid
  subscription does not itself authorize the free server key.
- `freeInferenceWindow(now)` selects Monday 00:00 UTC through the next Monday,
  exclusive, without rollover. SQL's clock selects the admission window.
- `freeInferenceAccess({ config, mode, bucket, now })` returns `InferenceAccess`.
  Den reads `InferenceFreeUsageBucketTable` for the authenticated `user_id` and
  current `window_start_at`, retaining its ordinary active-membership checks.
  Den adds role-based `canUpgrade`; it does not import inference app source.

`usedUsd` is settled actual cost. `reservedUsd` is an **estimated pending cost**,
not money already spent, a cost ceiling, or extra available budget.
`remainingUsd = max(0, weeklyLimitUsd - usedUsd)` deliberately does not subtract
that estimate. `usedUsd >= weeklyLimitUsd` is `exhausted`, not an accounting error.
A current-week hold returns `kind: free, reason: free_request_in_progress`, so a
busy request does not remove the provider or revoke the person's entitlement.

The current-week status projection cannot discover an old-week pending request.
The proxy's SQL admission checks all weeks and returns `free_request_in_progress`
for that case. Status is a read-only projection, not admission authorization.
The new week can show its untouched balance while an earlier receipt is awaited.

Issue ordinary active member keys and the existing `openwork` provider without
setting a paid tier. The proxy rechecks active key, membership organization,
removal status, user identity and offer eligibility inside admission. Maintain
all canonical Den authentication and membership checks.

## Admission And Settlement

`free-allowance.ts` uses the existing `user` row as a transaction-scoped person
lock. Different keys, memberships, organizations, devices and weeks share that
lock. Admission checks for any `held` or `invalid` reservation across that person's
history; at most one unsettled request is permitted, even at a weekly boundary.

For an eligible person with no pending request, admission conditionally updates
the current bucket only when `used_amount < limit_amount`, `reserved_amount = 0`
and the bucket is not blocked. It inserts the matching immutable request record
in the same transaction, before sending upstream. A positive estimate is stored
as `min(estimatedCost, limit - used)`, with at least one integer unit. Even one
unit of actual balance admits the normal capped reply; there is no minimum prompt
cost floor and no output reduction based on that tiny remaining balance.

All amounts use `INFERENCE_USAGE_CONVERSION_FACTOR = 100000000`. Each reservation
pins person, original week, organization, membership, key, model, output cap and
estimated prices. The existing `input_token_cap` database column stores the input
token **estimate** under this policy; it is not a provider-enforced input cap.
Weekly limits are snapshotted on first admission; budget changes apply to newly
created windows, not already-open ones.

`free-response.ts` observes only the authenticated OpenRouter response on the free
path. A non-streaming completion needs a matching model, generation ID, terminal
choice and finite nonnegative `usage.cost`. For SSE, it also requires a complete
final usage event and `[DONE]`. It parses fragmented UTF-8/SSE incrementally with
bounded buffering, forwards original bytes, and settles before forwarding the
completed DONE event so the next engine tool turn can acquire the person slot.

Response usage and authenticated webhook usage share `settleFreeInference`.
Settlement locks the same person, request and original bucket, then atomically
clears the estimated hold and adds actual provider cost. Actual cost may exceed
both the estimate and the weekly limit. The next request then receives exhausted
status. Request/generation deduplication prevents response/webhook races from
charging twice. Invalid identities, model mismatches, missing/negative/non-finite
costs and conflicting receipts never release a held request or mint a refund.
Counter corruption or unsafe integer totals block accounting for investigation.

Cancellation, upstream errors, malformed/truncated responses, missing costs and
failed settlement retain the hold. There is no timeout or weekly-reset refund.
A valid late receipt can settle after key revocation or a paid upgrade and charges
only the original window. It does not consume the new week's money. Until that
receipt arrives, new free admissions remain blocked across all keys/orgs/weeks.
Paid usage never enters these free tables, and free usage never enters paid buckets.

## Request Limits And Estimates

- Actual wire body: at most **131072 bytes**, enforced before parsing JSON without
  trusting Content-Length.
- Supplied messages, tool schemas and structured-output schema: at most **32768
  UTF-8 bytes** of compact JSON. Oversized input is rejected, never silently trimmed.
- Total output: at most **4096 tokens**, including reasoning, or the caller's
  smaller requested maximum. One completion; standard model only.
- Ordinary text, function tools, parameterless functions, null/empty tool lists,
  structured output and typed reasoning history are supported. Non-text inputs,
  plugins, server tools, arbitrary model/routing selectors, pro mode and unsupported
  per-call features are rejected before admission.

The display estimate uses supplied input bytes plus 1024 framing tokens, 64 per
message and 256 per tool. It uses the highest checked-in input/cache-write and
output rates across context tiers: currently USD 0.50 and USD 1.80 per million.
For a simple `Hello` request this is approximately 0.8 cents including the full
4096-token output allowance. This is an estimate, not a guarantee or actual charge.
Input framing, schema expansion and restored reasoning may differ. The final
admitted reply can cross the weekly limit; its measured cost is retained in full.
Request and output caps constrain ordinary requests, but do not establish a formal
USD overage bound. Token-rate routing ceilings and zero per-request routing price
remain defensive preferences, not a strict total-spend guarantee.

The input contract was checked against OpenCode `v1.18.18` and its pinned
`@openrouter/ai-sdk-provider@2.9.0`, including a fresh serializer request sent only
to a deterministic fetch fixture. `reasoningEffort`, `textVerbosity`, canonical
`reasoning.effort`, `usage.include`, array-form system content and function/tool
history survive. The estimate is not used to alter those messages or reasoning.

## Errors And Checks

| HTTP | Code | Meaning |
| --- | --- | --- |
| 402 | `managed_model_requires_upgrade` | A different known managed model was selected. |
| 402 | `free_allowance_exhausted` | Actual weekly usage reached/exceeded the allowance. |
| 423 | `free_request_in_progress` | Another free request is running or awaiting usage; wait and retry manually. `retryable: false`, no Retry-After, no upsell. |
| 400 | `unsupported_free_inference_input` | Invalid/unsupported input, not an upgrade request. |
| 413 | `free_inference_input_too_large` / `free_inference_request_too_large` | Explicitly shorten input; nothing was trimmed/sent. |
| 503 | `free_inference_unavailable` | Missing configuration or unavailable accounting, not a tokenizer gate. |

Fast checks using existing dependencies, without triggering an install:

```sh
node --conditions=development --import ./ee/apps/inference/node_modules/tsx/dist/loader.mjs --test ee/apps/inference/test/*.test.ts
node ee/apps/inference/node_modules/typescript/bin/tsc -p ee/apps/inference/tsconfig.json --noEmit
```

The main integration journey should use the real inference service, isolated
MySQL and a deterministic upstream fixture. Seed a real `AuthUserTable` row plus
two active memberships/keys for that same person and another person's identity.
Assert one winner under concurrent admissions, same-person cross-org exclusion,
independent second-person access, a final over-budget reply, exhausted retries
without upstream calls, missing-cost holds across rollover, late original-week
charging, and response/webhook duplicate settlement. The existing schema suffices;
no additional migration or live provider call is required. Colocated tests are
fast checks, not a substitute for that real database journey.

For the fixture, register the real `registerProxyRoutes` and
`registerWebhookRoutes` handlers on the test HTTP server, supply the real key,
admission and settlement functions backed by the isolated database, and inject
only the upstream `fetch`. The free credential destination remains pinned in
production; do not relax that allowlist to run the journey. Return a matching
`id`/`model`, terminal choice and `usage.cost`; streaming fixtures also send the
final `[DONE]`. Omit cost deliberately for the awaiting-usage/rollover case.
