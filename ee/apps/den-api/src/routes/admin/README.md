# Admin Routes

This folder owns admin-only Den API surfaces.

## Files

- `index.ts`: registers the admin routes
- `control-center.ts`: the `/admin` landing page's Control Center (`GET /v1/admin/control-center`, `POST /v1/admin/control-center/refresh`), served from precomputed snapshots; see "Control Center snapshots" below
- `dashboard.ts`: gateway AI usage for the last 30 days (`GET /v1/admin/dashboard`) and on-demand platform active users (`GET /v1/admin/dashboard/active-users`)
- `free-auto-usage.ts`: free Auto usage across all organizations (`GET /v1/admin/free-auto/usage`)
- `security.ts`: threshold-based security signals across all organizations (`GET /v1/admin/security`) and the last 24 hours of refused, rate-limited and failed tenantless requests (`GET /v1/admin/security/requests`); the rules live in `security-findings.ts`
- `opportunities.ts`: recent organization adoption, verified non-personal email signals, and active Cloud skill/MCP counts, stored plan, paid status and recorded outreach (`GET /v1/admin/opportunities`)
- `opportunity-companies.ts`: signups grouped by verified company email domain across organizations, with plan, paid status and recorded outreach (`GET /v1/admin/opportunities/companies`)

## Current routes

- `GET /v1/admin/overview`
- `GET /v1/admin/control-center?range=7d|30d|90d`: every Control Center section from snapshots, each with `computedAt`, `stale` and its last refresh `error`; never runs the metric queries
- `POST /v1/admin/control-center/refresh`: schedules a recompute of every snapshot and returns 202 at once; at most once a minute across all admins (429 with `Retry-After` otherwise)
- `GET /v1/admin/dashboard`
- `GET /v1/admin/free-auto/usage`: members per organization and guests in aggregate, for the last 1–90 UTC days
- `GET /v1/admin/security`: findings for the last 1–30 days, compared with the previous range where it helps
- `GET /v1/admin/security/requests`: hourly refused, rate-limited and failed requests for the last 24 hours

## Expectations

- Gate all routes with `requireAdminMiddleware`
- Keep admin reporting logic here instead of mixing it into auth or org routes
- Prefer query validators for report flags such as `includeBilling`

## Control Center snapshots

The metric definitions live in `src/admin-metrics/`, shared with the den-admin MCP tools
(`den_overview`'s task-running users and `den_retention`'s cohorts):

- `definitions.ts`: pure rules (UTC days, Monday weeks, weekly lifecycle, reactivation, activation funnel, retention cohorts, sharing and reuse rates)
- `metrics.ts`: one query set per section: pulse, lifecycle, invitations, sharing, revenue, accounts
- `snapshots.ts`: the refresh path and the read path over `admin_metric_snapshot` and `admin_metric_refresh_lease`
- `worker.ts`: the background loop started from `server.ts`

A real active user ran at least one `task.*` event with a session id from the app (`telemetry_event.source = 'app'`),
excluding setup agents and removed members. Pulse refreshes every `ADMIN_METRICS_FAST_INTERVAL_MS` (default 5 minutes);
the other sections every `ADMIN_METRICS_HEAVY_INTERVAL_MS` (default 30 minutes). `ADMIN_METRICS_REFRESH_ENABLED=0`
turns the loop off. Each metric holds a lease while it runs, so one den-api instance recomputes it at a time; a failure
keeps the last good snapshot and records the error. Queries read platform tables through indexed time windows
(`telemetry_event_ts_window`, `invitation_created_at`, `created_at`/`bucket_start` indexes), select no credential or
secret columns and read invitations only as counts and durations. Payloads are aggregates, apart from organization names.

## Notes

This area is intentionally small for now, but it is its own folder so future admin/reporting endpoints have a clear home.
