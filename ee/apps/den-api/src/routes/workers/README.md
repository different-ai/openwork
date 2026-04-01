# Worker Routes

This folder owns worker lifecycle, runtime, billing, and heartbeat routes.

## Files

- `index.ts`: registers all worker route groups
- `activity.ts`: unauthenticated worker heartbeat endpoint authenticated by worker activity token
- `billing.ts`: user-facing cloud worker billing endpoints
- `core.ts`: list/create/get/update/delete worker routes and token lookup
- `runtime.ts`: worker runtime inspection and upgrade passthrough endpoints
- `shared.ts`: worker schemas, helper functions, response mapping, and shared DB/runtime utilities

## Middleware expectations

- Most worker routes use `requireUserMiddleware`
- Org-scoped worker routes should use `resolveUserOrganizationsMiddleware` to determine the current active org
- Request payloads, params, and query flags should use Hono Zod validators from `src/middleware/index.ts`

## Notes

- Activity heartbeat is the exception: it uses worker tokens instead of user auth
- Runtime endpoints proxy to the worker runtime using stored host tokens and instance URLs
- Provisioning logic lives in `src/workers/`, not in the route handlers themselves
