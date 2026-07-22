# Den API

Hono-based Den control plane implementation (`den-api`, formerly `den-controller`).

This package is the active Den control plane implementation.

It carries the full migrated Den API route surface in a foldered Hono structure so agents can navigate one area at a time without scanning the whole service.

## Quick start

```bash
pnpm --filter @openwork-ee/den-api dev:local
```

## Local demo org seed

With a local Den MySQL database running, seed a demo organization:

```bash
pnpm --filter @openwork-ee/den-api seed:demo-org
```

This creates `Acme Robotics` with demo users, teams, pending invites, and an imported Anthropic Knowledge Work Plugins marketplace. It is guarded by `OPENWORK_DEV_MODE=1`, defaults to the local Den DB URL, and does not create workers or active external integrations.

Default owner login: `alex@acme.test` / `OpenWorkDemo123!`.

## Observability

`DEN_OBSERVABILITY_BACKEND` selects one backend: `none`, `otel`, or `sentry`.

- `none` (default): structured JSON logs are written to stdout.
- `otel`: initializes the OpenTelemetry Node SDK before Hono/DB imports, exports OTLP HTTP/protobuf traces, metrics, and logs from standard `OTEL_*` variables, and uses `@hono/otel` for normalized request spans/metrics without inbound HTTP auto-instrumentation.
- `sentry`: initializes `@sentry/hono/node` before app imports and uses the official Hono middleware for errors/tracing/Sentry Logs. Do not combine it with the OTEL backend.

The request access log records request id, method, normalized route, status, and duration, and omits health/readiness noise. Health/readiness requests also skip den-api's Hono observability middleware. Authorization, cookie, body, and query values are redacted from app telemetry. `OTEL_SERVICE_NAME` overrides the default `den-api` service name. Daytona's own OTEL bootstrap remains disabled; do not set Daytona OTEL enable variables from den-api.

Builds generate source maps. Sentry source maps are uploaded only when `DEN_OBSERVABILITY_BACKEND=sentry` and `SENTRY_AUTH_TOKEN`, `SENTRY_ORG`, `SENTRY_PROJECT`, and `SENTRY_RELEASE` are present; `SENTRY_DIST` is passed through when set. The auth token must stay in secret storage and is never written to env examples or logs.

## Current routes

- `GET /` -> `302 https://openworklabs.com`
- `GET /health`
- Better Auth mount at `/api/auth/*`
- desktop handoff routes under `/v1/auth/*`
- current user routes under `/v1/me*`
- organization routes under `/v1/orgs*`
- active-organization SCIM management routes under `/v1/scim*`
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
