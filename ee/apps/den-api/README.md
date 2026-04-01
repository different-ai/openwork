# Den API

Hono-based successor to `ee/apps/den-controller`.

This package is the Hono-based successor to `ee/apps/den-controller`.

It now carries the full migrated Den API route surface in a foldered Hono structure so agents can navigate one area at a time without scanning the whole service.

## Quick start

```bash
pnpm --filter @openwork-ee/den-api dev:local
```

## Current routes

- `GET /` -> `302 https://openworklabs.com`
- `GET /health`
- Better Auth mount at `/api/auth/*`
- desktop handoff routes under `/v1/auth/*`
- current user routes under `/v1/me*`
- organization routes under `/v1/orgs*`
- admin routes under `/v1/admin*`
- worker lifecycle and billing routes under `/v1/workers*`

## Folder map

- `src/routes/auth/`: Better Auth mount + desktop handoff endpoints
- `src/routes/me/`: current user and current user's org resolution routes
- `src/routes/org/`: organization CRUD-ish surfaces, split by area
- `src/routes/admin/`: admin-only reporting endpoints
- `src/routes/workers/`: worker lifecycle, billing, runtime, and heartbeat endpoints
- `src/middleware/`: reusable Hono middleware for auth context, org context, teams, and validation

Each major folder also has its own `README.md` so future agents can inspect one area in isolation.

## Migration approach

1. Keep `den-controller` as the source of truth while the migration is still in flight.
2. Port endpoints to focused Hono route groups one surface at a time.
3. Reuse shared middleware and Zod validators instead of duplicating request/session/org plumbing.
4. Leave a short README in each route area when the structure changes so later agents can recover context fast.
