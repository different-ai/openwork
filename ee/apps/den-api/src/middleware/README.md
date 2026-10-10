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
  that must run something first, e.g. `orgMemberRoute(), requireFeature("permissions"), requireOrgPermission(key)`
  so a disabled feature answers 404 before any permission check.

In handlers, use `requirePermission(c, key)` / `hasPermission(c, key)` from
`routes/org/shared.ts`; outside a request, `resolvePermissionsForMember(...)` from
`permissions/resolve.ts`.

## Rule of thumb

- If a value is broadly useful across multiple route areas, put it here
- If a helper only exists for one route area, keep it in that route folder instead
