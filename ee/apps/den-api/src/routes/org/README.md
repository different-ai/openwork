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

## Active organization model

- `POST /api/auth/organization/set-active` is the only Better Auth endpoint that should switch the user's active org explicitly.
- New sessions should get an initial `activeOrganizationId` from Better Auth session creation hooks in `src/auth.ts`.
- `GET /v1/org` returns the active organization from the current session, including a nested `organization.owner` object plus the current member and team context.
- `POST /v1/org` creates a new organization and switches the session to it. `PATCH /v1/org` updates the active organization.
- Active-org scoped resources should prefer top-level routes like `/v1/templates`, `/v1/skills`, `/v1/teams`, `/v1/roles`, `/v1/api-keys`, `/v1/llm-providers`, and plugin-system `/v1/...` routes. They should not require `:orgId` or `:orgSlug` in the path.
- Routes under `/v1/orgs/**` are reserved for cross-org flows that are not tied to the active workspace yet, such as invitation preview/accept.
- If a client needs to change workspaces, it should call Better Auth set-active first, then use the active-org scoped `/v1/...` resource routes.

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
