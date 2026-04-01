# Middleware

This folder contains reusable Hono middleware that route areas can compose as needed.

## Files

- `index.ts`: public export surface for all shared middleware
- `admin.ts`: requires an authenticated allowlisted admin
- `current-user.ts`: requires an authenticated user
- `user-organizations.ts`: loads the orgs the current user belongs to
- `organization-context.ts`: loads org + current member context for `:orgSlug` routes
- `member-teams.ts`: loads the teams the current org member belongs to
- `validation.ts`: shared Hono Zod validator wrappers for JSON, query, and params

## Available context

- `c.get("user")`: current authenticated user
- `c.get("session")`: current Better Auth session
- `c.get("userOrganizations")`: orgs for the current user
- `c.get("activeOrganizationId")`
- `c.get("activeOrganizationSlug")`
- `c.get("organizationContext")`: org record, current member, members, invites, roles
- `c.get("memberTeams")`: teams for the current org member

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

## Rule of thumb

- If a value is broadly useful across multiple route areas, put it here
- If a helper only exists for one route area, keep it in that route folder instead
