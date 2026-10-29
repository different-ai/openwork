# Middleware

This folder contains reusable Hono middleware that route areas can compose as needed.

## Files

- `index.ts`: public export surface for all shared middleware
- `admin.ts`: requires an authenticated allowlisted admin
- `current-user.ts`: requires an authenticated user
- `user-organizations.ts`: loads the orgs the current user belongs to
- `organization-context.ts`: loads org + current member context for `:orgSlug` routes
- `member-teams.ts`: loads the teams the current org member belongs to
- `member-permissions.ts`: resolves the current org member's effective permissions once per request
- `validation.ts`: shared Hono Zod validator wrappers for JSON, query, and params

## Available context

- `c.get("user")`: current authenticated user
- `c.get("session")`: current Better Auth session
- `c.get("userOrganizations")`: orgs for the current user
- `c.get("activeOrganizationId")`
- `c.get("activeOrganizationSlug")`
- `c.get("organizationContext")`: org record, current member, members, invites
- `c.get("memberTeams")`: teams for the current org member
- `c.get("memberPermissions")`: effective permissions for the current org member (set by `orgPermissionRoute` or `resolveMemberPermissionsMiddleware`)

## Usage pattern

Import from `src/middleware/index.ts`:

```ts
import {
  jsonValidator,
  paramValidator,
  requireUserMiddleware,
  resolveOrganizationContextMiddleware,
} from "../../middleware/index.js"
```

Then compose only what a route needs.

## Access markers (route-access.ts)

Every route registers exactly one access marker (deny by default):

- `orgMemberRoute()`: any active member of the organization.
- `orgPermissionRoute(key)`: the member must hold permission `key` from the catalog in
  `@openwork/types/den/permissions`. Sensitive keys also require a recent sign-in.
  With the `permissions` feature off, admins hold every key and members none.
- `orgRoleRoute(["owner"])`: owner-only actions (delete organization, transfer ownership).
- `requireOrgPermission(key)`: not a marker. Same check as `orgPermissionRoute`, for routes
  that must run something first, e.g. `orgMemberRoute(), requireFeature("managedDeployments"), requireOrgPermission(key)`
  so a disabled feature answers 404 before any permission check.

In handlers, use `requirePermission(c, key)` / `hasPermission(c, key)` from
`routes/org/shared.ts`; outside a request, `resolvePermissionsForMember(...)` from
`permissions/resolve.ts`.

## Self-hosted installation authority

Installation diagnostics (Den's services, server facts and Check now) belong to
the self-hosted installation administrator, never to an organization role,
permission grant or ownership. `isLocalDeploymentOperator(principal)` in
`admin.ts` is the one check:

- an allowlisted operator's genuine user session (`hasLocalDeploymentOperatorSessionAuthority`), or
- an API key whose owning user (`apiKey.referenceId`, the same `user.id`) is on the allowlist.
  An API key acts for the user who created it; only that owner's allowlist entry counts.

The authoritative deployment comes from `env.features.deployment`, never request
headers; hosted deployments return false before querying the allowlist.
`requireLocalDeploymentOperatorMiddleware` and the caller-specific
`canManageDeploymentServices` hint on `GET /v1/org` use the same check; the hint
answers false on lookup errors so it never blocks core organization context.
Neither widens `adminRoute()`.

Initial administrator setup (`completeInitialAdminBootstrapSignup` in
`initial-admin-bootstrap.ts`) persists the verified setup email in
`AdminAllowlistTable` via `ensureBootstrappedPlatformAdmin`. Thus a setup-created
operator works without `DEN_BOOTSTRAP_ADMIN_EMAILS`; that variable only seeds
additional allowlist entries. Removing allowlist authority removes this access.

Readiness has no feature flag. Every entry point reuses `service-readiness-runtime.ts`
(`deploymentServicesSnapshot`, `currentDeploymentServices`, `refreshDeploymentServices`)
and its singleton controller, including durable admission, in-flight checks,
recent-result coalescing and cached snapshots. Checks are advisory: they never
block startup or requests. The minimal member-safe `/v1/org/service-readiness`
projection (and `deploymentCapabilities.serviceReadiness` on `GET /v1/org`)
never starts a check and withholds settings, notes, durations and server facts.

## Rule of thumb

- If a value is broadly useful across multiple route areas, put it here
- If a helper only exists for one route area, keep it in that route folder instead
