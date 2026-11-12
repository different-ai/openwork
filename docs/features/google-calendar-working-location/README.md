# Google Calendar working location

- Feature: `googleCalendarWorkingLocation`; cloud and self-hosted; default **off**
- Owner: `yomgui`

## What changes

Members with Calendar write permission can set an all-day working location on
an inclusive date range in their selected Google account's **primary** calendar.
This is a status event, not an ordinary meeting's `location` text. Existing
connector policy, account selection, OAuth scopes and audit conventions apply.
No new scope is required: `calendar.events` authorizes both the preflight list
and writes. Google limits working locations to eligible Workspace users and
primary calendars; an ineligible account can still be rejected by Google.

The agent capability is `setGoogleCalendarWorkingLocation`, backed by
POST `/v1/capabilities/google-workspace/calendar-working-location`:

```json
{
  "from": "2026-11-16",
  "to": "2026-11-20",
  "type": "custom",
  "customLabel": "San Francisco"
}
```

- `from` and `to` are YYYY-MM-DD, **both inclusive**, at most 31 days per call.
- `type`: `home`, `office`, or `custom`. `customLabel` is required for custom.
- Office accepts optional `officeLabel`, `buildingId`, `floorId`,
  `floorSectionId`, and `deskId`. Omitted office details clear old values when
  replacing a location. Home and custom reject office fields.
- One Google event per day: `eventType: "workingLocation"`, date-only start,
  next-day exclusive end, `visibility: "public"`, `transparency: "transparent"`.
  All-day working locations cannot span multiple days. Public visibility is
  required by Google; labels should not contain private information.
- No attendees, Meet links, recurrence rules, calendar overrides or notification
  options are accepted. Every mutation uses `sendUpdates=none`.
- Returns `{ ok, calendarId: "primary", events }` with Google-confirmed IDs,
  dates, event types and properties. Never automatically retry an uncertain write.

List and individual get now expose `eventType` and
`workingLocationProperties` using Google's names: `homeOffice`,
`officeLocation` (label and building/floor/section/desk IDs), or `customLocation`
(label). List returns null properties on other event types. These additive reads
remain available with the write feature disabled. The desktop calendar contract
preserves the new metadata and accepts older servers that omit it.

## Replace just one recurring day

The operation preflights **all pages** of working-location events with
`singleEvents=true`. It patches an existing day's **instance ID**, never the
`recurringEventId` or master. A one-day request creates a recurring exception;
other occurrences and the series rule remain unchanged. It does not create a
second event over an existing location. Old nested location variants are cleared
when switching type. An available ETag is sent as `If-Match`.

Preflight rejects duplicate, multi-day, timed or otherwise ambiguous working
locations before any write; it never guesses which to overwrite or deletes a
location. To avoid guessing the calendar time zone, the list window covers all
UTC offsets (+14 through -12); a timed location in that slightly wider window
also blocks the request conservatively. At most 20 pages are read.

Google provides no atomic range transaction or conditional insert-if-date-empty.
Concurrent changes by another client can race preflight; an ETag protects updates
where supplied, not creation. Multi-day writes are sequential and **may partially
complete** if a later write fails. Inspect the range before retrying, including
when Google returns a malformed/mismatched receipt after storing the event.
No compensation, blind retry, series edit or delete is attempted.

## Try, roll out, and turn off

1. Enable `googleCalendarWorkingLocation` for an isolated test organization/member.
2. Connect an eligible Calendar-write test account. Set a home range, then replace
   one recurring Home instance with a one-day custom location. Check the instance,
   sibling days and master; read/list the returned metadata.
3. Try office details, invalid types/dates/ranges and overlapping locations.
4. Disable the feature: writes fail before provider access. Reads and existing
   locations survive; in-flight work that passed the gate may finish. The
   `googleCalendarRecurrence` switch is independent: creating a recurring series
   is not needed to replace a day of an already-existing series.

Watch Google 400/403/502 errors, unconfirmed receipts and feature usage in `/admin`.
The API suite uses a loopback OAuth/Calendar mock and throwaway MySQL databases;
no real Google account is called. It covers range creation, all types, pagination,
instance-only replacement, validation, permissions, feature-off behavior and
unconfirmed writes. The existing recurrence API suite is the regression check.

## Google API references

- [Status events](https://developers.google.com/workspace/calendar/api/guides/calendar-status):
  required working-location fields, primary-calendar restriction, single-day
  all-day events and overlapping-location behavior.
- [Recurring event instances](https://developers.google.com/workspace/calendar/api/guides/recurringevents#modify_or_delete_instances):
  updating an instance ID creates an exception, not a series edit.
- [Events.patch](https://developers.google.com/workspace/calendar/api/v3/reference/events/patch):
  patch semantics, supported existing scopes and notification policy.
- [Events.list](https://developers.google.com/workspace/calendar/api/v3/reference/events/list):
  expansion, event-type filtering and pagination (including empty pages).
