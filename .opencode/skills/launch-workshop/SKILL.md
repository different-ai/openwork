---
name: launch-workshop
description: Start, size, check, hand out, fix and stop a hands-on OpenWork workshop (one private Den + 1-99 Daytona desktops, fictional Outlook/Calendar/Drive/Jira/Confluence). Use when the user says "start the workshop", "give me N workshop desktops", "add seats", "send me the workshop links", "seat N is stuck", "reset the workshop" or "stop the workshop".
---

# Launch a workshop

Scripts live in `scripts/workshop/` (run from the repo root); details and the
safety model are in `worlds/WORKSHOP-FLEET.md`. Private output (attendee links,
member test logins) goes to `~/.openwork/workshops/<stage>/`. Never paste
viewer links anywhere except the facilitator's own conversation unless they ask:
each link controls one attendee's desktop.

## Start ("start the workshop with N seats")

1. Timing: 60–120 minutes before the session, never more than ~3 hours before
   (workplace OAuth approvals last about 8 hours).
2. Confirm the size and cost in one line, then run in the foreground (~2 minutes
   per wave of ten seats, plus ~2.5 minutes for the Den):
   ```sh
   scripts/workshop/start.sh <seats 1-99> <lifetime-minutes, default 360> <stage, default event> <budget-usd, default 200>
   ```
   It refuses (before creating anything) if the estimate exceeds the budget, the
   team quota can't fit the seats, or the app commit isn't merged into dev.
   Report that message; don't work around it. A different `<stage>` name gives
   an independent second launch (its own Den; seats can't share skills across
   launches).
3. Read `READY x/y`. For each `NOT READY` seat run
   `scripts/workshop/seat.sh attendeeNN prepare <stage>` once; if it still fails,
   leave it out and say so.
4. Spot-check: `seat.sh attendee01 status <stage>` and `seat.sh attendee01 task
   <stage>` must both print `PASS`; then `seat.sh attendee01 prepare <stage>` so
   the seat starts on a fresh task.
5. `scripts/workshop/links.sh <stage>` prints one ready-to-paste message per
   seat; give it to the facilitator verbatim.

## During the workshop

| Request | Command |
|---|---|
| Seat frozen / black screen | `seat.sh attendeeNN unlock <stage>` (attendee reloads the page) |
| Task stuck / running forever | `seat.sh attendeeNN stop <stage>` |
| "My data is a mess" | `seat.sh attendeeNN reset <stage>` |
| Model missing / no composer | `seat.sh attendeeNN prepare <stage>` |
| Is this seat OK? | `seat.sh attendeeNN status <stage>` |
| Resend a link | `seat.sh attendeeNN link <stage>` |
| More seats | a new launch: `start.sh <n> <minutes left> <new-stage>` |

Reset restores the fictional data only; sign-in and connections stay, chats
and desktop files remain.

## Stop

`scripts/workshop/stop.sh <stage>` for each stage the facilitator names. Only
tear down stages you were asked to.
