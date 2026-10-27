# Admin Routes

This folder owns admin-only Den API surfaces.

## Files

- `index.ts`: registers the admin routes
- `free-auto-usage.ts`: free Auto usage across all organizations (`GET /v1/admin/free-auto/usage`)
- `security.ts`: threshold-based security signals across all organizations (`GET /v1/admin/security`) and the last 24 hours of refused, rate-limited and failed tenantless requests (`GET /v1/admin/security/requests`); the rules live in `security-findings.ts`
- `opportunities.ts`: recent organization adoption, verified non-personal email signals, and active Cloud skill/MCP counts, stored plan, paid status and recorded outreach (`GET /v1/admin/opportunities`)
- `opportunity-companies.ts`: signups grouped by verified company email domain across organizations, with plan, paid status and recorded outreach (`GET /v1/admin/opportunities/companies`)

## Current routes

- `GET /v1/admin/overview`
- `GET /v1/admin/free-auto/usage`: members per organization and guests in aggregate, for the last 1–90 UTC days
- `GET /v1/admin/security`: findings for the last 1–30 days, compared with the previous range where it helps
- `GET /v1/admin/security/requests`: hourly refused, rate-limited and failed requests for the last 24 hours

## Expectations

- Gate all routes with `requireAdminMiddleware`
- Keep admin reporting logic here instead of mixing it into auth or org routes
- Prefer query validators for report flags such as `includeBilling`

## Notes

This area is intentionally small for now, but it is its own folder so future admin/reporting endpoints have a clear home.
