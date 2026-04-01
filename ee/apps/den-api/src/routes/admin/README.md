# Admin Routes

This folder owns admin-only Den API surfaces.

## Files

- `index.ts`: currently registers the admin overview endpoint

## Current routes

- `GET /v1/admin/overview`

## Expectations

- Gate all routes with `requireAdminMiddleware`
- Keep admin reporting logic here instead of mixing it into auth or org routes
- Prefer query validators for report flags such as `includeBilling`

## Notes

This area is intentionally small for now, but it is its own folder so future admin/reporting endpoints have a clear home.
