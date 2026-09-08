# DPA organizations and company-provided Models

## Policy and storage

The existing `organization.metadata` JSON column holds the decision. No migration,
new column, or new table is required. The canonical top-level key is a boolean:

```json
{
  "dpaSigned": true,
  "inference": { "enabled": true, "tier": "tier1" },
  "unrelatedSetting": { "retained": true }
}
```

The shared contract is `@openwork/types/den/managed-models-policy`.

- `dpaSigned: true`: company-provided OpenWork Models are forbidden.
- Missing `dpaSigned` or explicit `false`: existing eligibility is unchanged.
- Any present non-boolean value, malformed metadata, an array/scalar document,
  a missing organization, or a failed policy lookup: do not authorize Models.
- A known organization's SQL-null metadata is an empty metadata document.
- The reader also supports legacy serialized JSON objects written through
  Better Auth. Writers persist an object in the JSON column, not serialized JSON.

This is organization-scoped. The inference key's authenticated organization is
authoritative; request bodies, organization headers, another membership, provider
names, and model aliases cannot select a different policy scope.

## Trusted administration

Use the existing Den authenticated platform-admin API:

```http
PATCH /v1/admin/organizations/{organizationId}/dpa
Content-Type: application/json
Authorization: Bearer <authorized internal credential>

{"dpaSigned":true,"reason":"Internal approval reference"}
```

The caller must be an authenticated user on the platform-admin allowlist. Being
an organization owner or administrator is insufficient. The body is strict:
`dpaSigned` is a required boolean; `reason` is trimmed, 3–500 characters; additional
fields are rejected. Use `false` through this same operation to unset.

Successful response:

```json
{"ok":true,"organization":{"id":"<organizationId>","dpaSigned":true}}
```

The operation locks and rereads the current organization row, preserves all other
metadata, and atomically inserts `organization.dpa_signed.updated` into the
existing audit table. Audit payload: `previousDpaSigned` (boolean, or null when
absent/non-boolean), `dpaSigned`, and `reason`; actor comes from authentication.
An audit insert failure rolls the metadata change back. Do not put confidential
legal correspondence in the reason or organization metadata.

Ordinary organization create/profile APIs accept named fields and reject injected
metadata/DPA fields. Raw Better Auth creation rejects the reserved key (including
false); metadata replacement through Better Auth is rejected, including an empty
object that would erase the decision. Existing general metadata writers reread
under row locks, so a stale settings/plan/billing snapshot cannot erase the flag.
Corrupt top-level metadata is not normalized into an authorizing empty object.
Repair a corrupt document through a separately reviewed internal maintenance
change; this endpoint does not guess how to recover unrelated data. A readable
object with an invalid flag can be repaired explicitly through this audited API.

No production SQL workaround or automatic production rollout is provided.

## Enforcement and errors

The inference service performs an **uncached database policy check** after key
authentication (before catalog/body processing), and another immediately before
its sole upstream fetch, after quota, upstream-key, and analytics awaits.

| Condition | Status | Code |
| --- | --- | --- |
| DPA signed | 403 | `managed_models_disabled_for_dpa` |
| Policy cannot be verified | 503 | `managed_models_policy_unavailable` |

The inference API uses its existing OpenAI-style envelope:

```json
{
  "error": {
    "type": "invalid_request_error",
    "code": "managed_models_disabled_for_dpa",
    "message": "Company-provided OpenWork Models are unavailable for this organization because a DPA is signed. Permitted customer-key providers and AI Gateway may still be used."
  }
}
```

Den enable/checkout APIs use their existing `{ "error": "<code>", "message":
"<explanation>" }` convention with the same 403/503 status. Unauthenticated or
invalid-key requests retain their existing authentication errors.

Managed member-key/provider provisioning is serialized with metadata marking by
locking the organization row and checking current policy in the same transaction
as the key, provider, and grant writes. Read/repair/member-join paths skip denied
managed provisioning. Enablement rereads policy in its metadata transaction.
Inference purchases check before Stripe work and immediately before checkout
dispatch. Late successful checkouts/webhooks still record subscription history,
but DPA denial does not activate Models or cause endless policy-denial retries.
An unavailable policy remains a retryable failure.

Usable provider lists, resource snapshots, and Web materialization exclude
company-managed (`source: openwork`) configurations when policy denies them.
Automation model authority rejects the OpenWork Models branch. In a list/connect
race, direct managed connect deliberately stays HTTP 200 with null credentials,
empty models, `memberCredential.state: blocked`, and `managedModelsPolicy` denial,
so older desktops do not abort unrelated BYOK synchronization.

These inventory checks are not the security boundary: even an old, renamed,
manually copied, or locally cached managed key still reaches the policy-enforcing
inference proxy. A customer-owned `custom`/`models_dev` provider using OpenRouter,
OpenAI, or overlapping branding remains permitted. No hostname blacklist is used.

## Caches and in-flight work

- There is no managed-policy decision cache to invalidate. Both inference reads
  use the database, not cached entitlements, sessions, catalogs, or provider data.
- The marker does not revoke keys, force sign-out, rotate BYOK credentials, cancel
  subscriptions, issue refunds, or delete providers/history. Unsetting restores
  policy eligibility; all other existing access and entitlement checks still apply.
- Desktop/Web inventories may remain visually stale until normal reconciliation.
  Such stale entries cannot bypass the proxy. No UI redesign or silent fallback
  to a different provider is introduced.
- A request paused in preparation is checked again before dispatch. Client retries
  are new requests and repeat policy checks. The proxy has no internal model retry
  or fallback; redirects are rejected rather than following an unchecked dispatch.
- Requests already transmitted upstream cannot be recalled and may finish,
  including streaming responses. This is not a distributed cancellation/drain
  protocol: the final policy read is the admission point. A change racing after
  that read cannot retract an already-admitted fetch or bytes queued by the HTTP
  transport. Do not claim the setter's return is a cross-replica egress barrier.
- An upstream management-key create already transmitted before marking can finish
  afterward; attachment to the organization is denied on the locked recheck. This
  can leave an unattached upstream key requiring authorized internal reconciliation.
  It is not automatically revoked. Similarly, a Stripe customer/session already
  created or dispatched is not automatically canceled; later activation is blocked.

Continuing charges, subscription cancellation, refunds, and stricter draining of
already-admitted work require separate business/engineering decisions.

## Safe staging rollout/check procedure (not executed)

1. Deploy the shared package and enforcement to **all staging inference replicas**,
   then staging Den's guarded writers/admin/provisioning routes. Do not rely on
   marking while any old inference binary is still serving. No schema migration.
2. Use synthetic staging organizations and deterministic local upstream witnesses;
   never real customer prompts or paid inference. Keep one unmarked control org and
   the same synthetic user in both organizations. Issue a managed key before marking.
3. Run `pnpm evals:pr specs/managed-models-dpa.test.ts` on the exact candidate tree.
   Inspect every assertion and confirm zero external HTTP attempts.
4. Through the allowlisted staging admin API above, set true with an internal
   reference. Verify the audit row, preservation of unrelated metadata, and 403
   plus zero witness dispatch for the old key on every serving replica. Verify
   ordinary owners cannot clear the marker and checkout/repair cannot restore use.
5. Verify customer-key Gateway routing, including an OpenRouter-branded provider,
   remains usable; verify control-org managed access remains usable. Exercise a
   running staging desktop/Web session and automation before and after marking to
   observe inventory reconciliation as well as the authoritative inference denial.
6. Unset only with approved staging authority, verify a second audit transition and
   original-key access if otherwise entitled, then restore the intended test state.
7. Before any separately authorized production rollout, review billing treatment,
   monitor 403/503 rates, and obtain explicit organization-specific authorization.
   Rollback must retain enforcement on every serving inference replica for marked
   organizations; rolling back to an unaware binary would reopen their access.

See `docs/pr-proof/dpa-opt-out.md` for the local verification record and its limits.
