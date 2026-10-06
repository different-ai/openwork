# License contracts

`@openwork/license-contracts` is the shared vocabulary for Den modules and the
license wire contract. den-api, the gateway, den-web, the desktop and the
private license server all read it. It is pure TypeScript and Zod (`zod` pinned
to `4.3.6`): no I/O, no env, no clock reads (callers pass `now`).

`pnpm --filter @openwork/license-contracts build` produces the default
JavaScript and declarations in `dist/`. The `types` and `development`
conditions expose `src/`.

## Exports

| Subpath | File | Contents |
|---|---|---|
| `.` | `src/index.ts` | Everything below |
| `./modules` | `src/modules.ts` (+ `src/module-ids.ts`, `src/module-id-list.ts`) | `MODULE_IDS`, `MODULE_GROUPS`, `ModuleDefinition`, `MODULE_DEFINITIONS`, graph helpers, `CLOUD_FREE_PLAN_MODULES`, `validateLicenseModules` |
| `./resolver` | `src/resolver.ts` (+ `src/operations.ts`) | `resolveModules`, `ModuleState`, `EffectiveModules`, `computeTransitionStart`, `evaluateModuleOperation` |
| `./errors` | `src/errors.ts` | The "module off" body (`module_disabled`), headers, status, `license_unavailable` |
| `./license` | `src/license.ts` | License check v1 (frozen) and v2 schemas, constants, normalize, upgrade, project |
| `./hints` | `src/hints.ts` | Optional Cloud push hint and batch check schemas |
| `./payload` | `src/payload.ts` | Client wire shape of module states (`/v1/org`, `/v1/me`, desktop config) |
| `./org-modules` | `src/org-modules.ts` | The `organization.modules` column document and the persisted entitlement snapshot |

## Module ids are location paths (D44)

A module id says where the feature lives in the product: dot-separated
camelCase segments, at most 4 (`ai.gateway.openworkModels.analytics`,
`library.connectors.native.googleWorkspace`). Every prefix of an id is either
a **module** (`MODULE_IDS`, 34 today) or a **group** (`MODULE_GROUPS`):

| Group | Holds |
|---|---|
| `org` | Organization settings modules (`org.branding`, `org.billing`, …) |
| `org.members` | `org.members.teams`, `org.members.roles` (custom roles) |
| `org.auth` | `org.auth.sso`, `org.auth.scim` |
| `org.observability` | `org.observability.auditLogs` (+ `.export`) |
| `ai` | `ai.gateway` and its sub-modules, `ai.customProviders` |
| `library` | My Library: plugins, workflows, apps, connectors |
| `library.connectors.native` | `…native.googleWorkspace`, `…native.microsoft365` |

Groups are pure namespaces. They are never toggled, never entitled, never a
parent or a dependency, and never appear in resolved module states: think of
them as always on. A group id in a license is `unknown_module`, and in
`organization.modules.disabled` it is ignored.

A module's `parent` is its **nearest ancestor that is a module**; groups are
skipped (`nearestModuleAncestor`). So `library.connectors.native.microsoft365`
has parent `library.connectors`, and `org.auth.scim` has no parent. The parent
is a hard dependency (D6). Every other dependency is declared explicitly in
`dependsOn` (hard) or `softDependsOn` and is never implied by the path
(`org.auth.scim` hard-depends on `org.auth.sso`).

`MODULE_IDS` and `MODULE_GROUPS` live in `src/module-id-list.ts`, which imports
nothing, so plain Node scripts can read them without installing this package's
dependencies.

### Append-only

Once merged, `MODULE_IDS` never loses, renames or reorders an id. Retire one by
setting `stability: "deprecated"` in its definition, so old licenses and old Den
versions still parse. `src/module-ids.snapshot.json` must stay a prefix of
`MODULE_IDS`; append to both when adding a module.

The snapshot was **reset before first merge** (D44, 2026-10-06) to the
location-path ids; no Den, desktop or license server ever shipped the earlier
flat ids (`connect`, `aiGateway`, `enterpriseAuth`, …). The old→new mapping is
in `docs/modules/dependency-map.md` §2a. From the first merge on, the snapshot
only grows.

Definition data (names, edges, `entitlement`, `orgToggle`, `expiryPolicy`,
`transitionOperations`) can change in a reviewed PR. Ids can't.

Rules the tests enforce:

- Ids are camelCase segments, at most 4; no id is both a module and a group;
  every prefix of a module or group is a module or a group.
- `parent` equals the nearest module ancestor. A sub-module is never effective
  without its parent; a parent works without its sub-modules (D6).
- `dependsOn` (hard) drives state; `softDependsOn` never does. The hard graph
  (`parent ∪ dependsOn`) is acyclic. Group ids never appear in `parent`,
  `dependsOn` or `softDependsOn`.
- `entitlement: "free"` ⇔ `expiryPolicy: "n/a"`. `expiryPolicy: "restricted"`
  ⇔ `transitionOperations` with an `other` key.

## Modules and feature flags (D43)

Modules and feature flags are separate layers:

- **Modules** (this package) answer "what does this organization have". They
  are permanent, decided by plan or license entitlement plus the org's own
  opt-outs (`organization.modules`).
- **Feature flags** (`@openwork/features`, `packages/features`) answer "is this
  new code safe to show yet". They are temporary rollout state set by the
  platform team (deployment, kill switch, operator lock, per-org override,
  everyone on or off).

Rules:

- Every feature flag belongs to exactly one module.
- A new product area gets a module id first; its code ships behind a flag
  scoped to that module.
- Effective = module effective ∧ flag on. A flag can only hold a module back;
  it never grants one.
- When a rollout is done, the flag is deleted and module entitlement is the
  only gate.

`Deployment` uses the same values as `DEN_DEPLOYMENT` and the feature registry:
`cloud` and `self_hosted`.

## Resolution

`resolveModules()` implements discovery §6.3. For each module, in topological
order, the first matching rule wins: `not_on_deployment`, `not_available`,
`not_entitled`, `license_expired`, `disabled_by_org` (only `orgToggle:
"optOut"`), `requires` (first off parent or hard dependency), `restricted`,
`on`.

- No license key on self-hosted (`source: "none"`) is Core only, free modules
  included (D14). A Cloud org without a snapshot gets `CLOUD_FREE_PLAN_MODULES`.
- The license transition starts at the earliest of: expiry, invalidation, a
  rejected credential (401/403), the end of the 24h verification grace, or the
  persisted `transitionStartedAt`. Licensed modules then follow their
  `expiryPolicy` for 30 days. Trials (`kind: "trial"`) end immediately (D22).

## License wire contract

- `POST /v1/licenses/check` with `Authorization: Bearer <license-key>`. The
  server answers in the request's `schemaVersion`.
- **v1 is frozen.** The unsuffixed v1 names (`licenseCheckRequestSchema`,
  `licenseCheckResponseSchema`, `AUTH_TRANSITION_POLICY`, …) are kept byte for
  byte because the private server imports them; `…SchemaV1` are aliases. v1 has
  one module, `auth`, which normalizes to `org.auth.sso` and `org.auth.scim`
  (`LEGACY_V1_AUTH_MODULES`; `org.auth` itself is a group). Projected back to
  v1, `auth` is true only when both are granted. The stale v1 capability flags
  map to `org.installLinks`, `library.connectors`, `library.workflows` and
  `openworkWeb` (`LEGACY_V1_CAPABILITY_MODULES`).
- **v2** adds `instanceId` and `version` to requests (diagnostics only, never
  binding) and a flat `modules` map plus `kind: "standard" | "trial"` to
  responses. Den parses responses tolerantly: unknown fields are stripped and
  unknown module keys are ignored. Unknown or missing keys mean "not entitled".
  The license server refuses unknown keys when authoring
  (`validateLicenseModules`).
- There are no per-person flags (`userFlags` was dropped, D20). Feature flags
  never grant a module.
- Version negotiation: Den sends v2 and, on a 400 from an old server, retries
  once with v1 and normalizes. `projectLicenseResponseToV1` serves v1 consumers
  from a v2 answer (`auth` is least privilege).

## Vendoring

The private license server vendors this package with a finite file allowlist
(`scripts/source-policy.ts`). When adding a file or subpath here, add it to
that allowlist in the same window, or its sync fails closed. Files today:
`README.md`, `package.json`, `tsconfig.json`, `tsup.config.ts`,
`src/{index,module-id-list,module-ids,modules,resolver,operations,errors,license,hints,payload,org-modules}.ts`
and `src/module-ids.snapshot.json`.

## Docker images

No image needs this package until a consumer depends on it.
`scripts/check-docker-workspace-packages.mjs` (run by `pnpm features:check`)
fails once a copied package depends on it without these lines. The first consumer
(den-db, then den-api, the gateway and den-web) adds to
`packaging/docker/Dockerfile.den`, `Dockerfile.gateway` and
`Dockerfile.den-web`: `COPY packages/license-contracts/package.json` next to
the other manifests, `COPY packages/license-contracts` next to the other
sources, and `RUN pnpm --dir /app/packages/license-contracts run build` before
the den-db build.
