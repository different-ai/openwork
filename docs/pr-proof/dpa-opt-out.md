<!-- test-evidence -->
# DPA managed Models: local implementation and verification

Date: 2026-09-08. Branch: `dpa-opt-out`. Starting HEAD:
`5f8a802cacc36003aca7d9a2a0283048bb3c1b78`.
This records the initial **pre-commit verification**; these receipts identify the
starting SHA and were run against the modified working tree. PR-head verification
is rerun after committing and published in the PR's test-evidence comments. No
deployment, live organization mutation, or live key revocation was performed.

## Boundary verdict: Passed

```text
pnpm evals:pr specs/managed-models-dpa.test.ts
placement: local (testkit resolvePlace; isolated app-less Den and inference)
exit 0; 1 passed; 0 failed; 0 skipped; 17 assertion groups passed
```

Final cold run: 29.64 seconds total, 29.00 seconds test time. Runner-selected
placement, no forced local flag or reused Den.

Receipt (worktree-relative):
`evals/results/test-runs/2026-09-08T18-12-14-560Z-dpa-policy-blocks-warm-managed-keys-without-revoking-customer-owned-models-or-an/test-run.json`

The receipt records each assertion's result and explanation. This new spec is a
genuinely new legal-policy access lifecycle journey, not another analytics or
team-role journey. It reuses the existing Models world and upstream witness;
the spec calls real HTTP boundaries rather than importing product source.

### Observed assertions

1. Absent flag permits a real DB-backed managed key and one authenticated upstream
   completion.
2. Only allowlisted platform admins can set/unset; owner/member/foreign/anonymous
   attempts and invalid bodies do not change metadata or audits.
3. The same warm key/session is denied after marking. Spoofed organization inputs,
   retries, and fallback payloads produce zero upstream dispatches. The same user's
   distinct key in a second organization remains usable.
4. A datastore-arranged managed-provider rename does not turn it into BYOK.
5. Provider inventory/resource discovery hide managed entries; direct connect is
   compatible and redacted. Enable/default/explicit inference checkout deny without
   new keys or external HTTP attempts.
6. GET repair cannot recreate arranged missing managed access.
7. Actual invitation acceptance under DPA creates no managed key/provider.
8. Owner/member/newcomer receive usable customer-key provider configurations despite
   OpenRouter/OpenWork branding; their delivered endpoint/model/key reach the BYOK
   HTTP witness successfully, while managed use stays forbidden.
9. Ordinary and raw Better Auth metadata writes cannot set/erase the decision.
10. Approved explicit-false unset restores the original key and records the actor,
    previous state, new state, and reason.
11. A real audit-storage failure rolls back the DPA update.
12. Concurrent branding, capability, and DPA updates preserve the marker and nested
    unrelated metadata.
13. Legacy serialized true denies; malformed documents, all tested non-boolean
    flags, and a real policy-storage read failure return 503 with zero dispatch.
14. A SQL witness proves a request passed initial admission but waits on limits;
    marking before release causes pre-dispatch 403 with zero upstream calls.
15. An already-started checkout sync held across marking records purchase history
    without restoring Models.
16. Signed late/duplicate checkout-completion webhooks retain history without
    activation; an invalid signature fails before SDK reads/history changes.
17. Synthetic-only credentials, guarded subprocess egress, zero external HTTP
    attempts, and expected authentication on every observed upstream call.

Stripe's SDK HTTP transport is redirected only in the eval subprocess to a local
witness; actual billing handlers and signature verification remain unchanged.
The test's destructive storage-fault arrangements apply only to its disposable
testkit database, never an existing service or organization.

## Additional verification

| Command | Result |
| --- | --- |
| `pnpm evals:pr specs/team-organization-admin.test.ts` | Exit 0; 1 passed, 0 failed, 0 skipped; 26.21s. This runner emitted no placement line. |
| `NODE_OPTIONS=--conditions=development pnpm --dir ee/apps/inference exec tsx --test test/proxy.test.ts` | Exit 0; 58 passed, 0 failed, 0 skipped. Supplementary unit checks, not boundary proof. |
| `pnpm --filter @openwork/types build` | Exit 0; JS and declaration build passed. |
| `pnpm --dir ee/apps/inference exec tsc -p tsconfig.json --noEmit` | Exit 0. |
| `pnpm --dir ee/apps/den-api exec tsc --noEmit --pretty false` | Exit 0. |
| `git diff --check` | Exit 0. |

Organization-admin regression receipt:
`evals/results/test-runs/2026-09-08T18-13-53-588Z-team-admin-grants-are-live-scoped-protected-and-cleared-across-scim-lifecycles/test-run.json`

Additional executor-run supplementary suites: Stripe 38 passed; automation model
authority 6 passed; materialization 28 passed. No runtime acceptance claims rest
solely on these tests or temporary diagnostic harnesses.

### Broader checks: failed, reproduced on clean control

Same Node 24.18.0, pnpm 11.4.0, TypeScript 5.9.3 and inherited environment; clean
detached worktree at the starting HEAD above, offline frozen installs. The control
was removed cleanly afterward. No unrelated fixes were made.

| Exact command | Working tree / clean control | Identical diagnosis |
| --- | --- | --- |
| `pnpm --dir evals exec tsc -p tsconfig.primitives.json --noEmit` | Exit 2 / 2 | Six TS2550 errors: `Promise.withResolvers` absent from ES2023 library; `worlds/first-run.ts` lines 168/169/176 and `worlds/session-shell.ts` lines 504/508/517. |
| `pnpm exec node evals/scripts/spec-boundary-ratchet.mjs` | Exit 1 / 1 | Fourteen violations in five other specs; no violation for the new DPA spec. |

Ratchet files: `bench-opencode-engines.test.ts`,
`bench-openwork-app-v1.e2e.test.ts`, `engine-v2-preview-flag.e2e.test.ts`,
`opencode-v2-chat-routing.e2e.test.ts`, `opencode-v2-provider-hot-inject.test.ts`.
First identical failure: `bench-opencode-engines.test.ts: imports product source`.

Earlier local DPA runs exposed fixture arrangement/expectation errors. Subsequent
review exposed a non-boolean flag authorization gap and an incorrect permissive
test expectation; both were corrected. Only the final receipt above supports
this boundary verdict.
The introduced `erasableSyntaxOnly` parameter-property error was also fixed.

## Remaining validation and operational limits

- This is **server-boundary proof**, not a full desktop/Web/automation UI-runtime
  certification. BYOK proof uses an HTTP client with Den-delivered configuration,
  not a real Gateway/OpenCode runtime. Web materialization and automation guards
  have supplementary checks but no new live-runtime journey in this change.
- The existing analytics UI journey was preserved but not rerun. No claim about
  immediate picker cleanup, runtime credential erasure, or cancellation is made.
- Missing-organization handling is fail-closed in code; the boundary exercises an
  actual metadata read failure rather than manufacturing a foreign-key-invalid
  dangling key row.
- Policy has no cache. The final fresh read is dispatch admission, not an atomic
  distributed egress/drain barrier; already-admitted/transmitted requests are not
  canceled. See the runbook for exact race and upstream-provisioning limits.
- Broad eval typecheck/ratchet are not green. Although their failures are verified
  pre-existing, repository-wide validation is not a Passed claim.
- Billing cancellation/refunds and upstream orphan-key reconciliation require
  separate approval. No feature is claimed active for any live organization.

## Changed files

Shared contract:
- `packages/types/src/den/managed-models-policy.ts`
- `packages/types/package.json`
- `packages/types/tsup.config.ts`

Inference boundary and supplementary tests:
- `ee/apps/inference/src/keys.ts`
- `ee/apps/inference/src/proxy.ts`
- `ee/apps/inference/test/proxy.test.ts`

Den policy, trusted administration, and protected metadata writers:
- `ee/apps/den-api/src/organization-metadata.ts`
- `ee/apps/den-api/src/organization-limits.ts`
- `ee/apps/den-api/src/orgs.ts`
- `ee/apps/den-api/src/auth.ts`
- `ee/apps/den-api/src/audit-events.ts`
- `ee/apps/den-api/src/openwork-web-access.ts`
- `ee/apps/den-api/src/routes/admin/index.ts`
- `ee/apps/den-api/src/routes/bootstrap/index.ts`
- `ee/apps/den-api/src/routes/org/core.ts`
- `ee/apps/den-api/src/mcp/admin-tools.ts`
- `ee/apps/den-api/scripts/seed-demo-org.ts`

Den provisioning, purchase, and provider delivery:
- `ee/apps/den-api/src/inference.ts`
- `ee/apps/den-api/src/stripe-billing.ts`
- `ee/apps/den-api/src/routes/org/inference.ts`
- `ee/apps/den-api/src/routes/org/billing.ts`
- `ee/apps/den-api/src/routes/org/llm-providers.ts`
- `ee/apps/den-api/src/routes/org/resources.ts`
- `ee/apps/den-api/src/routes/webhooks/stripe.ts`
- `ee/apps/den-api/src/llm/cloud-provider-materialization.ts`
- `ee/apps/den-api/src/automations/authority.ts`

Boundary journey and deterministic witnesses:
- `evals/specs/managed-models-dpa.test.ts`
- `evals/worlds/models-analytics.ts`
- `evals/packages/labs/src/models-analytics-fixture.mjs`
- `evals/packages/labs/src/models-egress-guard.mjs`

Documentation:
- `docs/features/managed-models-dpa.md`
- `docs/pr-proof/dpa-opt-out.md`
