# Independent integrated Gateway validation

Date: 2026-09-10. Worktree: `inference-support-per-org-destinations`.
HEAD remained `dc297aefe4be74c95ab42ea29f31f2c75e03989a`; verification included
the integrated uncommitted changes, not just HEAD or another agent's report.

## Verdict

**Incomplete for rollout.** Final scoped automated suites and source typechecks
pass. Two reproduced Web defects and an unsafe unit-test database dependency were
repaired. The runtime-owned origin-transition concern was subsequently repaired
in the runtime-owner follow-up below. Browser,
Electron, production builds, migration/cutover and deployment were not exercised.
No commit, push, rebase, reset, staging, branch change, PR mutation, live database
operation, deployment, or restart of an existing service was performed.

## Findings and repairs

1. **P1, repaired: queued reauthentication could replay a mutation in the wrong
   workspace.** `ee/apps/den-web/app/(den)/dashboard/_providers/org-dashboard-provider.tsx`
   queued a closure from workspace A, but `retryReauthMutation` restored the
   currently displayed workspace B before executing it. The regression recorded
   action scopes `["org-a", "org-b"]` instead of `["org-a"]`. Each action is now
   bound to its originating organization/user and checks the current mounted
   provider, switch state and request scope before execution, including retries.
   Same-workspace reauthentication still succeeds. Backend roles and fresh-session
   rules were not changed.
2. **P2, repaired: the real parent admin layout hid organization errors behind
   perpetual loading.** `ee/apps/den-web/app/(den)/dashboard/(admin)/layout.tsx`
   returned its checking UI whenever context was null, so the new child
   Gateway/Models error guards never mounted after a failed org request. The
   layout now renders the existing error notice and does not redirect during
   loading/errors. Two regressions include the actual parent layout and verify
   no feature requests, no deployment-unavailable notice, and no redirect.
3. **P2, repaired: the new metadata-hook unit test initialized an ambient database.**
   `ee/apps/den-api/test/auth-organization-metadata.test.ts` imported real Better
   Auth, which asynchronously seeds OAuth resources even when tests only invoke
   organization hooks. An explicitly unreachable database reproduced a failure
   on an `oauthResource` SELECT. The test now stubs the unrelated seed lookup,
   awaits auth initialization, and uses an inert database URL. The real registered
   organization hooks remain under test, including an added metadata-update
   denial. No production auth behavior was changed.

Regression sources: `ee/apps/den-web/tests/org-dashboard-provider.test.tsx`,
`ee/apps/den-api/test/auth-organization-metadata.test.ts`,
`ee/apps/den-api/test/inference-providers.test.ts`, and
`ee/apps/den-api/test/inference-provider-oauth.test.ts`.

## Runtime-owner handoff

Resolved by the runtime-owner follow-up at the end of this report. The following
records the original failing behavior, not the final configuration semantics.

**P1 operational concern: management-only disable is not Models-origin preserving.**
An independent startup-only probe imported the real Den API environment twice,
changing only `GATEWAY_ENABLED`, with these non-secret fixture origins:

```text
GATEWAY_PROXY_BASE_URL=http://gateway:8791
GATEWAY_PUBLIC_BASE_URL=https://gateway.example.test
INFERENCE_PROXY_BASE_URL=https://models.example.test

enabled=true  -> modelsPublicBaseUrl=https://models.example.test
enabled=false -> modelsPublicBaseUrl=http://gateway:8791
```

The probe exited 0 and opened no database connection. Origin resolution follows
`ee/packages/utils/src/gateway-env.ts:60-79` and
`ee/apps/den-api/src/env.ts:819-825`. The disabled parser omits
`modelsPublicBaseUrl`, so Den falls back to the canonical private proxy instead
of the explicit legacy Models public origin. Missing enablement takes the same
branch. `buildOpenWorkProviderConfig` (`src/inference.ts:135-146`) publishes that
value when provisioning/repairing a Models provider (`:253-305`). Thus the
documented management-only disable operation can give newly provisioned or
repaired clients an unreachable internal URL, even while existing keys remain
valid and the Gateway process stays running. This is a configuration-transition
risk, not a claim that a flag GET revokes keys or rewrites every existing provider.

Preserving historical disabled resolution is explicitly encoded in the current
environment tests and docs; reconcile that requirement with the management-only
disable contract before changing runtime semantics. Existing providers are also
not automatically rewritten solely for a changed origin: the repair check at
`src/inference.ts:314-352` checks provider/key presence and equality, not the URL.
The public status response still reports `env.inferenceProxyBaseUrl` at `:706`.
No environment, Gateway-runtime, packaging, or migration file was changed by this
review. This concern is handed off, not silently fixed or dismissed as pre-existing.

## Verified boundaries

- `organization.metadata.capabilities.gatewayDashboard` is organization-scoped,
  default-off, and true only for the literal JSON boolean. Missing/malformed
  values and strings do not enable it. The strict public creation/settings APIs
  reject capability metadata; Better Auth creation rejects explicit Gateway
  capability input and updates reject metadata replacement.
- The existing allowlisted platform-admin capability writer supports partial
  updates, false and null deletion, while preserving unrelated metadata and
  unmanaged keys. Organization ownership alone is not platform administration.
- Authenticated `/v1/org` advertises independent top-level
  `deploymentCapabilities: { version: 1, aiGateway: boolean }`. Unsupported,
  missing or malformed versions fail closed in the Web parser. Organization
  metadata, URLs and upstream health cannot self-enable deployment support.
- Gateway list/new/detail/edit share the outer capability guard. Disabled
  organizations and nonadmins cannot mount feature children or start feature
  requests; scoped context loads, generation checks, synchronous unmounting and
  keyed children prevent stale organization flags/provider state leaking through
  tested switches, refresh races, recovery, sign-out and setup pinning.
- An opted-in admin without deployment support sees exactly:
  `This feature is not part of your deployment system, please ask an instance admin to configure deployment`.
  Loading and organization errors are separate; a Gateway upstream outage is an
  error in the enabled feature, not a capability change.
- Sidebar/search/recent filtering use the shared navigation builder. Both effective
  flags hide hosted OpenWork Models and its direct route; non-opted hosted orgs
  retain Models. Existing single-org Models restrictions remain. BYOK stays
  available, with migration controls gated on effective Gateway access.
- All production Gateway data-hook callers are within the protected list/detail/
  edit subtree. The BYOK hook remains separate; it does not start Gateway requests
  merely because the combined flag hooks are imported. Shared catalog endpoints
  still serve BYOK and are not globally disabled by the Gateway management gate.
- Backend management admission depends on deployment support, not the org UI flag.
  CRUD, manageable listing, catalog, migration and usage retain admin checks and
  fresh privileged-write checks. Usable listing, connect, member OAuth, callback
  and personal revocation are not deployment-gated.
- Added real-database checks cover all four flag combinations while Models and
  Gateway keys exist: `/v1/org`, management reads, member connect and Models status
  preserve the existing keys and Models provider. OAuth consent/callback/revocation
  also run with deployment management disabled, including verification of the
  Google revoke request and stored credential status. Google is a local test
  double, not the live provider. No native Gateway-key/runtime security rules changed.

## Independent execution receipts

Commands ran serially for tests. Typechecks ran independently in parallel. Counts
below are final runs, not sums of iterations or distinct end-to-end coverage.
All listed final test runs had **0 failed, 0 skipped**.

| Directory | Command | Exit | Passed / assertions |
| --- | --- | --- | --- |
| root | `pnpm --dir ee/apps/den-web test` | 0 | 374 (270 + 104); 1792 assertions |
| root | `DATABASE_URL=<inert-port-1-url> DB_MODE=mysql GATEWAY_ENABLED=false OPENWORK_DEV_MODE=1 pnpm --dir ee/apps/den-api test` | 0 | 75 (24 + 21 + 28 + 2); 461 assertions |
| root | `pnpm --dir ee/apps/den-api exec bun test --conditions development test/inference-provider-config.test.ts` | 0 | 13; 111 assertions |
| root | `DEN_TEST_DATABASE_URL=<scratch-url> DB_MODE=mysql GATEWAY_ENABLED=false OPENWORK_DEV_MODE=1 pnpm --dir ee/apps/den-api run test:gateway-dashboard:db` | 0 | 4; 82 assertions, no early-return coverage warning |
| root | `LOG_LEVEL=error DEN_TEST_DATABASE_URL=<scratch-url> pnpm --dir ee/apps/den-api exec bun test --conditions development test/inference-providers.test.ts` | 0 | 16; 735 assertions |
| root | `DEN_TEST_DATABASE_URL=<scratch-url> pnpm --dir ee/apps/den-api exec bun test --conditions development test/inference-provider-oauth.test.ts` | 0 | 9; 181 assertions |
| `ee/apps/gateway` | `NODE_OPTIONS=--conditions=development pnpm exec tsx --test test/deployment-capabilities.test.ts` | 0 | 6 |
| `ee/apps/gateway` | `pnpm exec tsx --test test/env.test.ts` | 0 | 14 |
| `ee/apps/den-web` | `pnpm exec tsc --noEmit --pretty false --incremental false` | 0 | source typecheck |
| `ee/apps/den-api` | `pnpm exec tsc -p tsconfig.json --noEmit --pretty false --incremental false` | 0 | source typecheck |
| `ee/apps/gateway` | `pnpm exec tsc -p tsconfig.json --noEmit --pretty false --incremental false` | 0 | source typecheck |
| root | `git diff --check` | 0 | whitespace check |

The existing `test:gateway-deployment` script was also run independently before
repairs: 28 + 2 passed, exit 0; it is included in the final API test count above.

### Database safety

Read the scripts and their environment-loading/credential selection before use.
Created a new `mysql:8.4` container named
`ow-gateway-review-dc297-20260910-iv1`, ID starting `f6adf7622b7e`, with ownership
label `independent-gateway-dc297-iv1`. Docker allocated `127.0.0.1:32777`; the
database was `ow_gateway_review_iv1`, with disposable test-only credentials.
No default/user database was used. Prepared only this empty schema with:

```sh
DATABASE_URL=<scratch-url> DB_MODE=mysql DEN_DB_ENCRYPTION_KEY=<test-only-key> OPENWORK_DEN_DB_ENV_PATH=/dev/null pnpm --dir ee/packages/den-db run db:push
```

Preparation/build exited 0. This is a fresh-schema test, not upgrade/migration
evidence. After all database runs, verified container ID/ownership, stopped and
removed that exact container and its anonymous volumes; both commands exited 0.

### Red iterations

- Initial API test command against the inert URL: first subprocess 24 passed;
  metadata subprocess 7 passed, 1 failed, 2 errors, exit 1. First actionable error:
  `oauthResource` SELECT, `ECONNREFUSED 127.0.0.1:1`. The same suite passed against
  scratch MySQL before isolation; final repaired tests also pass against inert
  port 1. The first mock implementation failed because its query chain did not
  match the adapter; corrected after inspecting the adapter, without weakening
  hook assertions.
- New parent-layout regressions: 100 passed, 2 failed, exit 1 before repair.
- New queued-reauth regression: 102 passed, 1 failed, exit 1 before repair.
- Gateway environment suite during concurrent runtime work: 12 passed, 1 failed,
  exit 1. An invalid `DATABASE_HOST` was correctly rejected, but the error regex
  excluded that name. The runtime owner changed the fixture/expectation; this
  reviewer did not. The independently rerun current suite passed 14/14.
- The previously reported Workflow Runs failure did not reproduce in the current
  configured Web suite. Its assertion had already been changed by another agent
  before this review; this reviewer did not weaken or alter it. No clean-control
  execution was performed, and no failure is labelled pre-existing.

## Exact enablement instructions

1. Use matching Gateway-capable API/Web/Gateway images and a reviewed schema
   cutover. Native hosting: set `GATEWAY_ENABLED=true` on Den API and Gateway via
   the existing deployment environment mechanism. There is no separate Den Web
   enablement variable. Helm: explicitly set `gateway.enabled: true`; legacy
   `inference.enabled` alone is not opt-in.
2. Set `GATEWAY_PROXY_BASE_URL` to the exact internal origin, for example
   `http://openwork-ee-inference:8791`, and `GATEWAY_PUBLIC_BASE_URL` to the
   desktop-reachable TLS origin, for example `https://gateway.example.com`.
   Preserve a valid existing Models public origin in `INFERENCE_PROXY_BASE_URL`,
   for example `https://models.example.com`. Do not append `/api/v1`, credentials,
   query or fragment. These are illustrative origins, not verified live ones.
3. Helm equivalents are `config.internal.gatewayProxyBaseUrl`,
   `config.public.gatewayPublicBaseUrl`, and
   `config.internal.inferenceProxyBaseUrl`. Supply the documented database and
   shared encryption-key Secret references. See `packages/docs/self-host/gateway.mdx`
   and `gateway-upgrade.mdx`; this review did not apply those settings.
4. Sign in as an allowlisted **platform** administrator. The existing operator
   bootstrap mechanism is `DEN_BOOTSTRAP_ADMIN_EMAILS` on Den API, which seeds the
   persistent admin allowlist (`src/admin-allowlist.ts`); org owner/admin roles and
   `GATEWAY_ADMIN_TOKEN` do not replace that user authorization.
5. In Den Web open `/admin` > Organizations > target organization > Capabilities >
   Gateway dashboard. Alternatively call the existing authenticated platform API:
   `PUT /v1/admin/organizations/:organizationId/capabilities` with
   `{"capabilities":{"gatewayDashboard":true}}`. False disables; null deletes
   the override and returns to off. PUT is partial.
6. Read back `GET /v1/admin/organizations/:organizationId/capabilities`, then the
   target organization's authenticated `GET /v1/org`. Verify both the org flag
   and version-1 deployment capability. Reload the dashboard; there is no live
   invalidation push. Owners, super-admins and admins can view Gateway; ordinary
   members still cannot.

## Unrun and ownership

No real browser/Next network-silence journey, Electron/Desktop sync, testkit
journey, live inference request, production image build, cluster upgrade, live
deployment, production origin/DNS/TLS check, SDK regeneration/check, or Helm test
was run by this reviewer. Component tests and in-process API tests are not those
proofs. Runtime/packaging semantics remain with the other reviewer. The PR's
ready/draft state and all remote Git state were left unchanged.

This reviewer changed only the Web admin layout, Web organization provider,
their provider tests, API metadata-hook tests, the two provider/OAuth regression
tests, and this report. All pre-existing/concurrent worktree edits were preserved.

## Runtime-owner follow-up: public destinations survive disable

The P1 handoff is fixed in the same dirty tree at HEAD `dc297aefe`.
`parseGatewayDeploymentEnv` now resolves the known Models public destination
before returning for disabled management: valid explicit legacy Models public
origin first, then valid Gateway public origin. Optional invalid values are
ignored for that selection, not turned into disabled startup prerequisites.
Den API's existing fallback remains only when neither public candidate is usable.
Internal proxy resolution still respects canonical presence, including an empty
clear. Capability remains false; token aliases and database requirements were
not changed. Existing member Gateway payloads retain their configured public URL.

Helm also retains the configured legacy Models/public Gateway destinations with
management disabled. The shared public URL is emitted independently of capability;
disabled per-app public overrides remain honored without duplicate env entries.
Component deletion on `gateway.enabled=false` is unchanged: keep-component mode
still requires legacy component enablement and omission of canonical enablement.
The Helm README and both self-host Gateway guides describe this distinction.

Failing regressions were run before repair: shared parser **7 passed / 1 failed**;
real Models client-config/API suite **27 passed / 2 failed**; Helm Gateway matrix
**72 passed / 2 failed**. Each exited 1 with zero skips. The API regression booted
the real env module with `GATEWAY_ENABLED=false` and used the actual Models and
member Gateway config builders with fake storage; no database was contacted.

Final follow-up commands all exited **0**, with zero failed/skipped tests:

| Directory | Command | Result |
| --- | --- | --- |
| `ee/apps/gateway` | `pnpm exec tsx --test test/env.test.ts` | 16 passed |
| `ee/apps/gateway` | `NODE_OPTIONS=--conditions=development pnpm exec tsx --test test/deployment-capabilities.test.ts` | 8 passed |
| `ee/apps/den-api` | `pnpm run test:gateway-deployment` | 29 + 2 passed |
| `ee/apps/den-api` | `pnpm exec bun test --conditions development test/inference-provider-config.test.ts` | 13 passed |
| Both runtime directories | `pnpm exec tsc -p tsconfig.json --noEmit --pretty false` | Both passed |
| root | `pnpm --filter @openwork-ee/utils build` | ESM/declarations passed |
| root, temporary Helm 3.19.0 on PATH | `helm lint packaging/helm/openwork-ee` | Passed |
| root, same PATH | `for suite in packaging/helm/openwork-ee/tests/*.sh; do bash "$suite" || exit $?; done` | All 9 suites; includes 74 Gateway + 22 upgrade/bootstrap cases |
| isolated scratch validation | Strict Kubernetes 1.31 schemas and rebuilt parser in network-disabled containers | 8 cases, 72 valid resources, 14 parser containers |
| `packages/docs`, cached Mint 4.2.868 | `mint validate` and `mint broken-links` | Passed; no broken links |

The scratch harness and exact tool paths are retained under
`/var/folders/h7/q7xdv1zn1jn8x_21j7znpq480000gp/T/opencode/helm-independent-dc297aefe/`.
Counts overlap and are not distinct end-to-end coverage. No production image
startup, database access, deployment, commit, or push was performed.

Remaining boundary: without either usable public origin, disabled legacy Models
fallback can still be private/loopback, intentionally preserving compatibility.
Malformed optional member Gateway URLs are not newly validated while disabled.
Previously persisted bad provider URLs are not automatically repaired by this
startup-selection fix; no persisted provider/key/billing data was changed. With
a valid public origin configured, the tested production Models path no longer
falls back to the internal proxy merely because management is disabled.
