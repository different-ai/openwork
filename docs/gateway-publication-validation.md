# Gateway publication validation

Date: 2026-09-10. PR #4358. These are pre-publication checks on the combined
working tree based on `dc297aefe4be74c95ab42ea29f31f2c75e03989a`, not immutable
final-head receipts. Final-head results belong in the PR verification record.

## Scope

Organization-default-off Gateway dashboard capability, independent deployment
support, admin gating, Models compatibility, Helm 0.2.0 opt-in and upgrade
guidance. Earlier detailed reports are historical receipts; see
[independent validation](gateway-independent-validation.md) for combined fixes
and their regression evidence.

## Publication review and checks

- Final read-only review identified stale generated HTTP 403 error unions.
  Regenerated SDK types now include `gateway_not_enabled` as declared by the
  source schemas. Shared schema declarations also advertise that error on member
  routes even though those routes are not deployment-management gated.
- `pnpm sdk:generate` and `pnpm sdk:check`: exit 0, including SDK typecheck.
  Commands used a cleared environment, explicit fixture configuration and only
  a newly created owned MySQL 8.4 container/database. The container used tmpfs,
  had no bind mounts or volumes, and was removed after verified-identity cleanup.
  No shared or user database was accessed.
- Den Web, Den API and Gateway: `pnpm exec tsc --noEmit --pretty false --incremental false`
  (API/Gateway additionally `-p tsconfig.json`), each exit 0.
- `pnpm --filter @openwork-ee/den-web test`: 374 passed, 0 failed, 0 skipped.
- `pnpm evals:pr specs/managed-inference.test.ts`: exit 0, 1 passed.
- `pnpm evals:pr specs/inference-gateway-lifecycle.test.ts`: exit 0, 1 passed.
- `pnpm evals:pr specs/inference-gateway-org-provider.test.ts`: exit 0, 3 passed.
  All three PR journeys had zero failures/skips and ran serially. These runs
  loaded Vitest 3.2.7 before dependency alignment; rerun on the declared Vitest 4
  and published head before treating them as final-head proof. The direct PR
  command printed no placement line; none is invented here.
- Gateway and upgrade Helm shell matrices passed independently; see the
  independent report for exact case counts, broader render checks and limitations.
- Generated `ee/apps/den-web/tsconfig.tsbuildinfo` cache is excluded from the
  feature commit; it is not a test receipt.

## Desktop journey: failed environment attempts, not product proof

Command: `pnpm evals:e2e inference-gateway-desktop-sync`.
Placement: `placement: daytona (daytona CLI authenticated)`.

1. Exit 1, zero tests executed. First actionable error:
   `TypeError: project.vitest.getGlobalTestNamePattern is not a function`.
   Installed Vitest was 3.2.7; the rebased manifest declares 4.1.11. Running
   `pnpm --dir evals exec vitest --version` aligned the installed dependency with
   the lockfile and reported 4.1.11. No source workaround or lane switch was used.
2. Same command/lane on Vitest 4.1.11: exit 1, 0 passed, 1 failed, 0 skipped.
   First actionable error: provider creation HTTP 404 `{"error":"not_found"}`.
   Provisioning logs showed default ref `dev` at `326ff094`, rather than this PR.
   The desktop had not launched. The testkit deleted its newly owned Den sandbox.

Classification: environment-specific dependency mismatch and wrong-ref execution.
Neither is claimed pre-existing; no clean-control execution was performed. The
local runner receipt SHA is not proof of the deployed Den revision.

## Required pinned follow-up

After commit/push, run from a source checkout matching the published full SHA:

```sh
PR_SHA='<published-full-40-character-SHA>'
env -u OPENWORK_EVAL_DEN_API_URL -u OPENWORK_EVAL_DEN_WEB_URL \
  -u OPENWORK_EVAL_DAYTONA_DEN_SANDBOX \
  -u OPENWORK_EVAL_DAYTONA_DESKTOP_SANDBOX \
  -u OPENWORK_EVAL_ELECTRON_BINARY \
  OPENWORK_EVAL_REF="$PR_SHA" OPENWORK_EVAL_DAYTONA_REF="$PR_SHA" \
  pnpm evals:e2e inference-gateway-desktop-sync --daytona
```

`OPENWORK_EVAL_REF` pins both Den and Desktop in this legacy spec. Dirty source is
not uploaded automatically; the local harness/start script must match the same
revision. Do not substitute a local lane for a red Daytona result.

## Verdict boundary

**Incomplete for rollout.** Scoped component/API/Helm checks do not prove real
Den Web network behavior, a desktop-sync journey, an installed-cluster upgrade,
production packaging, live origins/TLS, or deployment readiness. No production
deployment, shared database migration, secret rotation or existing-service
restart is part of this validation.
