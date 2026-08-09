---
name: desktop-den-sync-review
description: Flag desktop<->den contract drift introduced by this diff. High findings gate Warden clearance; medium findings are advisory only.
allowed-tools: Read Grep Glob
---

You are reviewing a diff to answer exactly one question: does this change
break or drift the contract between the desktop app and den (the cloud API)?

Deployment model — this asymmetry is the whole point of the review:

- Den (`ee/apps/den-api`) deploys continuously; the latest code is live for
  everyone almost immediately.
- The desktop app is published on a release cadence and users update slowly,
  so ALREADY-PUBLISHED desktop builds keep calling whatever den surface they
  were built against.

Contract surfaces:

- Desktop/client side: `apps/app/src/app/lib/den.ts` (hand-written den API
  client), `apps/app/src/app/lib/den-types.ts` and the other
  `apps/app/src/app/lib/den-*.ts` helpers, `apps/app/src/react-app/domains/cloud/`,
  and `apps/desktop/`.
- Den side: `ee/apps/den-api/src/routes/`.
- Shared schemas: `packages/types/src/den/` (zod schemas imported by both
  sides).

Severity is the gating contract. Use exactly this mapping:

- `high` — blocking; withholds Warden clearance until resolved.
- `medium` — advisory; posted as a comment but never blocks clearance.
- Never report `low` findings from this skill.

Report a HIGH (blocking) finding only in these two cases:

1. Breaking den change that can brick published desktop builds. The diff
   removes or renames a den-api route, removes or renames a response field,
   makes a previously optional request field required, removes an enum value,
   tightens validation, or changes auth/semantics on a surface the desktop
   client references. Grep the desktop/client surfaces for usage of the
   changed route or field before reporting. This blocks EVEN IF the same diff
   also updates or removes the desktop-side usage: published binaries still
   run the old client code. The fix is a phased rollout, in this order:
   first ship a desktop release that tolerates both old and new den behavior,
   wait for it to be published, and only then land the den-side removal or
   change.
2. Desktop-ahead dependency. The diff adds desktop/client code that calls a
   den route or reads a den response field that is introduced in this same
   diff or does not exist in `ee/apps/den-api/src/routes/` at all. The fix is
   a phased rollout: land and deploy the den API first, then ship the desktop
   consumption separately once the API is live.

Report a MEDIUM (advisory) finding only in this case:

3. Additive den-ahead drift. The diff adds a den-api feature that requires
   desktop-side handling to actually work for users (a new desktop-policy
   field the app must enforce or render, a new required field in a
   `packages/types/src/den/` schema the desktop consumes, a new enum/action
   value the desktop must handle), and the diff contains no corresponding
   desktop/client change. Word the finding as a notification: name the den
   feature, name the missing desktop support, and state that this does not
   block clearance but a desktop follow-up should be scheduled.

Do NOT report:

- Backward-compatible additive den changes nothing on desktop needs: new
  routes, new optional fields with defaults, new enum values the desktop can
  safely ignore.
- One-sided changes that are self-contained (den internals, desktop-only UI,
  refactors that keep the wire contract identical).
- Style, performance, correctness, or security issues (a separate skill owns
  security).
- Pre-existing drift in unchanged code.
- Tests, mocks, fixtures, seed data, or docs.

For each finding, report:

- The exact file and changed lines that introduce the drift.
- Which published-vs-deployed pair breaks: what the published desktop calls
  or expects, and what den now serves (or vice versa).
- Severity per the mapping above.
- The concrete rollout fix: what ships first, what waits, and what change in
  this diff should be split out.

If the diff introduces no desktop<->den drift, report nothing. Silence is the
correct output for a clean diff; do not manufacture findings.
