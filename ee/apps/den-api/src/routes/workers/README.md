# Worker Routes

This folder owns the remaining worker routes. Each OpenWork Web instance is stored as a worker row; its lifecycle (start, wake, retry, update, gateway resolve) lives in `src/routes/cloud/`.

## Files

- `index.ts`: registers the worker route groups
- `activity.ts`: worker heartbeat endpoint authenticated by the worker activity token. Every OpenWork Web sandbox posts here; it is the only writer of `last_active_at`, which the idle-stop loop reads
- `core.ts`: list the active organization's workers and delete one worker
- `shared.ts`: worker schemas, response mapping, cloud provisioning (`continueCloudProvisioning`), and delete cascade

## Middleware expectations

- List and delete use `orgMemberRoute({ useUserOrganizations: true })` to resolve the active org
- Request payloads, params, and query flags should use Hono Zod validators from `src/middleware/index.ts`

## Notes

- Activity heartbeat is the exception: it uses worker tokens instead of user auth
- Provisioning logic lives in `src/workers/`, not in the route handlers themselves
