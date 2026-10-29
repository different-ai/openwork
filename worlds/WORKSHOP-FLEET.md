# Hands-on workshop on Daytona

One command creates **one private Den** (Gateway, workshop model, five per-member
OAuth connectors to the fictional workplace) and **N attendee desktops** (1–99),
each signed in as its own ordinary member with a $5 model allowance.

```sh
scripts/workshop/start.sh 30 360          # 30 seats for 6 hours, stage "event"
scripts/workshop/links.sh                 # one ready-to-paste message per seat
scripts/workshop/seat.sh attendee07 stop  # status|task|stop|unlock|reset|prepare|link
scripts/workshop/stop.sh                  # tear everything down
```

The `launch-workshop` skill wraps these, so "start the workshop with 30 seats"
in OpenWork does the same. Private files (attendee links, member test logins)
go to `~/.openwork/workshops/<stage>/` (override with `WORKSHOP_HOME`), never
into a checkout.

## Changing the size

- **Seats:** the first argument, 1–99. Seat names are `attendee01…attendee99`;
  attendees share skills with each other by the name at the bottom left of the
  screen ("Attendee 07"). Everyone in one launch shares one Den.
- **Budget:** `start.sh <seats> <minutes> <stage> <budget-usd>` refuses to start
  when the estimate (`(seats + 1) × 4 CPU × list price`, plus disk) exceeds the
  budget (default $200). 50 seats for 6 hours is about $110.
- **Quota:** the launch checks the team's Daytona container quota first and
  says how many seats fit. Each sandbox is 4 CPU / 8 GiB / 10 GiB (fixed by the
  snapshot); the current quota (250 CPU) holds about 60 sandboxes at once.
- **Speed:** seats start ten at a time, staggered, with Daytona rate limits
  retried. Measured: 20 seats in 7–8 minutes; one seat takes about 2 minutes.
  A failed seat is reported and never tears down the others.

## Timing

Start 60–120 minutes before the session: the fictional workplace's OAuth
approvals last about 8 hours. Desktops run in the attendee's time zone
(`WORKSHOP_TIMEZONE`, default `America/Los_Angeles`).

## Source and snapshot

- `WORKSHOP_REF` (default in `scripts/workshop/common.sh`) is the app commit.
  It **must already be merged into `origin/dev`**: attendees are signed in to
  that code, so an unreviewed commit could capture their sign-in. Test
  unmerged code with the normal preview worlds instead.
- `WORKSHOP_SNAPSHOT` is a clean, **signed-out** desktop snapshot built from that
  commit (`worlds/workshop-clone.ts --phase base`, ~18 minutes, once per app
  version). It holds no sign-in, cookies or keys. Never snapshot a signed-in
  desktop. Set it empty to build each desktop from source (about 3 minutes per
  seat instead of about 1).
- A snapshot is only used when it matches its reviewed entry in
  `scripts/workshop/snapshots.json` (Daytona ID, image digest, audited source
  sandbox, app commit). A replaced or unknown snapshot is refused before any
  desktop exists. To use a new snapshot, add its entry (from the clone report
  and `GET /api/snapshots/<name>`) in a reviewed PR.

## Safety

- All sandboxes are provider-confirmed private. Each viewer link is a bearer
  capability for one desktop: send each to one person.
- The model key lives only in Den's encrypted provider storage; the provider
  is granted to the budgeted attendees only, never organization-wide.
- Den runs in production mode on the sandbox's private interface. Its database
  account has a per-boot random password, is limited to its own database and
  to the backend's own address; there is no network root account. Mail goes to
  a loopback-only discard sink for `workshop.test` addresses.
- Reset (`seat.sh … reset`, or the facilitator reset in
  `evals/packages/open-workplace/WORKSHOP.md`) restores the fictional
  Outlook/Calendar/Drive/Jira/Confluence data and keeps sign-in and connections.

## Checks

```sh
node --test worlds/workshop-pair.test.ts worlds/workshop-fleet.test.ts worlds/lib/workshop-*.test.ts
node --test .devcontainer/workshop-private-cohost.test.mjs
cd evals && ./node_modules/.bin/tsc -p tsconfig.workshop.json --noEmit
```

Live: `node worlds/workshop-steps-check.ts <seat-dir> "Attendee 02"` runs the
attendee handout (connectors, three-tool brief, PowerPoint, create/share/reuse a
skill) on a running seat. `worlds/workshop-pair-check.ts` holds the per-seat
operator commands.
