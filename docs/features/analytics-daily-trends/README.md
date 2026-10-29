# Analytics: daily trends

Feature key: `analyticsDailyTrends` · Deployments: cloud and self-hosted · Default: off · Author: @benjaminshafii

## What people get

Usage & adoption (Den › Analytics) today only charts activity per week over
12 weeks, so a spike or a dead day disappears inside a weekly bar. With this
feature on, the three trend charts (active users, sessions, tasks completed
and failed) show one bar per UTC day for the last 30 days, today included. A
**Daily / Weekly** switch next to the project filter returns to the 12-week
weekly charts. Daily is selected by default. The project filter applies to
both views.

The summary cards (this week, last 30 days) and the Models section do not
change.

![Usage & adoption, daily trends on](./daily-on.png)

## How it works

- `GET /v1/telemetry/analytics` adds a `daily` array (30 entries,
  `{ day, activeMembers, sessions, tasksCompleted, tasksFailed }`) only when the
  feature is on for the caller's organization. `weekly` is unchanged.
- Days are UTC calendar days starting at midnight UTC 29 days ago. The last
  entry is today so far. Events from a client clock that runs ahead count as
  today.
- The query reuses the weekly trend's plan (`selectDailyActivity` in
  `ee/packages/telemetry/src/analytics.ts`) over a shorter 30-day window, so
  it adds one indexed scan per page load.

## Turning it off

The API stops sending `daily` and the page goes back to the weekly charts with
no switch. Nothing is stored, so turning it off or back on loses nothing.

## What to watch

Latency of `GET /v1/telemetry/analytics` for large organizations, filtered by
project and unfiltered.
