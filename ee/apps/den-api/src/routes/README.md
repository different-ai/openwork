# Routes

This folder groups Den API endpoints by product surface instead of keeping one large router file.

## Layout

- `auth/`: Better Auth mount and desktop handoff routes
- `me/`: current-user routes that describe the signed-in user and their org access
- `org/`: organization routes split into focused files by concern
- `admin/`: admin-only operational endpoints
- `workers/`: worker lifecycle, runtime, billing, and heartbeat routes

## Conventions

- Each route area exports a single `register...Routes()` function from its `index.ts`
- Request validation should use Hono Zod validators from `src/middleware/index.ts`
- Shared auth/org/team context should come from `src/middleware/index.ts`, not from ad hoc request parsing
- New route areas should get their own folder plus a local `README.md`

## Why this exists

Agents often need to change one endpoint family quickly. Keeping route areas isolated makes it easier to understand ownership and avoid accidental cross-surface regressions.
