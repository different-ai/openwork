# Notify when an Automation run fails (`automationFailureNotifications`)

- **Feature key:** `automationFailureNotifications`
- **Deployments:** cloud and self-hosted (`everywhere`), off by default
- **Author:** @reachjalil

## What people get

Automations run on a schedule, usually while nobody is looking. Before this
feature, a failed run was visible only in the Automation's run history, so
owners found out late or not at all.

With the feature on, the OpenWork app tells the owner once when one of
their Automations fails, wherever they are in the app:

- an entry in the notification center, with a toast while the app is open,
  for example: **Daily summary needs a connection**, *Gmail needs to be
  reconnected, so this run could not use it. Reconnect Gmail in OpenWork, then
  run the Automation again.*
- a system notification while the app is in the background, following the
  person's desktop notification setting (it counts as an important
  notification).

This covers every failed run: Cloud and desktop runs, timeouts and runs that
could not use a connection (`connection_action_required`). Cancelled runs,
skipped runs and missed runs do not notify.

## How it works

The app already lists the member's Automations with each one's latest run.
With the feature on, it reads that list every minute, including in the
background, and announces runs that failed after the latest finish time it
has already seen. That watermark is stored per organization on the
computer, so a run is announced once across restarts and windows. The first
check after the feature turns on only records the watermark: earlier
failures are not announced. When the Automations page is open, it shares the
same request, so no second poll is added.

Only each Automation's latest run is listed, so if one Automation fails twice
between checks, the owner gets one notification.

## Off

Turning it off stops the poll and the notifications at the next feature
refresh, within a minute. Notifications already shown stay in the
notification center, and nothing is stored in Den. Once the app sees the
feature is off it forgets its watermark, so turning the feature back on
starts fresh rather than announcing what failed in between. If the app was
closed or offline, failures from that time are announced when it next checks,
as long as the feature stayed on.

## Try it

1. Turn `automationFailureNotifications` on for your organization in `/admin`.
2. Open the OpenWork app signed in to that organization and wait a minute so
   it records the watermark.
3. Make an Automation fail, for example by disconnecting a connection its
   instructions use, then run it now.
4. Within a minute of the run finishing, the notification center shows the
   failure; with the app in the background a system notification appears.

Usage is recorded when a notification is shown.

## What to watch

- Den request volume for `GET /v1/automations`: one request a minute per
  signed-in app with the feature on.
- Reports of repeated notifications for one run (the watermark is not being
  stored) or of missing ones.

## Code

- `apps/app/src/react-app/domains/automations/automation-failure-watch.ts`:
  which runs to announce, and the watermark.
- `apps/app/src/react-app/domains/automations/automation-failure-notifier.tsx`:
  the gated poll and the notifications, mounted in `shell/app-root.tsx`.
- `apps/app/src/react-app/shell/desktop-notifications.ts`: the
  `automation.failed` system notification.
