# Admin Routes

This folder owns admin-only Den API surfaces.

## Files

- `index.ts`: registers the admin routes
- `control-center.ts`: the `/admin` landing page's Control Center (`GET /v1/admin/control-center`, `POST /v1/admin/control-center/refresh`), served from precomputed snapshots; see "Control Center snapshots" below
- `dashboard.ts`: gateway AI usage for the last 30 days (`GET /v1/admin/dashboard`) and on-demand platform active users (`GET /v1/admin/dashboard/active-users`)
- `free-auto-usage.ts`: free Auto usage across all organizations (`GET /v1/admin/free-auto/usage`)
- `security.ts`: threshold-based security signals across all organizations (`GET /v1/admin/security`) and the last 24 hours of refused, rate-limited and failed tenantless requests (`GET /v1/admin/security/requests`); the rules live in `security-findings.ts`
- `opportunity-outreach.ts`, `outreach-plays.ts`: the accounts worth writing to, one row per organization under its strongest reason, with the person to write to (`GET /v1/admin/opportunities/outreach`); see "Outreach list" below
- `opportunity-accounts.ts`: records what an admin did about an account (`POST /v1/admin/opportunities/accounts/:organizationId/actions`)
- `opportunities.ts`: recent organization adoption, verified non-personal email signals, and active Cloud skill/MCP counts, stored plan, paid status and recorded outreach (`GET /v1/admin/opportunities`)
- `opportunity-companies.ts`: signups grouped by verified company email domain across organizations, with plan, paid status and recorded outreach (`GET /v1/admin/opportunities/companies`)
- `runner-fleet.ts`: the cloud runner's celld nodes, read live from each node's own state endpoint (`GET /v1/admin/runner-fleet`, `/history`, `/events`); see "Runner fleet" below
- `computer-fleet.ts`: the sandboxes cloud conversations use as computers, as their providers report them, read through the headless runner (`GET /v1/admin/computer-fleet`, `/history`, `/computers/:source/:id`); see "Computer fleet" below
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
- `GET /v1/admin/computer-fleet?organization=`: every computer now (state, gateway pool or direct provider, size, times, image, what needs a look, whose it is); `status` is `not_configured` without a headless runner or when the runner has no computers. `organization` (an id, or `unknown`) lists only that organization's computers; totals, sources and the status stay the whole fleet's
- `GET /v1/admin/computer-fleet/computers/:source/:id`: one computer in full (its provider's record and rules, the gateway's placement decision, its conversation's organization, member and activity, and what happened to it); `404` when the provider has none by that id, `502 computer_unavailable` when the runner or provider cannot be read
- `GET /v1/admin/computer-fleet/history?range=24h|7d|30d`: the fleet's highest counts in each 10 minutes (24h) or hour (7d, 30d)

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

## Outreach list

`/admin › Opportunities` opens on a list a person can work through: who to write to, at which account, and why.
`outreach-plays.ts` holds the rules as pure functions; `opportunity-outreach.ts` reads the facts for them.

Reasons, strongest first (an account is listed once, with its other reasons as notes):

- `follow_up`: a follow-up date an admin set is due
- `payment`: a subscription is past due, unpaid, or its last payment failed
- `cancelling`: a subscription is set to end, or was canceled in the last 30 days
- `team_no_plan`: two or more people ran tasks in the last 14 days and there is no Team plan
- `seats_full`: every seat is in use
- `company`: people at one verified company domain ran tasks from separate workspaces
- `free_limit`: a member reached the free model limit in the last 7 days and there is no Models add-on
- `quiet_paying`: a subscription older than 14 days and no tasks seen in 14 days

"Ran tasks" is the Control Center's definition: a `task.*` telemetry event from the app. The activity query groups
`telemetry_event` by member over the `telemetry_event_ts_window` index before it joins anything. Money questions
name the workspace owner; usage questions name whoever ran tasks on the most days. Marking an account contacted
sets a follow-up a week out, so it leaves the list and comes back once if no reply is recorded. Dismissed and
closed accounts stay out. Telemetry can be off, so "no tasks seen" is never stated as inactivity, and an email
domain is never treated as proof of employment.

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

## Computer fleet

`/admin › Computer fleet` shows the sandboxes cloud conversations use as computers (`src/computer-fleet/`). Nothing
in OpenWork keeps a list of them: a conversation's computer is found again by its key at the provider, and only the
headless runner holds the providers' keys. So the runner lists them (`GET /v1/computers`: the sandbox gateway's
sandboxes and pools, and the direct provider's machines, whichever it is configured with) and Den reads that with
the runner credentials it already has. The page needs no setting of its own and Den holds no provider key.

- `state.ts`: one vocabulary of states for every provider, what needs a look (failed in the last day, stuck
  starting, pausing or stopping, past its expiry, running with no use for 30 minutes or longer where the runner's
  pause or the provider's own idle rule is longer, running two hours after its conversation last had a turn or an
  open view, or awake for more than half of a life of two days or more, where the provider counts run time), totals
  and the overall status. The last two exist because a desktop is never
  silent on the network: a provider's own idle rule does not stop a computer the runner failed to pause, so Den's
  own record of the conversation is the reliable sign. A provider's run total can lag by days while a computer runs. A computer's key is `hc-` and a
  hash of its conversation's session id, which is how it is tied to an organization.
- `service.ts`: readers within 15 seconds share one read of the runner's list. Organization names come from
  `headless_session_index` (Workbot conversations) and `remote_device`, read at most every five minutes. A
  background sampler records the fleet's counts every five minutes into `admin_metric_snapshot` (metric
  `computer_fleet_history`, one row per UTC hour, 31 days kept) through the `computer_fleet_sampler` lease.
- `history.ts`: folds readings into 10-minute buckets that keep the highest of each count.

One computer's page (`/admin/computer-fleet/<source>/<id>`) reads the provider through the runner again
(`GET /v1/computers/:source/:id`) and adds what Den holds for the conversation with that key: the organization, the
member, when a turn has been under way, and the events Workbot's server reported for the computer
(`remote_device_event`: views opened, pauses, resumes, rebuilds, failures). It never returns the conversation's name
or content. Nothing is run on the computer to answer, since a command would count as use: so what is installed
inside one (its guest version) is not shown, only the image it was built from and whether new computers still use it.
The gateway's own events need a runner key that may read its audit log (`audit:read`); without it the page says so
and shows Workbot's reports alone.

A runner from before `GET /v1/computers` answers 404: the page says the runner is too old, and nothing is recorded.
One from before `GET /v1/computers/:source/:id` lists computers without their image or the runner's pause rule, and a
computer's page says it needs a current runner.
Payloads are states, sizes, times, provider sandbox ids and organization names: nothing a computer holds.
