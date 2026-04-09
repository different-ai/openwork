# Den API

Hono-based Den control plane implementation (`den-api`, formerly `den-controller`).

This package is the active Den control plane implementation.

It carries the full migrated Den API route surface in a foldered Hono structure so agents can navigate one area at a time without scanning the whole service.

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

## TypeID validation

- Shared Den TypeID validation lives in `ee/packages/utils/src/typeid.ts`.
- Use `typeId.schema("...")` or the compatibility helpers like `normalizeDenTypeId("...", value)` when an endpoint accepts or returns a Den TypeID.
- `ee/apps/den-api/src/openapi.ts` exposes `denTypeIdSchema(...)` so path params, request bodies, and response fields all share the same validation rules and Swagger examples.
- Swagger now documents Den IDs with their required prefix and fixed 26-character TypeID suffix, so invalid IDs fail request validation before route logic runs.

## Migration approach

1. Keep `den-api` (formerly `den-controller`) as the source of truth for Den control-plane behavior.
2. Add endpoints in focused Hono route groups one surface at a time.
3. Reuse shared middleware and Zod validators instead of duplicating request/session/org plumbing.
4. Leave a short README in each route area when the structure changes so later agents can recover context fast.
