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
- `runner-fleet.ts`: the cloud runner's celld nodes, read live from each node's own state endpoint (`GET /v1/admin/runner-fleet`, `/history`, `/events`); see "Runner fleet" below
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

- `GET /v1/admin/runner-fleet`: every runner node now (open or closed to new cells, memory, cells in memory and owned, cells waiting for room); `status` is `not_configured` without `DEN_HEADLESS_FLEET_STATE_HOST`
- `GET /v1/admin/runner-fleet/history?range=24h|7d|30d`: per node, the worst reading in each 10 minutes (24h) or hour (7d, 30d)
- `GET /v1/admin/runner-fleet/events`: the same reading as a server-sent event stream, every five seconds; ends itself after two and a half minutes, and the page reconnects

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
keeps the last good snapshot, records the error and waits out the interval on every instance unless an admin refreshes
by hand. Each metric runs its queries one at a time, on a read replica when `DATABASE_READ_USERNAME` and
`DATABASE_READ_PASSWORD` are set. Queries read platform tables through indexed time windows
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

## Runner fleet

`/admin › Runner fleet` reads the cloud runner's celld nodes directly (`src/runner-fleet/`):

- `config.ts`: where the nodes answer, from `DEN_HEADLESS_FLEET_STATE_HOST` (a name that resolves to every node),
  `DEN_HEADLESS_FLEET_STATE_PORT` (default 8081) and `DEN_HEADLESS_FLEET_NODE_MEMORY_MB`. Unset, nothing is contacted.
- `reader.ts`, `state.ts`: resolve the name, ask each node `GET /state` on celld's internal listener (2.5 s each, in
  parallel, never anything but `/state`), and read the report into a node. celld's own flags decide whether a node is
  closed; memory against its default lines is only the fallback.
- `service.ts`: readers within four seconds share one read. A background sampler records the fleet once a minute
  into `admin_metric_snapshot` (metric `runner_fleet_history`, one row per UTC hour, 31 days kept); one replica
  samples at a time through the `runner_fleet_sampler` lease.
- `history.ts`: folds readings into 10-minute buckets that keep the worst of each figure.
- `events.ts`: the live stream.

celld's internal listener is its operator API and has no authentication, so it must only be reachable on a private
network. Payloads are counts, byte sizes and the first 12 characters of cell ids: no conversation content or owners.
