# Org Routes

This folder owns organization-facing Den API routes.

## Files

- `index.ts`: registers all org route groups
- `core.ts`: org creation, invitation preview/accept, and org context
- `invitations.ts`: invitation creation and cancellation
- `members.ts`: member role updates and member removal
- `roles.ts`: dynamic role CRUD
- `templates.ts`: shared template CRUD
- `shared.ts`: shared route-local helpers, param schemas, and guard helpers

## Middleware expectations

- `requireUserMiddleware`: the route requires a signed-in user
- `resolveOrganizationContextMiddleware`: the route needs the current org and member context
- `resolveMemberTeamsMiddleware`: the route needs the teams for the current org member

Import these from `src/middleware/index.ts` so route files stay consistent.

## Validation expectations

- Query, JSON body, and params should use Hono Zod validators
- Route files should read validated input with `c.req.valid(...)`
- Avoid direct `c.req.param()`, `c.req.query()`, or manual `safeParse()` in route handlers

## Why this is split up

The org surface is the largest migrated area so far. Splitting by concern keeps edits small and lets agents change invitations, members, roles, or templates without scanning one giant router file.
