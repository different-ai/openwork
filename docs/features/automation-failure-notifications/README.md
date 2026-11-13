# Notify when an Automation run fails or is missed (`automationFailureNotifications`)

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
could not use a connection (`connection_action_required`). Cancelled runs and
runs skipped for another reason do not notify.

### A run that was missed

A Desktop Automation runs only while one of the owner's desktops is open,
signed in and awake. When a run comes due and no desktop picks it up, Den
records it as missed. The app then says so once, the next time it checks, with
a message that stays until it is answered:

> **Daily summary didn't run**
> Missed — no desktop was connected. Run it now, or move it to the cloud so it
> runs even when your desktop is offline.
> [Run now] [Move to cloud]

- **Run now** queues the run that was missed. In the desktop app it runs on
  the desktop. In a browser, which cannot run it, the button reads **Run in
  cloud** and runs that one occurrence in the cloud; the Automation stays
  where it is.
- **Move to cloud** moves the Automation's schedule to the cloud, so its next
  runs no longer need a desktop. The confirmation offers **Run now** for the
  run that was missed. It is offered only when the cloud can run the member's
  Automations and the Automation still has runs ahead. A cloud run reaches the
  member's connected accounts and, when they have one, their cloud computer's
  files. It does not reach files on the desktop. The move can be undone by
  editing the Automation.

If Den refuses either one, for example because the Automation's model cannot
be used in the cloud, the app shows Den's reason with a button that opens the
Automation. A missed run of an archived Automation, or of one already waiting
on a fix of its own, does not notify.

## How it works

The app already lists the member's Automations with each one's latest run.
With the feature on, it reads that list every minute, including in the
background, and announces runs that failed or were missed after the latest
finish time it has already seen. That watermark is stored per organization on the
computer, so a run is announced once across restarts and windows. The first
check after the feature turns on only records the watermark: earlier
failures are not announced. When the Automations page is open, it shares the
same request, so no second poll is added.

Only each Automation's latest run is listed, so if one Automation fails twice
between checks, the owner gets one notification.

For a missed run the app also asks Den where the member's Automations can run
(`GET /v1/automation-runners`, the request the Automation editor already
makes), once per check that found one. The two buttons call the existing run
and update routes; nothing new was added to Den.

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
5. For a missed run: schedule a Desktop Automation a few minutes ahead, quit
   the desktop app until the time has passed and Den has recorded the run as
   missed, then open the app again. Within a minute it offers **Run now** and,
   when the cloud is available, **Move to cloud**.

Usage is recorded when a notification is shown.

## What to watch

- Den request volume for `GET /v1/automations`: one request a minute per
  signed-in app with the feature on.
- Reports of repeated notifications for one run (the watermark is not being
  stored) or of missing ones.

## Code

- `apps/app/src/react-app/domains/automations/automation-failure-watch.ts`:
  which runs to announce, the watermark, and what a missed run offers.
- `apps/app/src/react-app/domains/automations/automation-failure-notifier.tsx`:
  the gated poll, the notifications and the two missed-run actions, mounted in
  `shell/app-root.tsx`.
- `apps/app/src/react-app/shell/desktop-notifications.ts`: the
  `automation.failed` and `automation.missed` system notifications.
