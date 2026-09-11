# Gateway deployment capability: implementation and verification

> Historical implementation receipt. Counts and statements below describe this
> author's intermediate worktree, not the final published revision. See
> [Independent integrated Gateway validation](gateway-independent-validation.md)
> for subsequent repairs and [Gateway publication validation](gateway-publication-validation.md)
> for publication checks. In particular, the public-origin disable transition
> was repaired after the original checks recorded here.

## Verdict

**Incomplete — scoped automated verification passes; real Den Web browser and
Desktop verification, production packaging, and live deployment readiness remain
unverified.** No skipped test is counted as a pass.

Work was performed in the requested local worktree. Existing organization-flag
and organization-switch changes were preserved. No commit, push, branch switch,
deployment, secret rotation, shared/live database migration, or restart of an
existing service was performed. Testkit journeys created and cleaned up their own
temporary processes and scratch databases.

## Contract and compatibility decisions

- Chart `0.2.0` introduces sparse `gateway.*` configuration. New values override
  `inference.*` by presence, including false, zero, empty strings, lists, and maps.
  Nonempty maps merge recursively. Defaults do not mask old settings.
- Absent `gateway` is supported for old releases using `--reuse-values`. Helm
  can refill previously saved **canonical** maps; clearing those requires
  `--reset-values` with complete reviewed values, not just `{}`.
- Only explicit `gateway.enabled: true` admits the new deployment feature.
  Legacy `inference.enabled: true` retains the component but does not opt in.
- Existing Service/Deployment names, selectors, container names, ingress hosts,
  release identity, and `openwork-inference` image repository remain unchanged.
  The Dockerfile/package already target `ee/apps/gateway` / `@openwork-ee/gateway`.
  `den-gateway` remains a different Web proxy service.
- Native/hosted deployments use explicit `GATEWAY_ENABLED=true`; Helm is not
  assumed. Missing enablement preserves the legacy Models deployment behavior.
- The authenticated `/v1/org` response carries a separate top-level
  `deploymentCapabilities: { version: 1, aiGateway: boolean }`. Missing, malformed,
  or unsupported versions fail closed. No URL existence or health probe enables
  this capability.
- The existing `capabilities.gatewayDashboard` organization flag is unchanged.
  Its current administration belongs to platform-allowlisted administrators,
  not ordinary organization owners/admins. It controls dashboard exposure;
  existing backend role, tenant, and fresh-session authorization remains.
- Disabled deployment capability blocks management CRUD, catalog, migration,
  manageable listing, and usage. Member usable/connect/OAuth/revocation and
  legacy Models traffic remain outside that management gate.
- Gateway list/new/detail/edit share an outer guard. An opted-in admin on an
  unsupported deployment sees exactly:

  > This feature is not part of your deployment system, please ask an instance admin to configure deployment

  Feature children do not mount or fetch in that state. Loading and context
  errors are distinct. An upstream outage does not change deployment capability.
- Effective deployment + organization enablement hides the OpenWork Models page
  and direct URL without altering keys, subscriptions, settlement, or runtime
  authorization. Non-opted-in hosted organizations retain that page.
- Gateway internal and client-public origins are separate. The final combined
  implementation retains a valid explicit legacy Models public origin, falling
  back to a valid public Gateway origin, independently of enablement. Only when
  neither public candidate is usable does disabled mode retain the historical
  fallback. This supersedes the original unchanged-disabled-behavior decision.
- Enabled startup validates database mode/credentials, shared encryption key,
  strict boolean and numeric settings, and internal/public origins. Canonical
  runtime variables take precedence over deprecated aliases. Optional admin,
  webhook, and retention credentials are not basic-enable prerequisites.
- Both services receive shared required Secret references. Retention owns both
  admin-token aliases when enabled, and uses the normal image-tag fallback.
- Migration Jobs require the TCP `DATABASE_URL` selected by
  `secret.keys.databaseUrl`, including with PlanetScale HTTP runtime mode.

## Configuration example

Merge this fragment with complete deployment values. References are placeholders;
the Secret must already exist and contain the required database/authentication
and encryption entries. Use matching immutable images from the Gateway-capable
release, not the chart's placeholder appVersion.

```yaml
image:
  tag: REPLACE_MATCHING_RELEASE_IMAGE_TAG
gateway:
  enabled: true
config:
  databaseMode: mysql
  internal:
    gatewayProxyBaseUrl: http://openwork-ee-inference:8791
    # Preserve an existing Models client endpoint when one is in use.
    inferenceProxyBaseUrl: https://models.example.com
  public:
    gatewayPublicBaseUrl: https://gateway.example.com
secret:
  create: false
  existingSecret: REPLACE_PRECREATED_DEN_SECRET
  keys:
    databaseUrl: DATABASE_URL
    denDbEncryptionKey: DEN_DB_ENCRYPTION_KEY
```

Replace the Service name with the retained name for the actual release. Gateway
public ingress remains operator-provided. For an existing database, follow the
quiesced migration procedure before enabling or rolling out application images.

## Final verification commands

Paths below are relative to the worktree root. Final commands exited **0**.
Counts are per command; overlapping suites and repeated runs must not be summed
as distinct coverage. Checks without a test count are listed as checks, not tests.

| Working directory | Command | Passed / failed / skipped |
| --- | --- | --- |
| `ee/apps/den-web` | `pnpm test` | 370 / 0 / 0 (270 main + 100 provider/guard tests) |
| `ee/apps/den-web` | `pnpm exec tsc --noEmit --pretty false --incremental false` | typecheck; exit 0 |
| root | `pnpm --filter @openwork-ee/den-api run test:gateway-deployment` | 30 / 0 / 0 (28 routes + 2 org contract) |
| `ee/apps/den-api` | `pnpm exec bun test --conditions development test/inference-provider-config.test.ts` | 13 / 0 / 0 |
| `ee/apps/den-api` | `pnpm exec tsc -p tsconfig.json --noEmit --pretty false` | typecheck; exit 0 |
| `ee/apps/gateway` | `pnpm exec tsx --test test/env.test.ts` | 13 / 0 / 0 |
| `ee/apps/gateway` | `NODE_OPTIONS=--conditions=development pnpm exec tsx --test test/deployment-capabilities.test.ts` | 6 / 0 / 0 |
| `ee/apps/gateway` | `pnpm exec tsc -p tsconfig.json --noEmit --pretty false` | typecheck; exit 0 |
| root | `pnpm --filter @openwork-ee/utils build` | build; exit 0 |
| root | `pnpm evals:pr specs/managed-inference.test.ts` | 1 / 0 / 0 |
| root | `pnpm evals:pr specs/inference-gateway-lifecycle.test.ts` | 1 / 0 / 0 |
| root | `pnpm evals:pr specs/inference-gateway-org-provider.test.ts` | 3 / 0 / 0 |
| root | `bash packaging/helm/openwork-ee/tests/gateway.sh` | 71 / 0 / 0 |
| root | `bash packaging/helm/openwork-ee/tests/upgrade-and-migration.sh` | 22 / 0 / 0 |
| root | `git diff --check` | whitespace check; exit 0 |
| `packages/docs` | `pnpm --config.node-linker=hoisted --package=mint --package=openapi-types dlx mint validate` | documentation validation; exit 0 |
| `packages/docs` | `pnpm --config.node-linker=hoisted --package=mint --package=openapi-types dlx mint broken-links` | no broken links; exit 0 |

The final PR journey commands ran serially and cold-started testkit-owned services
against the modified local tree. The runner did **not** print its documented
placement line; observed/resolved placement was local with no `--local` override.
No synthetic placement output is claimed.

Helm `v3.19.0` was made available on PATH from temporary tooling. Final lint and
render commands, from the root:

```bash
helm lint packaging/helm/openwork-ee
helm lint packaging/helm/openwork-ee --set gateway.enabled=true --set config.internal.gatewayProxyBaseUrl=http://openwork-ee-inference:8791 --set config.public.gatewayPublicBaseUrl=https://gateway.example.com --set secret.create=false --set secret.existingSecret=gateway-test
helm template openwork-ee packaging/helm/openwork-ee --set gateway.enabled=true --set config.internal.gatewayProxyBaseUrl=http://openwork-ee-inference:8791 --set config.public.gatewayPublicBaseUrl=https://gateway.example.com --set secret.create=false --set secret.existingSecret=gateway-test > /dev/null
for suite in packaging/helm/openwork-ee/tests/*.sh; do bash "$suite" || exit $?; done
```

Result: **2 lint configurations, 1 standalone render, 9 shell suites passed**;
the 71-case and 22-case matrices above are included in those suites, not extra
distinct tests. The other suites cover Automations, custom CA (including a
strict-TLS witness), Dashboards, image tags/migration hooks, observability,
OpenWork Web, and private MCP URLs. Helm's icon recommendation is informational.

### Red iterations (not hidden or labelled pre-existing)

Intermediate runs failed and were repaired before the final runs:

- An introduced parser-test syntax error and Web refactor reference error.
- A stale navigation assertion and several incorrect new chart-test assertions.
- Missing temporary Helm PATH and the Mint CLI's missing `openapi-types`
  dependency; tooling was isolated without repository dependency changes.
- Gateway positive fixtures lacked the new explicit enablement/public origins.
- Legacy managed-inference needed an exact-origin loopback witness exception;
  its payload expectation omitted the intentional forwarded usage option.
- Lifecycle expectations used the old key store and an incomplete migrated
  audience set. They now verify separate Gateway/Models stores and the complete
  organization plus protected creator-member audience bindings.

No clean control was run to establish any failure as pre-existing. Final journey
assertions were rerun through completion, including OAuth and offboarding checks.

## Changed-file map

This lists this task's implementation areas, not an attribution of all dirty
files. The worktree also contains preserved work by the organization-flag agent.

- Shared contract: `packages/types/src/den/deployment-capabilities.ts` and
  `packages/types/package.json`.
- Runtime validation: `ee/packages/utils/src/gateway-env.ts`, utils package
  exports/build configuration, `ee/apps/gateway/src/env.ts`, and Gateway env and
  deployment-capability tests.
- Den API: `src/env.ts`, `src/gateway-deployment.ts`, `src/inference.ts`,
  `src/llm/gateway-matrix.ts`, additive `src/routes/org/core.ts` changes,
  `src/routes/org/inference-providers.ts`, `src/routes/org/gateway-usage.ts`,
  test wiring, deployment-contract tests, and positive management/OAuth fixtures.
- Den Web: organization-response parsing, Gateway access helper/guard, Models
  outer guard, navigation/sidebar/palette, and corresponding component/navigation
  tests. Existing organization flag, layout, and switching protections are reused.
- Helm: `Chart.yaml`, `values.yaml`, `README.md`, `_gateway.tpl`, `_helpers.tpl`,
  ConfigMap/Secret/API/Gateway/retention/migration/env-probe templates, and
  `tests/gateway.sh`, `tests/upgrade-and-migration.sh`,
  `tests/upgrade-and-migration.mjs`.
- Journeys: Gateway lifecycle, org-provider, desktop-sync fixtures, managed
  inference assertions, and `evals/packages/env/src/inference.ts` witness config.
- Documentation: `packages/docs/self-host/gateway.mdx`,
  `packages/docs/self-host/gateway-upgrade.mdx`, `packages/docs/docs.json`,
  cloud deployment overview, self-host, air-gap, certificate, and outbound-network
  pages. This report is `docs/gateway-deployment-verification.md`.

## Unresolved deployment risks and unrun checks

1. **No production rollout approval.** Actual hosted Render/Vercel environment,
   source paths, image digests, predeploy commands, Secrets, DNS, and TLS were not
   queried or changed. Repository publishing preserves `openwork-inference`; its
   automated `den-gateway` redeploy is for the separate service.
2. **Existing database cutover is not an ordinary rolling upgrade.** Migration
   0097 and subsequent release migrations require reviewed ordering, backups,
   quiesced writers/readers, and a supported dedicated MySQL session. The generic
   production bootstrap's missing-ledger baselining does not prove legacy schema
   compatibility. The docs require a separately reviewed cutover; no shared
   migration was attempted. `/ready` checks connectivity, not schema completeness.
3. **Matching images are required.** Chart appVersion remains a packaging
   placeholder. Chart `0.2.0` cannot make an old API/Web/Gateway image implement
   capability version 1. Images must be selected from the matching release.
4. **Real browser network-silence proof is missing.** Web component tests exercise
   guards/screens and requests with mocked routing. They do not replace a real
   Next/Den Web browser journey for all direct URLs.
5. **Desktop-sync E2E was not run.** The placement probe selected Daytona, whose
   remote-ref checkout would not contain this dirty worktree. No placement
   override or unverified source transfer was used. This is unrun, not skipped
   or passed. The fixture update therefore lacks Desktop execution proof.
6. **No complete production image build or cluster upgrade.** Lint/render and
   focused builds/typechecks do not prove real Kubernetes rollout, external
   Secret contents, or production packaging. The direct DB-backed API suites
   were not separately run; scratch-database testkit journeys cover relevant
   management/member lifecycle paths.
7. **Disable is not infrastructure preservation.** Removing the organization
   dashboard grant or disabling management admission does not revoke keys or
   cancel billing. Setting `gateway.enabled: false` removes the component and
   interrupts traffic through it. Keep the service when only disabling new
   management; follow the upgrade guide. Old incompatible images/schema rollback
   are not safe by implication.
