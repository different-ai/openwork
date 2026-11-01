# Google Calendar recurring meetings

- Feature: `googleCalendarRecurrence`
- Deployments: cloud and self-hosted; default **off**
- Owner: `benjaminshafii`

## What changes

Members with Google Calendar write permission can create a finite recurring
meeting series, or replace/clear its recurrence through the native Calendar
capabilities. Existing account selection, authorization, scope and notification
confirmation rules still apply. No additional OAuth scopes are needed.

POST `/v1/capabilities/google-workspace/calendar-events` accepts either:

```json
{
  "summary": "Weekly review",
  "start": "2026-11-02T09:00:00-05:00",
  "end": "2026-11-02T09:30:00-05:00",
  "timeZone": "America/New_York",
  "recurrence": { "frequency": "weekly", "byWeekday": ["MO", "WE"], "count": 10 }
}
```

- `frequency`: daily, weekly, monthly, yearly.
- Optional `interval`: integer 1–99, defaults to 1.
- Optional `byWeekday`: MO through SU, 1–7 entries (duplicates deduplicated).
- Exactly one of `count` (1–730, includes the first occurrence) or `until`
  (RFC3339 date-time with offset, or YYYY-MM-DD) is required. A date means
  through 23:59:59 **UTC**, not local midnight. Date-times normalize to UTC.
- Advanced `rrule: string[]` is mutually exclusive with `recurrence`.
  It accepts up to 32 lines of up to 2048 characters each: `RRULE:`, `EXDATE:`,
  or `RDATE:` only. No newlines, control characters or property parameters.
  At most one RRULE, with finite COUNT (1–730) or UTC UNTIL. Supported parts:
  FREQ (DAILY/WEEKLY/MONTHLY/YEARLY), INTERVAL (1–99), BYDAY, BYMONTH,
  BYMONTHDAY, BYSETPOS, WKST. EXDATE/RDATE and RRULE UNTIL use basic UTC
  date-times (`YYYYMMDDTHHmmssZ`); date-only exceptions are rejected because
  these writes create timed events. RDATE-only sets are finite and allowed.
  Invalid BY-part combinations are rejected locally; Google validates the
  remaining provider-specific constraints. UNTIL must not precede start.

Unbounded series are deliberately unsupported: ask for an end date or count
rather than guessing. An IANA `timeZone` is mandatory for recurrence and is
sent on **both** start and end so Google handles daylight saving transitions.
The create receipt includes Google's `recurrence` array (or null); a missing or
mismatched series confirmation fails without retrying the write. Rule-part and
weekday ordering differences are accepted. `eventId`
is the series master ID. Lists expand occurrences and now expose their
`recurringEventId`; null means a one-time event or master. Read/list recurrence
metadata is additive and remains available when the feature is off, so existing
series can still be understood and managed.

## Edit and cancel

PATCH `/v1/capabilities/google-workspace/calendar-events/:eventId` accepts
structured recurrence or `rrule` to replace the rule on a **master**.
Supply both `start` and `end` as `{ "dateTime": "…", "timeZone": "…" }`,
with matching IANA time zones. This intentionally avoids guessing or silently
reusing an unknown zone. `recurrence: null` clears the series recurrence;
no start/end is required to clear. An extra read rejects recurrence edits on
an occurrence before any mutation. Other PATCH fields on an occurrence still
edit just that meeting. Guest notifications retain explicit approval controls.

Use the master ID to edit/cancel the whole series, an instance ID to edit/cancel
one occurrence. DELETE already has these semantics and explicit cancellation
confirmation; it is unchanged. Google may reject incompatible recurrence rules.
Never blindly retry an uncertain write.

## Try, roll out, and turn off

1. Enable `googleCalendarRecurrence` for a test organization/member in `/admin`
   (or self-hosted operator configuration), then connect a Calendar-write account.
2. POST the example; check the receipt contains the master ID and
   `RRULE:FREQ=WEEKLY;BYDAY=MO,WE;COUNT=10`. List its date range, observe
   occurrence IDs with that `recurringEventId`, and read the master.
3. PATCH the master to replace its recurrence, then clear with `recurrence:null`.
   Check an occurrence recurrence edit and a missing-zone create both fail.
4. Disable the feature: create/patch requests **containing** recurrence/rrule
   fail with 400 before provider access, not silently becoming one-time events.
   One-time creates and ordinary edits/deletes remain usable. Existing series
   are never deleted or rewritten by the kill switch; in-flight writes that
   already passed the gate may complete.

Watch Calendar 400 validation errors, Google 502 responses and feature usage
in `/admin`. Unit tests cover conversion/bounds/injection/time zones and payloads;
API tests exercise the real routes with a fake OAuth/Calendar provider, including
flag-off rejection, provider payloads, receipts and master/instance boundaries.
Microsoft 365 recurrence parity is a separate follow-up (Graph uses a different
structured recurrence contract).
