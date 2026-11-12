# Pruning low-value tests

This pass removes tests that pin implementation or presentation choices rather
than an independently useful product contract. It changes no shipped code,
feature defaults, required-check configuration, or core journeys.

## Keep

- Authorization, tenant isolation, billing, secret handling and OAuth boundaries.
- Explicit feature overrides that exercise different behavior, not merely read
  the feature registry's default.
- Generic feature-resolution precedence and kill-switch behavior.
- Runner state transitions, event ordering, interruption, failure handling,
  approvals and external side effects.
- Release and installer checks: a broken release can strand users even when
  product unit tests pass.

## Remove

- Lists of literal feature defaults or retired rollout names repeated in tests.
- Tests that read source text to assert implementation spelling or layout.
- Pure label, sentence, icon and display-order assertions without a behavioral
  contract.
- Small presentation-only helpers whose expected output restates their input.

A test mentioning a flag, label or source file is not automatically low value.
Review its assertions before deleting it. A failing test is not a reason to
remove it; a lost security or behavior assertion needs an explicit replacement.

## Scope

Only reviewed test cases/files and their now-unused imports and explicit CI
references are removed. One-off E2E proofs and spec lint are unchanged. This is
a maintenance/churn reduction, not a measured CI speedup: no before/after CI
runtime comparison has been made.

## Reviewed cuts

| File | Cut | Coverage retained |
| --- | --- | --- |
| `packages/features/src/resolve.test.ts` | 14 cases plus literal-default/retired-key assertions in mixed cases | Registry/schema coverage, defaults derived from the registry, precedence, kill switches, locks, explicit overrides, deployment restrictions and environment validation |
| `ee/apps/workbot/scripts/browser-rollout.test.ts` | Entire file: duplicate registry-default loop | Generic feature resolution tests above; explicit disabled behavior elsewhere |
| `ee/apps/workbot/scripts/round-two.test.ts`, `scroll-feature.test.ts` | One registry-default loop in each | Task recovery, frame isolation/expiry, authorization invalidation and scroll endpoint behavior |
| `ee/apps/workbot/scripts/working-status.test.ts` | Two prompt-wording cases | Task lifecycle, interruptions, stream behavior and status event projection |
| `ee/apps/workbot/scripts/steps.test.ts` | Four prompt/label cases; prompt-only assertions in an output case | Transcript construction, output deduplication, explicit Apps-off behavior and Drive-file computer gating |
| `ee/apps/workbot/scripts/browser-card.test.ts` | Standalone finished-summary copy table | Live/stored/reloaded card identity, completion and failure handling |
| `ee/apps/workbot/scripts/connector-steps.test.ts` | Browser fixture equals transcript-builder case | Internal-ID sanitization, live/stored events and per-person connector cache isolation |
| `ee/apps/workbot/scripts/profile-apps.test.ts` | Empty-state sentence and logo markup cases | Usable-app listing and fallback to everyday connections |
| `ee/apps/workbot/scripts/command-palette.test.ts` | Highlighted text-run snapshot | Search ranking, bounded recents, unreadable storage and protected endpoint behavior |

| `ee/apps/den-web/app/(den)/dashboard/_components/team-section-groups.test.ts` | Entire file: four grouping/copy cases | Team roles and permission-transition tests in the same helper runner |
| `ee/apps/den-web/app/(den)/dashboard/_components/connector-picker-sign-in-note.test.ts` | Entire file: three note-label cases | OAuth URL, account authorization, readiness and auth-routing tests |
| `ee/apps/den-web/app/(den)/dashboard/_components/config-blobs/config-blobs-model.test.ts` | Five grouping, filename, breadcrumb, heading and sentence-formatting cases | Import validation, approval rules, removal/restore safeguards and execution-state presentation |
| `ee/apps/den-api/test/credential-prompt.test.ts` | One constant capability-availability case | Secret exclusion, sanitized destinations, human-only credential routes and machine-secret refusal |
| `ee/apps/den-api/test/last-sign-in-method.test.ts` | One source-text/retired-flag case | Remember/forget decisions, scoped cookie writes and expiration |
| `ee/apps/den-web/app/(den)/_lib/last-sign-in.test.ts` | Two component-source-shape cases | Remembered-method cookie parsing |
| `apps/server/test/inference-node-export.test.mjs` | One export-manifest/build-source case | Actual plain-Node import from a packaged `node_modules` layout |
| `ee/apps/den-api/test/api/remote-devices.api.test.ts` | One assertion pinning the `computerUse` default inside the team-computers case (red since the GA-defaults change) | The whole case: owner/admin inventory, member 403s, private-data redaction and cross-organization refusals |

**Total: 45 test cases removed; three test files deleted.** Mixed-case edits
also remove redundant literal defaults and prompt-copy assertions. The tally
counts executable `test`/`it` cases, not individual assertions.

Deleted-file references are removed from their declared runners rather than
leaving broken test commands or adding skip/soft-fail rules.

## Verification

Run on Node 24.22.1, with zero failures or skips in these focused checks:

- `pnpm --filter @openwork/features test`: 12 passed.
- `pnpm --filter @openwork-ee/workbot test:steps`: 42 passed.
- `pnpm --filter @openwork-ee/workbot test:events`: 21 passed.
- Focused batch of nine surviving Workbot script test files: 52 passed.
- `pnpm --filter @openwork-ee/workbot test:profile-apps`: 2 passed.
- Exact retained den-web helper command from `.github/workflows/ci-tests.yml`:
  151 passed.
- Credential-prompt and last-sign-in-method Den API unit tests: 13 passed.
- `node --test apps/server/test/inference-node-export.test.mjs`: 1 passed,
  after building `@openwork/types`.
- Deleted-file executable-reference check and `git diff --check`: passed.

The commands overlap; do not sum them as unique tests. No full CI or security
integration-suite verdict is claimed. Existing failures in unrelated dev jobs
are not fixed or hidden by this pruning.
