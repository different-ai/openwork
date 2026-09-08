# Managed usage settlement

This follow-up accounts for work already admitted by managed inference. It does
not introduce budgets, reservations, free-model allowances, price changes or a
reconciliation scheduler. Response handling remains separate in #4471.

## Durable identity and time

Admission samples one timestamp while holding the organization policy lock and
uses it to choose the allowance buckets. The proxy forwards that same timestamp
in its server-owned trace, including when provider-key lookup crosses a reset.

Every provider receipt resolves one existing `openrouter_usage` identity before
pricing or settlement. Organization, membership, inference key and request must
match. The first durable timestamp and priced cost remain authoritative on replay;
changed delivery IDs, later timestamps and different reported costs cannot charge
the request again or move it to a new window.

Nullable provider facts distinguish `unpriced` from `priced`. Absent, null or blank
prices are unknown, never fabricated zero costs. A complete later receipt promotes
the same unpriced row under its lock; a priced row never becomes unpriced again.
`priced` means monetary facts are known, not that every historical charge exists.

## Settlement and reset

Settlement uses the three original historical windows, even when exhausted. It
never advances current window pointers, rewrites limits, provisions credentials or
grants generation access. Revoked keys may settle attributable earlier work using
the identity-matched durable timestamp. New requests still obey current DPA and
access policy.

Admission, Den's bucket writer, settlement and admin reset take policy locks in the
same order. Per-bucket charge identities make concurrent retries idempotent and
permit repair of a genuinely missing charge. Admin reset subtracts known usage but
keeps zero-amount charge identities, so a receipt replay cannot undo forgiveness.
Reset retains its existing scope: known charges in the current windows, not blanket
amnesty for usage whose price has not arrived.

Old reset implementations deleted charge identities. For legacy ledger entries
without provider facts, a missing charge cannot safely be distinguished from an
intentional reset. Those gaps are durably deferred rather than silently backfilled.
Missing or overlapping historical windows are also deferred, never guessed.

Webhook responses distinguish `ingested`, `deferred`, `skipped`, `invalid` and
`failed`. Durably retained unpriced/ambiguous usage is acknowledged as deferred;
explicitly invalid attribution is not accepted as another identity's charge.
Malformed usage receives 400; transient persistence failures receive retryable 503.
Resource-, scope- and span-level OTLP attributes use the same validation path.

## Migration and proof

Apply `0094_managed_usage_facts.sql` before deploying readers/writers. It adds one
nullable JSON column; existing entries remain null. The generated snapshot is
schema metadata, not a new ledger. Reconcile numbering against current dev before
merge. The existing conversion factor, minimum-unit rounding and allowances remain
unchanged.

`pnpm evals:pr specs/paid-usage-settlement.test.ts` uses real Den/admin-reset and
inference HTTP routes with disposable SQL and a controlled provider. It covers the
real migration runner and no-op rerun, concurrent receipts and bucket writers,
reset/replay races, unpriced promotion, ambiguous history, admission-time rollover,
revocation/DPA boundaries and unchanged neighboring usage.

Live provider broadcasts and production upgrades are not certified by the fixture.
In-flight overspend and missing receipts remain separate concerns. This patch has
shared integration surfaces with #4358, #3648 and #4620; it imports none of their
unmerged gateway, status-rollover or free-allowance implementations.
