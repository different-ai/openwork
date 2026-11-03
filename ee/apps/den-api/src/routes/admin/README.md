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
- `feature-usage.ts`: per feature across organizations, whether it is used and working (`GET /v1/admin/feature-usage`, `GET /v1/admin/feature-usage/:key`), and who uses each feature in one organization (`GET /v1/admin/organizations/:organizationId/feature-usage`); see "Feature outcomes" below

## Current routes

- `GET /v1/admin/overview`
- `GET /v1/admin/control-center?range=7d|30d|90d`: every Control Center section from snapshots, each with `computedAt`, `stale` and its last refresh `error`; never runs the metric queries
- `POST /v1/admin/control-center/refresh`: schedules a recompute of every snapshot and returns 202 at once; at most once a minute across all admins (429 with `Retry-After` otherwise)
- `GET /v1/admin/dashboard`
- `GET /v1/admin/free-auto/usage`: members per organization and guests in aggregate, for the last 1–90 UTC days
- `GET /v1/admin/security`: findings for the last 1–30 days, compared with the previous range where it helps
- `GET /v1/admin/security/requests`: hourly refused, rate-limited and failed requests for the last 24 hours
- `GET /v1/admin/feature-usage?range=7d|30d`: every feature with organizations on, members using it, last use, a health state and, for background features, run outcomes and a per-day series
- `GET /v1/admin/feature-usage/:key?range=7d|30d`: one feature with failed and skipped runs by reason and one row per organization

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

## Feature outcomes

`/admin › Features` reads, per feature, who uses it (`feature_usage`, written by gated routes, client reports and
background work) and, for features that declare `outcomes: true` in `packages/features/src/registry.ts`, what they
did. Each such feature has exactly one reader in `src/feature-outcomes/readers.ts` (the typecheck and
`test/feature-outcomes.test.ts` fail without one). Readers aggregate the store that owns the outcomes and copy nothing:

- `workbotProactive`: `agent_check` daily counters (every member) plus `agent_member_check` failures and daily-limit
  hits (members with My agent, kept about 14 days)

Slack bot messages are generally available and no longer have a feature row.
Their operational diagnostics remain at `GET /v1/admin/slack-send-as-bot/outcomes?range=7d|30d`,
behind platform-admin authorization. The reader uses each member's latest
`rate_limit` daily window, so coverage is the last 24 hours whatever the range;
responses contain aggregate outcomes and refusal reasons, never message text.

A new background feature adds `outcomes: true` and a reader over the table it already writes; if a rollup is ever
needed, follow `capability_usage_event` / `capability_usage_rollups` rather than adding another usage store.

## Notes

This area is intentionally small for now, but it is its own folder so future admin/reporting endpoints have a clear home.
