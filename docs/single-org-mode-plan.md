# Single-Org Deployment Mode

Status: implemented first pass
Owner: self-host / enterprise
Related: `packaging/helm/openwork-ee`, `ee/apps/den-api/src/auth.ts`, `ee/apps/den-api/src/orgs.ts`, `ee/apps/den-web/app/(den)`

Implementation note: this document started as the plan for the subagent split.
The first pass now implements the default `single_org` mode, singleton org
bootstrap and membership enforcement, route guards, Den Web runtime config, UI
flow changes, Helm/Docker env wiring, validation proof, and SSO-only auth when
the singleton organization has SSO configured. SCIM-specific singleton JIT
behavior and production bootstrap-token UX remain follow-up work.

## Goal

Make self-hosted OpenWork EE deployments behave like one customer-owned
workspace by default, while keeping hosted OpenWork Cloud multi-org.

The internal model should still use organizations, members, roles, SSO, SCIM,
workers, plugins, API keys, and MCP resources. The product experience should
stop asking self-hosted users to create or choose organizations. A Helm install
should have one deployment organization, one ownership model, and one clear path
from first admin setup to SSO/SCIM-managed usage.

## Deployment Modes

Introduce an explicit org mode:

```text
DEN_ORG_MODE=single_org | multi_org
```

Recommended defaults:

- Helm chart: `single_org`
- Local development: `single_org` unless a developer opts into multi-org
- Hosted OpenWork Cloud: `multi_org`

Suggested Helm values:

```yaml
config:
  tenancy:
    mode: single_org
    singleOrgName: OpenWork
    singleOrgSlug: default
    ownerEmails: ""
    allowPublicSignup: "false"
    requireEmailVerification: "false"
```

`ownerEmails` should reuse or replace the current
`config.public.bootstrapAdminEmails` concept. The important distinction is that
bootstrap admin currently seeds internal admin access, while single-org owner
bootstrap controls the deployment organization owner.

Packaging implementation note: Helm now exposes these values to both Den API
and Den Web as `DEN_ORG_MODE`, `DEN_SINGLE_ORG_NAME`,
`DEN_SINGLE_ORG_SLUG`, `DEN_SINGLE_ORG_OWNER_EMAILS`,
`DEN_SINGLE_ORG_ALLOW_PUBLIC_SIGNUP`, and `DEN_REQUIRE_EMAIL_VERIFICATION`.
Blank or unset `DEN_ORG_MODE` resolves to `single_org`; hosted/cloud
deployments should set `DEN_ORG_MODE=multi_org` explicitly.

Den web also needs the mode exposed through runtime config. Today
`ee/apps/den-web/app/api/runtime-config/route.ts` exposes app-connect and auth
callback URLs only, so UI workers should add deployment-mode data there instead
of duplicating env parsing in many components.

## Product Principles

Single-org mode is a deployment policy, not a separate product data model.

- Keep org-scoped resources internally.
- Guarantee one deployment organization.
- Automatically select the deployment organization for every session.
- Block creation of additional organizations.
- Hide or remove organization switching and organization creation UI.
- Treat SSO/SCIM as the normal production path.
- Keep a deliberate break-glass owner path for first setup and recovery.

## Target Behavior

### Fresh Install

The server can create the singleton organization idempotently from env/config.

If no owner exists:

1. If owner emails are configured, only those emails can claim owner.
2. If no owner emails are configured, dev/local may allow first user owner.
3. Production Helm should strongly prefer explicit owner emails or a setup token.

The first owner lands on a setup checklist:

- confirm organization name
- configure SAML/OIDC SSO
- configure allowed domains and SSO requirement
- optionally configure SCIM
- invite or provision users
- install desktop / connect workers

### Normal User Sign-In

Once the singleton organization exists:

- If SSO is configured on the singleton organization, the root auth experience
  shows only "Continue with SSO".
- Sign-in/sign-up pages redirect to that root SSO-only experience.
- Raw Better Auth email/password sign-in and sign-up requests are rejected with
  `single_org_sso_required`.
- SSO login JIT-provisions the user into the singleton org.
- SCIM-created users are attached to the singleton org.
- Email verification is disabled by default in single-org Helm mode.

### Organization APIs

In `single_org` mode:

- `POST /v1/org` should return a clear single-org error or idempotently return
  the singleton organization if the caller is already a member.
- `/api/auth/organization/create` must not bypass the Den route policy.
- Active-org switch routes should only accept the singleton org, or become a
  no-op that returns it.
- `/v1/me/orgs` should return exactly one org for normal users.
- MCP OAuth should never force the user through a select-organization screen
  just because the session was created before org hydration.

## Current Code Map

Backend:

- `ee/apps/den-api/src/env.ts`: parse deployment mode.
- `ee/apps/den-api/src/orgs.ts`: org creation, member creation, org list,
  org context, ownership transfer, dynamic role seeding.
- `ee/apps/den-api/src/active-organization.ts`: initial active org for new
  sessions.
- `ee/apps/den-api/src/middleware/user-organizations.ts`: resolves visible orgs
  and hydrates session active org.
- `ee/apps/den-api/src/middleware/organization-context.ts`: loads active org
  context and validates membership/API key scope.
- `ee/apps/den-api/src/auth.ts`: Better Auth config, email verification, org
  plugin, SSO/SCIM plugin behavior, MCP OAuth org claims.
- `ee/apps/den-api/src/routes/org/core.ts`: org create/read/update/invite.
- `ee/apps/den-api/src/routes/me/index.ts`: org directory and active-org
  endpoints.
- `ee/apps/den-api/src/routes/auth/index.ts`: raw Better Auth handler surface.

Frontend:

- `ee/apps/den-web/app/(den)/_providers/den-flow-provider.tsx`: email auth,
  verification, SSO redirects, landing route.
- `ee/apps/den-web/app/(den)/_components/auth-panel.tsx`: sign-in/sign-up UI.
- `ee/apps/den-web/app/(den)/_components/organization-screen.tsx`: current
  create/switch organization screen.
- `ee/apps/den-web/app/(den)/dashboard/_providers/org-dashboard-provider.tsx`:
  redirects to `/organization` when no org exists.
- `ee/apps/den-web/app/sso/[orgSlug]/page.tsx`: org-slug SSO entrypoint.

Packaging and docs:

- `packaging/helm/openwork-ee/values.yaml`
- `packaging/helm/openwork-ee/templates/configmap.yaml`
- `packaging/helm/openwork-ee/README.md`
- `packages/docs/start-here/self-host.mdx`

## Implementation Work Packages

Each package should be handled by a focused subagent or worker in a disjoint
write area, then reviewed and integrated by the orchestrator.

### 1. Config And Helm Surface

Owner: Helm/config worker

Files:

- `ee/apps/den-api/src/env.ts`
- `packaging/helm/openwork-ee/values.yaml`
- `packaging/helm/openwork-ee/templates/configmap.yaml`
- `packaging/helm/openwork-ee/README.md`
- `packages/docs/start-here/self-host.mdx`

Tasks:

1. Add `DEN_ORG_MODE` parsing with default `single_org` for Helm values and a
   clearly documented `multi_org` override for hosted cloud.
2. Add singleton org name/slug/owner-email config.
3. Pass `DEN_ORG_MODE` and singleton settings through Docker/local dev scripts
   where relevant, including `packaging/docker/docker-compose.den-dev.yml` and
   `packaging/docker/den-dev-up.sh`.
4. Document the ownership split between self-host single-org and hosted cloud
   multi-org.
5. Keep existing password breach screening behavior: self-host still avoids
   external breach checks by default.

Validation:

- render/lint through CI if local `helm` is unavailable
- targeted env parsing tests
- doc review against Helm values

### 2. Singleton Organization Backend

Owner: backend tenancy worker

Files:

- `ee/apps/den-api/src/orgs.ts`
- `ee/apps/den-api/src/active-organization.ts`
- `ee/apps/den-api/src/middleware/user-organizations.ts`
- `ee/apps/den-api/src/middleware/organization-context.ts`
- new or existing tests under `ee/apps/den-api/test`

Tasks:

1. Add idempotent singleton org resolver.
2. Use fixed unique slug and duplicate-key re-query to handle concurrent first
   requests.
3. Create the first eligible owner, then attach later users as members.
4. Ensure default desktop policy and dynamic roles are seeded.
5. Ensure session creation and org middleware always resolve the singleton for
   eligible users.

Validation:

- first eligible user becomes owner
- second eligible user becomes member
- concurrent singleton creation does not create two orgs
- stale session active org is repaired
- `/v1/me/orgs` returns one active org

### 3. Auth, Owner Bootstrap, And SSO Policy

Owner: auth worker

Files:

- `ee/apps/den-api/src/auth.ts`
- `ee/apps/den-api/src/enterprise-auth-requirement.ts`
- `ee/apps/den-api/src/sso-jit.ts`
- `ee/apps/den-api/src/routes/org/sso.ts`
- `ee/apps/den-api/src/routes/auth/scim.ts`
- new or existing auth/SSO/SCIM tests

Tasks:

1. Disable email verification by default in single-org mode.
2. Enforce owner bootstrap policy before creating users when possible.
3. Route SSO-required domains to SSO before email/password sign-in or signup.
4. Ensure SSO JIT and SCIM attach users to the singleton org.
5. Preserve owner role immutability and protect against SCIM removing the last
   owner.

Validation:

- configured owner email can bootstrap owner
- unconfigured email cannot steal owner in production policy
- SSO-required email/password users are redirected/rejected correctly
- SSO JIT creates member membership in singleton org
- SCIM deactivation does not remove the only owner

### 4. API Route Guards

Owner: route behavior worker

Files:

- `ee/apps/den-api/src/routes/org/core.ts`
- `ee/apps/den-api/src/routes/me/index.ts`
- `ee/apps/den-api/src/routes/auth/index.ts`
- route tests under `ee/apps/den-api/test`

Tasks:

1. Block or reshape `POST /v1/org` in single-org mode.
2. Block raw Better Auth organization creation/switch bypasses.
3. Make active-org switching idempotent for the singleton.
4. Preserve multi-org behavior when `DEN_ORG_MODE=multi_org`.

Validation:

- `/v1/org` cannot create a second org
- `/api/auth/organization/create` cannot create a second org
- `/api/auth/organization/set-active` cannot switch to a non-singleton org
- multi-org tests keep passing when mode is `multi_org`

### 5. Den Web Single-Org UX

Owner: frontend worker

Files:

- `ee/apps/den-web/app/(den)/_providers/den-flow-provider.tsx`
- `ee/apps/den-web/app/(den)/_components/auth-panel.tsx`
- `ee/apps/den-web/app/(den)/_components/organization-screen.tsx`
- `ee/apps/den-web/app/(den)/dashboard/_providers/org-dashboard-provider.tsx`
- `ee/apps/den-web/app/(den)/dashboard/_components/org-dashboard-shell.tsx`
- `ee/apps/den-web/app/api/runtime-config/route.ts`

Tasks:

1. Expose deployment mode to Den web.
2. Hide sign-up or org creation flows when policy requires SSO/setup.
3. Replace "Name your team" with setup/status behavior in single-org mode.
4. Redirect `/organization` to dashboard when singleton org exists.
5. Hide org switcher/create affordances in single-org mode.
6. Add a non-slug SSO affordance for singleton deployments, or build the direct
   SSO URL from runtime config.
7. Keep hosted cloud multi-org UX unchanged.

Validation:

- first admin can reach setup flow
- normal SSO user lands on dashboard
- no organization creation prompt appears in single-org mode
- org switcher/create controls are absent
- multi-org mode still shows create/switch flows

### 6. End-To-End Validation And Fraimz

Owner: validation worker plus orchestrator

Commands:

```bash
pnpm dev:web-local
```

Expected local services:

- Den API: `http://localhost:8788` when using `pnpm dev:web-local`
- Den web: `http://localhost:3005`
- Worker proxy: `http://localhost:8789`
- Inference: `http://localhost:8791`
- MySQL: local Docker compose service

Note: the split script `pnpm dev:den:api` defaults Den API to `8790`; do not
confuse that with the all-in-one `pnpm dev:web-local` path.

Baseline check on 2026-07-05:

`pnpm dev:web-local` did not reach app startup. Pnpm detected that the pulled
lockfile and existing `node_modules` layout were out of sync, attempted an
install, warned that registry metadata fetch failed, and prompted to remove and
reinstall module directories. The orchestrator declined the destructive install
prompt during planning. Before local runtime validation, run a deliberate
dependency repair step such as `pnpm install --frozen-lockfile` with network
access approved.

Scenarios:

1. Fresh DB single-org owner bootstrap.
2. Second direct signup joins singleton as member or is blocked according to
   policy.
3. SSO-required email/password attempt is redirected or rejected before creating
   an unintended account.
4. Dashboard loads without `/organization` org-creation detour.
5. Org settings/SSO/member pages operate against singleton org.
6. Multi-org mode still allows org creation/switching.

Baseline check on 2026-07-05 after dependency repair:

1. `pnpm install --frozen-lockfile` completed successfully with pnpm 11.7.0.
2. First `pnpm dev:web-local` runtime attempt started MySQL and schema sync but
   `den-api` failed because `@openwork/install-config` had no `dist/index.js`.
3. `pnpm --filter @openwork/install-config build` fixed the missing package
   artifact.
4. Restarted `pnpm dev:web-local`; all services came up:
   - Den API: `http://127.0.0.1:8788`
   - Den web: `http://127.0.0.1:3005`
   - Inference: `http://127.0.0.1:8791`
   - Worker proxy: `http://127.0.0.1:8789`
5. Health/readiness probes passed:
   - `curl -sS http://127.0.0.1:8788/health`
   - `curl -sS -i http://127.0.0.1:8788/ready`
   - `curl -sS http://127.0.0.1:8791/health`
   - `curl -sS -i http://127.0.0.1:3005/api/health`
   - `curl -sS -i http://127.0.0.1:3005/api/ready`

Helm render checks after config work:

```bash
helm template openwork-ee ./packaging/helm/openwork-ee --set image.tag=test | rg "DEN_ORG_MODE|DEN_SINGLE"
helm template openwork-ee ./packaging/helm/openwork-ee --set config.tenancy.mode=multi_org --set image.tag=test | rg "DEN_ORG_MODE"
```

Local `helm` is not installed in the current Codex environment, so use CI or an
environment with Helm for this until local tooling is available.

Fraimz:

- Create or update a flow proving the single-org first-run/admin setup path.
- Add a second flow proving multi-org cloud behavior is unchanged, or run the
  canonical core flow if the UI changes are expected to be inert.

Validation update on 2026-07-05:

1. `pnpm --filter @openwork-ee/den-api exec bun test test/single-org-mode.test.ts test/single-org-route-guards.test.ts`
   passed 8 tests.
2. `pnpm --filter @openwork-ee/den-api exec tsc --noEmit` passed.
3. `pnpm --filter @openwork-ee/den-web exec tsc --noEmit` passed.
4. `git diff --check` passed.
5. `bash -n packaging/docker/den-dev-up.sh` passed.
6. `docker compose -f packaging/docker/docker-compose.den-dev.yml config | rg "DEN_ORG_MODE|DEN_SINGLE_ORG|DEN_REQUIRE_EMAIL_VERIFICATION"`
   showed `single_org`, singleton org settings, and disabled email verification.
7. `pnpm dev:web-local` started Den API, Den Web, worker proxy, inference, and
   Docker MySQL. Health, readiness, runtime config, signup/signin, singleton
   membership, and org-create rejection checks passed.
8. `pnpm fraimz --flow den-single-org-mode --cdp-url http://127.0.0.1:9825`
   passed and produced `evals/results/2026-07-05T15-25-15-884Z/fraimz.html`.
9. Native `helm version --short` failed because Helm is not installed locally.
   Helm validation was completed through OrbStack Docker instead:
   - `docker run --rm -v /Users/omar/code/openwork/packaging/helm/openwork-ee:/chart:ro alpine/helm:3.15.4 version --short`
     returned `v3.15.4+gfa9efb0`.
   - `docker run --rm -v /Users/omar/code/openwork/packaging/helm/openwork-ee:/chart:ro alpine/helm:3.15.4 lint /chart --set image.tag=test`
     passed with 0 chart failures.
   - `docker run --rm -v /Users/omar/code/openwork/packaging/helm/openwork-ee:/chart:ro alpine/helm:3.15.4 template openwork-ee /chart --set image.tag=test --show-only templates/configmap.yaml`
     rendered `DEN_ORG_MODE: "single_org"` and singleton settings.
   - `docker run --rm -v /Users/omar/code/openwork/packaging/helm/openwork-ee:/chart:ro alpine/helm:3.15.4 template openwork-ee /chart --set image.tag=test --set config.tenancy.mode=multi_org --show-only templates/configmap.yaml`
     rendered `DEN_ORG_MODE: "multi_org"`.

## Orchestration Plan

The orchestrator is responsible for sequencing, reviewing, integrating, and
validating worker output.

1. Write and maintain this plan document.
2. Use read-only explorers to audit backend, auth, UI, Helm/docs, and validation.
3. Assign implementation workers only after the target contract is stable.
4. Keep worker write scopes disjoint.
5. Review every worker diff before integration.
6. Run focused tests after each slice.
7. Run `pnpm dev:web-local` and browser/fraimz validation after integrated UI
   behavior exists.
8. Update Helm README and public self-host docs before final handoff.

## Open Decisions

1. Should Helm require explicit owner emails in production, or allow first user
   owner with a warning?
2. Should single-org mode allow email/password member signup after SSO is
   configured, or make SSO mandatory except break-glass owners?
3. Should `POST /v1/org` in single-org mode return 403, 409, or the singleton
   org for existing members?
4. Should singleton org slug be configurable, always `default`, or derived from
   the release name?
5. Should hosted cloud local dev default to `multi_org`, while regular local
   dev follows Helm `single_org`?
6. How should existing customer DBs with multiple orgs behave when
   `DEN_ORG_MODE=single_org` is enabled: fail fast, choose a configured slug, or
   migrate one org?
7. Should self-host docs call Den web "OpenWork Cloud" after Helm defaults to
   single-org mode, or rename that surface in docs to "OpenWork web" /
   "OpenWork admin" for private deployments?

## Documentation Updates Needed

Self-host and packaging docs need to stop describing the Helm path as if users
must understand multi-org creation.

- `packages/docs/start-here/self-host.mdx`: distinguish single-org private
  deployments from hosted OpenWork Cloud. The current "Cloud-style accounts,
  teams, and organization management" wording conflicts with a single-org Helm
  default.
- `packages/docs/start-here/self-host.mdx`: fix the "Minimal Working Stack"
  section, which says "two services" but lists three.
- `packages/docs/cloud/security-and-operations.mdx`: clarify that private
  single-org deployments still use org-scoped RBAC internally, while hosted cloud
  remains multi-org.
- `packaging/docker/README.md`: avoid calling every local/private web surface
  "OpenWork Cloud web app" after single-org mode lands.

## Proposed First Milestone

Milestone 1 should prove the backend invariant without changing the whole UI:

1. Add env and Helm config.
2. Add singleton org resolver.
3. Auto-attach users to singleton org in single-org mode.
4. Block extra org creation.
5. Disable email verification in single-org mode.
6. Add focused den-api tests.

After that, Milestone 2 can reshape Den web flows and end-to-end validation.
