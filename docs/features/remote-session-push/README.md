# Remote-session push (`remoteSessionPush`)

> **Generally available:** `remoteSessionPush` is retired; the enabled behavior is now standard. Permissions, organization settings and entitlements still apply. Any rollout, off-state or kill-switch instructions below describe the historical rollout; see [the retirement guide](../ga-rollout-retirement/README.md).

- **Key:** `remoteSessionPush`
- **Deployments:** cloud and self-hosted
- **Default:** off
- **Author:** @benjaminshafii

## What changes

A task sent to a person's desktop from another computer, Workbot or an agent
(`remote-session:create` with a registered or desktop target) starts within a
second or two instead of up to a minute later.

Without the feature, an idle desktop finds new tasks only through its regular
work poll, which runs once a minute (`RUNNER_WORK_POLL_MS`, reduced from a push
stream in #3931 to cut load). Recording the remote-sessions demo, tasks took
20 to 47 seconds to start.

With the feature on:

1. **Den** (`ee/apps/den-api/src/routes/session-runners/index.ts`): a desktop
   runner that sends `X-OpenWork-Remote-Session-Push: 1` on
   `GET /v1/automation-runners/events` hears `remote_session_work_available`
   once per remote-session command queued for it. A command queued on the
   same Den instance wakes the stream at once
   (`remote-sessions/work-signal.ts`); one queued on another instance is found
   by a pending-command check that runs at most every 5 seconds per open
   stream.
2. **Desktop** (`apps/desktop/electron/automation-runner.mjs`): keeps that
   stream open and checks for work as soon as an announcement arrives. The
   minute poll stays as the fallback.

## Cost

One long-lived connection per signed-in desktop, plus at most one indexed
pending-command query every 5 seconds per connection
(`remote_session_command` by organization, owner and status). Automation
notifications on the same stream are unchanged.

## Turning it off

Use the kill switch or turn the organization off in `/admin`. Open streams end
within about 15 seconds; desktops reconnect, get `404 feature_disabled`, and
ask again every 10 minutes. Tasks are never lost: the minute poll still picks
them up, only more slowly.

## How to try it

Turn it on for an organization, sign in two desktops as the same member, and
from one of them ask the agent to start a task on the other. The other desktop
should show the session in its sidebar within a couple of seconds.

## What to watch

- Den: open SSE connections on `/v1/automation-runners/events` and the query
  rate on `remote_session_command`.
- Desktop logs: `remote session push reconnecting: …` repeating means the
  stream keeps dropping; `announced work check failed: …` means the check
  after an announcement failed (the minute poll still runs).
