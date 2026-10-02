# Admin Routes

This folder owns admin-only Den API surfaces.

## Files

- `index.ts`: registers the admin routes
- `free-auto-usage.ts`: free Auto usage across all organizations (`GET /v1/admin/free-auto/usage`)

## Current routes

- `GET /v1/admin/overview`
- `GET /v1/admin/free-auto/usage`: members per organization and guests in aggregate, for the last 1–90 UTC days

## Expectations

- Gate all routes with `requireAdminMiddleware`
- Keep admin reporting logic here instead of mixing it into auth or org routes
- Prefer query validators for report flags such as `includeBilling`

## Notes

This area is intentionally small for now, but it is its own folder so future admin/reporting endpoints have a clear home.
