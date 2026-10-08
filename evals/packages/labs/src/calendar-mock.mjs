#!/usr/bin/env node
// Calendar mock for OpenWork's native calendar contracts: the Acme Robotics team's week, as Google Calendar
// and Outlook return it, at three layers so each can be swapped for the real thing without code changes:
//
//   1. Provider upstreams (what Den calls; point Den at them with DEN_GOOGLE_API_BASE_URL=<mock> and
//      DEN_MICROSOFT_GRAPH_BASE_URL=<mock>/v1.0):
//        GET /calendar/v3/calendars/primary/events   Google Calendar API v3 events.list
//        GET /v1.0/me/calendarView                    Microsoft Graph calendarView
//   2. Den's capability routes (what OpenWork clients call; point the desktop at the mock with
//      VITE_OPENWORK_CALENDAR_MOCK_URL or localStorage "openwork.calendar.mockUrl"):
//        GET /v1/capabilities/google-workspace/calendar-events?timeMin&timeMax&maxResults
//        GET /v1/capabilities/microsoft-365/calendar-events?timeMin&timeMax&maxResults
//      Same validation, defaults (25, max 100, no page token), field extraction and error envelopes as den-api
//      (ee/apps/den-api/src/routes/org/{google-workspace,microsoft-365}.ts and capability-sources/). The
//      contract test (calendar-mock.test.ts) runs den-api's real extractors on layer 1 and compares.
//   3. MCP (Streamable HTTP, JSON responses) at /mcp: google_workspace_calendar_events and
//      microsoft_365_calendar_events, whose structuredContent is exactly the layer-2 body.
//
// Control: GET /health, GET /state, POST /reset, POST /scenario {"google":"throttled","microsoft":"ok"}.
// Scenarios per provider: ok | connection_missing | scope_missing | expired_token | throttled | policy_blocked.
//
// Self-contained (no imports outside Node) so worlds can upload it verbatim into a sandbox.
//
//   HOST=127.0.0.1 PORT=3991 CALENDAR_MOCK_TIME_ZONE=America/Los_Angeles node calendar-mock.mjs
//   CALENDAR_MOCK_GOOGLE=expired_token CALENDAR_MOCK_LOAD=150 node calendar-mock.mjs
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

export const SCENARIOS = ["ok", "connection_missing", "scope_missing", "expired_token", "throttled", "policy_blocked"];
const PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
const DAY_MS = 24 * 60 * 60 * 1000;

// ── Time ─────────────────────────────────────────────────────────────────────────────────────────────────

const formatters = new Map();
function parts(instant, timeZone) {
  let format = formatters.get(timeZone);
  if (!format) {
    format = new Intl.DateTimeFormat("en-US-u-ca-gregory", { timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });
    formatters.set(timeZone, format);
  }
  const map = Object.fromEntries(format.formatToParts(new Date(instant)).map((part) => [part.type, part.value]));
  return { year: Number(map.year), month: Number(map.month), day: Number(map.day), hour: Number(map.hour), minute: Number(map.minute), second: Number(map.second) };
}
function offsetMs(instant, timeZone) {
  const second = Math.floor(instant / 1000) * 1000;
  const p = parts(second, timeZone);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - second;
}
/** Instant of a wall time in a zone (first instant when repeated, shifted forward when skipped). */
export function wallToInstant(date, hour, minute, timeZone) {
  const nominal = Date.UTC(date.year, date.month - 1, date.day, hour, minute);
  const offsets = [...new Set([offsetMs(nominal - 14 * 3600e3, timeZone), offsetMs(nominal, timeZone), offsetMs(nominal + 14 * 3600e3, timeZone)])];
  const exact = offsets.map((offset) => nominal - offset).filter((candidate) => nominal - offsetMs(candidate, timeZone) === candidate).sort((a, b) => a - b);
  return exact[0] ?? nominal - Math.min(...offsets);
}
const pad = (value, size = 2) => String(value).padStart(size, "0");
function addDays(date, days) {
  const next = new Date(Date.UTC(date.year, date.month - 1, date.day + days));
  return { year: next.getUTCFullYear(), month: next.getUTCMonth() + 1, day: next.getUTCDate() };
}
const dateKey = (date) => `${date.year}-${pad(date.month)}-${pad(date.day)}`;
/** RFC 3339 with the zone's offset, as Google returns dateTime values. */
function rfc3339(instant, timeZone) {
  const p = parts(instant, timeZone);
  const offset = Math.round(offsetMs(instant, timeZone) / 60000);
  const sign = offset >= 0 ? "+" : "-";
  const abs = Math.abs(offset);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}T${pad(p.hour)}:${pad(p.minute)}:${pad(p.second)}${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}
/** Graph wall time without offset and with seven fractional digits, e.g. 2026-10-05T16:00:00.0000000. */
function graphDateTime(instant, timeZone) {
  const p = parts(instant, timeZone);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}T${pad(p.hour)}:${pad(p.minute)}:${pad(p.second)}.0000000`;
}
const compactUtc = (instant) => new Date(instant).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");

// ── Seed: the week of `now` (Monday first) in the demo time zone ────────────────────────────────────────

const ME = { name: "Alex Chen", email: "alex@acme.test" };
const PEOPLE = {
  priya: { name: "Priya Shah", email: "priya@acme.test" }, mateo: { name: "Mateo Rivera", email: "mateo@acme.test" },
  olivia: { name: "Olivia Martin", email: "olivia@acme.test" }, nora: { name: "Nora Patel", email: "nora@acme.test" },
  ivy: { name: "Ivy Nguyen", email: "ivy@acme.test" }, morgan: { name: "Morgan Lee", email: "morgan@acme.test" },
  harper: { name: "Harper Wilson", email: "harper@acme.test" }, kenji: { name: "Kenji Tanaka", email: "kenji@acme.test" },
  camila: { name: "Camila Torres", email: "camila@acme.test" }, lena: { name: "Lena Vogel", email: "lena@partner.test" },
  sam: { name: "Sam Okafor", email: "sam@acme.test" },
};

export function seedCalendars({ now = Date.now(), timeZone = "America/Los_Angeles", load = 0 } = {}) {
  const today = parts(now, timeZone);
  const todayDate = { year: today.year, month: today.month, day: today.day };
  const weekday = new Date(Date.UTC(todayDate.year, todayDate.month - 1, todayDate.day)).getUTCDay();
  const monday = addDays(todayDate, -((weekday + 6) % 7));
  const day = (offset) => addDays(monday, offset);
  const at = (offset, hour, minute = 0, zone = timeZone) => wallToInstant(day(offset), hour, minute, zone);
  const google = [];
  const outlook = [];
  const created = new Date(now - 14 * DAY_MS).toISOString();
  const updated = new Date(now - DAY_MS).toISOString();

  const gEvent = (input) => {
    const id = input.id ?? `${randomUUID().replace(/-/g, "").slice(0, 26)}`;
    const zone = input.timeZone ?? timeZone;
    const event = {
      kind: "calendar#event", etag: `"${Math.floor(now / 1000)}"`, id, status: input.status ?? "confirmed",
      htmlLink: `https://www.google.com/calendar/event?eid=${Buffer.from(`${id} ${ME.email}`).toString("base64url")}`,
      created, updated, ...(input.summary === undefined ? {} : { summary: input.summary }),
      ...(input.description ? { description: input.description } : {}), ...(input.location ? { location: input.location } : {}),
      creator: { email: (input.organizer ?? ME).email }, organizer: { email: (input.organizer ?? ME).email, ...(input.organizer ? {} : { self: true }) },
      start: input.allDay ? { date: dateKey(input.allDay.start) } : { dateTime: rfc3339(input.start, zone), timeZone: zone },
      end: input.allDay ? { date: dateKey(input.allDay.end) } : { dateTime: rfc3339(input.end, zone), timeZone: zone },
      ...(input.recurringEventId ? { recurringEventId: input.recurringEventId, originalStartTime: { dateTime: rfc3339(input.start, zone), timeZone: zone } } : {}),
      ...(input.recurrence ? { recurrence: input.recurrence } : {}),
      ...(input.visibility ? { visibility: input.visibility } : {}),
      iCalUID: `${id}@google.com`, sequence: 0, eventType: "default",
      ...(input.attendees ? { attendees: [{ email: ME.email, self: true, responseStatus: "accepted" }, ...input.attendees.map((person) => ({ email: person.email, displayName: person.name, responseStatus: "accepted" }))] } : {}),
      ...(input.hangoutLink ? { hangoutLink: input.hangoutLink } : {}),
      ...(input.conference ? { conferenceData: { entryPoints: [{ entryPointType: "video", uri: input.conference, label: input.conference.replace(/^https:\/\//, "") }], conferenceSolution: { name: "Zoom Meeting" } } } : {}),
      reminders: { useDefault: true },
    };
    google.push(event);
    return event;
  };

  // Recurring series: weekday launch standup, expanded into instances (singleEvents=true) plus its master.
  const standupId = "launchstandup2026acme";
  gEvent({ id: standupId, summary: "Launch standup", start: at(-21, 9, 30), end: at(-21, 9, 45), recurrence: ["RRULE:FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR"], attendees: [PEOPLE.nora, PEOPLE.olivia, PEOPLE.priya], hangoutLink: "https://meet.google.com/lau-nchs-tnd", master: true });
  for (let offset = -14; offset <= 18; offset += 1) {
    const dow = (offset % 7 + 7) % 7;
    if (dow > 4) continue;
    const start = at(offset, 9, 30);
    gEvent({
      id: `${standupId}_${compactUtc(start)}`, recurringEventId: standupId, summary: "Launch standup", start, end: at(offset, 9, 45),
      attendees: [PEOPLE.nora, PEOPLE.olivia, PEOPLE.priya], hangoutLink: "https://meet.google.com/lau-nchs-tnd",
      // Wednesday's instance this week was cancelled; Google omits it unless showDeleted=true.
      ...(offset === 2 ? { status: "cancelled" } : {}),
    });
  }
  gEvent({ summary: "Press briefing", start: at(1, 11), end: at(1, 12), location: "HQ – Studio B", description: "Fleet 2.0 embargo walkthrough with the press team.", attendees: [PEOPLE.olivia, PEOPLE.mateo], hangoutLink: "https://meet.google.com/prs-brfg-001" });
  gEvent({ summary: "Design review", start: at(2, 14), end: at(2, 15), organizer: PEOPLE.ivy, attendees: [PEOPLE.ivy, PEOPLE.morgan, PEOPLE.nora], conference: "https://acme.zoom.test/j/88812345" });
  // Overlapping meetings on Thursday afternoon.
  gEvent({ summary: "Customer call: Blue Harbor Foods", start: at(3, 15), end: at(3, 15, 30), attendees: [PEOPLE.harper, PEOPLE.kenji], description: "Follow up on the charging escalation." });
  gEvent({ summary: "Hiring sync", start: at(3, 15, 15), end: at(3, 16), attendees: [PEOPLE.camila] });
  // A private event the member sees only as busy: Google omits the summary.
  gEvent({ start: at(0, 12), end: at(0, 13), visibility: "private" });
  // All-day: a one-day launch day and a two-day offsite next week (end dates are exclusive).
  gEvent({ summary: "Fleet 2.0 launch day", allDay: { start: day(4), end: day(5) } });
  gEvent({ summary: "Sales kickoff (offsite)", allDay: { start: day(7), end: day(9) }, location: "Half Moon Bay" });
  // DST-sensitive: a weekly sync fixed at 17:00 Berlin time. Europe and the US change clocks on different
  // weekends, so in Los Angeles it moves between 8 and 9 AM around late October / early November.
  const berlinId = "eupartnersyncberlin";
  for (let week = -3; week <= 5; week += 1) {
    const start = at(week * 7, 17, 0, "Europe/Berlin");
    gEvent({ id: `${berlinId}_${compactUtc(start)}`, recurringEventId: berlinId, summary: "EU partner sync (Berlin)", start, end: start + 30 * 60000, timeZone: "Europe/Berlin", organizer: PEOPLE.lena, attendees: [PEOPLE.lena, PEOPLE.mateo] });
  }

  const oEvent = (input) => {
    const id = `AAMkAG${Buffer.from(input.key).toString("base64url")}${"A".repeat(8)}=`;
    const event = {
      "@odata.etag": `W/"${Buffer.from(input.key).toString("base64url").slice(0, 12)}"`,
      id, createdDateTime: created, lastModifiedDateTime: updated, iCalUId: `0400000082${Buffer.from(input.key).toString("hex").slice(0, 24)}`,
      subject: input.subject ?? "", bodyPreview: input.preview ?? "", importance: "normal", sensitivity: "normal",
      isAllDay: Boolean(input.allDay), isCancelled: false, isOrganizer: !input.organizer, showAs: "busy",
      type: input.seriesMasterId ? "occurrence" : "singleInstance", ...(input.seriesMasterId ? { seriesMasterId: input.seriesMasterId } : {}),
      webLink: `https://outlook.office365.com/owa/?itemid=${encodeURIComponent(id)}&exvsurl=1&path=/calendar/item`,
      onlineMeetingUrl: null,
      // Stored in the organizer's zone; calendarView converts to UTC unless a Prefer: outlook.timezone header asks otherwise.
      originalStartTimeZone: input.allDay ? "UTC" : "Pacific Standard Time", originalEndTimeZone: input.allDay ? "UTC" : "Pacific Standard Time",
      startInstant: input.allDay ? null : input.start, endInstant: input.allDay ? null : input.end,
      allDayDates: input.allDay ? { start: dateKey(input.allDay.start), end: dateKey(input.allDay.end) } : null,
      location: { displayName: input.location ?? "", locationType: "default" },
      organizer: { emailAddress: { name: (input.organizer ?? ME).name, address: (input.organizer ?? ME).email } },
      attendees: (input.attendees ?? []).map((person) => ({ type: "required", status: { response: "accepted", time: created }, emailAddress: { name: person.name, address: person.email } })),
      onlineMeeting: input.joinUrl ? { joinUrl: input.joinUrl } : null,
      isOnlineMeeting: Boolean(input.joinUrl), onlineMeetingProvider: input.joinUrl ? "teamsForBusiness" : "unknown",
    };
    outlook.push(event);
    return event;
  };
  oEvent({ key: "partner-pipeline", subject: "Partner pipeline review", start: at(1, 13), end: at(1, 13, 45), attendees: [PEOPLE.mateo, PEOPLE.sam], preview: "Q4 partner deals and blockers." });
  oEvent({ key: "qbr", subject: "Quarterly business review", start: at(3, 10), end: at(3, 11, 30), attendees: [PEOPLE.priya, PEOPLE.mateo, PEOPLE.sam], joinUrl: "https://teams.microsoft.test/l/meetup-join/19%3aqbr" });
  for (let week = -2; week <= 3; week += 1) {
    oEvent({ key: `one-on-one-${week}`, subject: "1:1 Alex / Priya", start: at(week * 7 + 2, 16), end: at(week * 7 + 2, 16, 30), attendees: [PEOPLE.priya], seriesMasterId: "AAMkAGoneonone=", organizer: PEOPLE.priya });
  }
  oEvent({ key: "company-holiday", subject: "Company holiday", allDay: { start: day(11), end: day(12) } });

  // Load: many short events on Tuesday, to exercise page limits and window splitting.
  for (let index = 0; index < load; index += 1) {
    const start = at(1, 6) + index * 5 * 60000;
    gEvent({ id: `loadtest${pad(index, 4)}`, summary: `Focus block ${index + 1}`, start, end: start + 5 * 60000 });
    oEvent({ key: `load-${index}`, subject: `Focus block ${index + 1}`, start, end: start + 5 * 60000 });
  }

  const sortKey = (event) => event.start.dateTime ? Date.parse(event.start.dateTime) : wallToInstant(parseDate(event.start.date), 0, 0, timeZone);
  google.sort((left, right) => sortKey(left) - sortKey(right) || left.id.localeCompare(right.id));
  return { timeZone, google, outlook };
}

function parseDate(value) {
  const [year, month, day] = value.split("-").map(Number);
  return { year, month, day };
}

// ── Layer 1: provider upstreams ─────────────────────────────────────────────────────────────────────────

function googleEventRange(event, timeZone) {
  if (event.start.date) return { start: wallToInstant(parseDate(event.start.date), 0, 0, timeZone), end: wallToInstant(parseDate(event.end.date), 0, 0, timeZone) };
  return { start: Date.parse(event.start.dateTime), end: Date.parse(event.end.dateTime) };
}

/** Google Calendar API v3 events.list for the primary calendar. */
export function googleEventsList(state, query) {
  const timeMin = query.get("timeMin");
  const timeMax = query.get("timeMax");
  const singleEvents = query.get("singleEvents") === "true";
  const showDeleted = query.get("showDeleted") === "true";
  if (query.get("orderBy") === "startTime" && !singleEvents) {
    return { status: 400, body: googleError(400, "The requested ordering is not available for the particular query.", "badRequest") };
  }
  for (const [name, value] of [["timeMin", timeMin], ["timeMax", timeMax]]) {
    if (value !== null && !Number.isFinite(Date.parse(value))) return { status: 400, body: googleError(400, `Invalid value for: ${name}`, "invalid") };
  }
  const maxResults = Math.min(Number(query.get("maxResults") ?? 250) || 250, 2500);
  const min = timeMin === null ? Number.NEGATIVE_INFINITY : Date.parse(timeMin);
  const max = timeMax === null ? Number.POSITIVE_INFINITY : Date.parse(timeMax);
  const items = state.google.filter((event) => {
    if (singleEvents ? Boolean(event.recurrence) : Boolean(event.recurringEventId)) return false;
    if (event.status === "cancelled" && !showDeleted) return false;
    const range = googleEventRange(event, state.timeZone);
    // timeMin bounds the event end, timeMax the event start; both exclusive.
    return range.end > min && range.start < max;
  });
  const offset = Number(query.get("pageToken")?.replace(/^p/, "") ?? 0) || 0;
  const page = items.slice(offset, offset + maxResults);
  const next = offset + maxResults < items.length ? `p${offset + maxResults}` : undefined;
  return {
    status: 200,
    body: {
      kind: "calendar#events", etag: `"p${state.version}"`, summary: ME.email, description: "", updated: new Date().toISOString(),
      timeZone: state.timeZone, accessRole: "owner", defaultReminders: [{ method: "popup", minutes: 10 }],
      ...(next ? { nextPageToken: next } : { nextSyncToken: `sync${state.version}` }), items: page,
    },
  };
}

function graphEventView(event, zone) {
  const { startInstant, endInstant, allDayDates, originalStartTimeZone, originalEndTimeZone, ...rest } = event;
  const start = allDayDates ? { dateTime: `${allDayDates.start}T00:00:00.0000000`, timeZone: zone } : { dateTime: graphDateTime(startInstant, zone === "UTC" ? "UTC" : zone), timeZone: zone };
  const end = allDayDates ? { dateTime: `${allDayDates.end}T00:00:00.0000000`, timeZone: zone } : { dateTime: graphDateTime(endInstant, zone === "UTC" ? "UTC" : zone), timeZone: zone };
  return { ...rest, originalStartTimeZone, originalEndTimeZone, start, end };
}

function graphRange(event, timeZone) {
  if (event.allDayDates) return { start: wallToInstant(parseDate(event.allDayDates.start), 0, 0, timeZone), end: wallToInstant(parseDate(event.allDayDates.end), 0, 0, timeZone) };
  return { start: event.startInstant, end: event.endInstant };
}

/** Microsoft Graph /me/calendarView. Without `Prefer: outlook.timezone`, times come back in UTC. */
export function graphCalendarView(state, query, preferHeader = "", selfUrl = "") {
  const startDateTime = query.get("startDateTime");
  const endDateTime = query.get("endDateTime");
  if (!startDateTime || !endDateTime) {
    return { status: 400, body: graphError("ErrorInvalidParameter", "This request requires a time window specified by the query string parameters StartDateTime and EndDateTime.") };
  }
  const start = Date.parse(startDateTime);
  const end = Date.parse(endDateTime);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return { status: 400, body: graphError("ErrorInvalidParameter", "The value of the parameter 'StartDateTime' is invalid.") };
  const preferred = /outlook\.timezone="([^"]+)"/.exec(preferHeader)?.[1];
  const zone = preferred && isIanaZone(preferred) ? preferred : "UTC";
  const top = Math.min(Number(query.get("$top") ?? 10) || 10, 1000);
  const skip = Number(query.get("$skip") ?? 0) || 0;
  const matching = state.outlook
    .filter((event) => {
      const range = graphRange(event, state.timeZone);
      return range.end > start && range.start < end;
    })
    .sort((left, right) => graphRange(left, state.timeZone).start - graphRange(right, state.timeZone).start || left.id.localeCompare(right.id));
  const page = matching.slice(skip, skip + top).map((event) => graphEventView(event, zone));
  const next = skip + top < matching.length ? new URL(selfUrl || "http://localhost/v1.0/me/calendarView") : null;
  if (next) {
    for (const [key, value] of query) next.searchParams.set(key, value);
    next.searchParams.set("$skip", String(skip + top));
  }
  return {
    status: 200,
    body: { "@odata.context": "https://graph.microsoft.com/v1.0/$metadata#users('alex%40acme.test')/calendarView", value: page, ...(next ? { "@odata.nextLink": next.toString() } : {}) },
    headers: preferred && zone !== "UTC" ? { "preference-applied": `outlook.timezone="${zone}"` } : {},
  };
}

function isIanaZone(value) {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

function googleError(code, message, reason, extra = {}) {
  return { error: { code, message, errors: [{ message, domain: extra.domain ?? "global", reason }], status: extra.status ?? (code === 401 ? "UNAUTHENTICATED" : code === 403 ? "PERMISSION_DENIED" : code === 429 ? "RESOURCE_EXHAUSTED" : "INVALID_ARGUMENT") } };
}
function graphError(code, message) {
  return { error: { code, message, innerError: { date: new Date().toISOString(), "request-id": randomUUID(), "client-request-id": randomUUID() } } };
}

/** Upstream failure a provider scenario produces, as the provider sends it. Null means serve normally. */
function upstreamFailure(provider, scenario) {
  if (scenario === "expired_token") {
    return provider === "google"
      ? { status: 401, body: googleError(401, "Request had invalid authentication credentials. Expected OAuth 2 access token, login cookie or other valid authentication credential.", "authError", { domain: "global" }) }
      : { status: 401, body: graphError("InvalidAuthenticationToken", "Lifetime validation failed, the token is expired.") };
  }
  if (scenario === "throttled") {
    return provider === "google"
      ? { status: 403, body: googleError(403, "Rate Limit Exceeded", "rateLimitExceeded", { domain: "usageLimits" }) }
      : { status: 429, body: graphError("ApplicationThrottled", "Application is over its MailboxConcurrency limit."), headers: { "retry-after": "5" } };
  }
  if (scenario === "scope_missing") {
    return provider === "google"
      ? { status: 403, body: googleError(403, "Request had insufficient authentication scopes.", "insufficientPermissions") }
      : { status: 403, body: graphError("ErrorAccessDenied", "Access is denied. Check credentials and try again.") };
  }
  return null;
}

// ── Layer 2: Den capability routes (ports of den-api's extractors and route checks) ─────────────────────

const str = (record, key) => (record && typeof record[key] === "string" ? record[key] : "");
const rec = (record, key) => (record && typeof record[key] === "object" && record[key] !== null && !Array.isArray(record[key]) ? record[key] : null);
const arr = (record, key) => (record && Array.isArray(record[key]) ? record[key] : []);

/** Port of extractCalendarEvents (ee/apps/den-api/src/capability-sources/google-workspace-api.ts). */
export function denExtractGoogleEvents(json) {
  return arr(json, "items").filter((item) => typeof item === "object" && item !== null).map((item) => {
    const time = (key) => { const value = rec(item, key); return value ? str(value, "dateTime") || str(value, "date") : ""; };
    const conference = rec(item, "conferenceData");
    const video = conference ? arr(conference, "entryPoints").find((entry) => entry && str(entry, "entryPointType") === "video" && str(entry, "uri")) : null;
    return {
      id: str(item, "id"), summary: str(item, "summary"), description: str(item, "description"), location: str(item, "location"),
      start: time("start"), end: time("end"), status: str(item, "status"), htmlLink: str(item, "htmlLink"),
      attendees: arr(item, "attendees").flatMap((attendee) => (attendee && str(attendee, "email") ? [str(attendee, "email")] : [])),
      meetLink: str(item, "hangoutLink") || (video ? str(video, "uri") : null) || null,
    };
  });
}

/** Port of extractMicrosoftCalendarEvents (ee/apps/den-api/src/capability-sources/microsoft-graph.ts). */
export function denExtractMicrosoftEvents(json) {
  const email = (value) => {
    const address = rec(value, "emailAddress");
    return address && str(address, "address") ? { name: str(address, "name"), address: str(address, "address") } : null;
  };
  return arr(json, "value").map((event) => {
    const start = rec(event, "start") ?? {};
    const end = rec(event, "end") ?? {};
    const location = rec(event, "location");
    const meeting = rec(event, "onlineMeeting");
    return {
      id: str(event, "id"), subject: str(event, "subject"), preview: str(event, "bodyPreview"),
      start: str(start, "dateTime"), startTimeZone: str(start, "timeZone"), end: str(end, "dateTime"), endTimeZone: str(end, "timeZone"),
      isAllDay: event?.isAllDay === true, location: location ? str(location, "displayName") : "",
      organizer: email(event?.organizer), attendees: arr(event, "attendees").map(email).filter(Boolean),
      webLink: str(event, "webLink"), onlineMeetingUrl: (meeting ? str(meeting, "joinUrl") : "") || str(event, "onlineMeetingUrl") || null,
    };
  }).filter((event) => Boolean(event.id));
}

const CONNECT_GOOGLE = "Connect your Google account first: open Settings > Library > Connections and connect the Google Workspace connection, or use OpenWork Cloud > Your Connections.";
const CONNECT_MICROSOFT = "Connect your Microsoft account first: open Settings > Library > Connections and connect the Microsoft 365 connection, or use OpenWork Cloud > Your Connections.";
const MISSING_GOOGLE = "Your connected Google account is missing the Google Calendar read permission. An admin can enable it on the Google Workspace connector in OpenWork Cloud -> Connectors; then reconnect that Google Workspace connection in OpenWork Cloud -> Your Connections.";
const MISSING_MICROSOFT = "Your connected Microsoft account is missing the Outlook calendar read permission. An admin can enable it on the Microsoft 365 connector in OpenWork Cloud -> Connectors; then reconnect your account.";
const POLICY = "Your organization has blocked this connection.";

/** RFC 3339 check matching zod's datetime({ offset }) closely enough for the mock. */
function isoDateTime(value, allowOffset) {
  if (typeof value !== "string") return false;
  const pattern = allowOffset
    ? /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/
    : /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?Z$/;
  return pattern.test(value) && Number.isFinite(Date.parse(value));
}

function invalid(path, message) {
  return { status: 400, body: { error: "invalid_request", message: `${path}: ${message}`, details: [{ path: [path], message }] } };
}

/** GET /v1/capabilities/{google-workspace|microsoft-365}/calendar-events, exactly as den-api answers. */
export function denCalendarEvents(state, provider, query) {
  const google = provider === "google";
  const timeMin = query.get("timeMin");
  const timeMax = query.get("timeMax");
  if (!isoDateTime(timeMin, google)) return invalid("timeMin", "Invalid ISO datetime");
  if (!isoDateTime(timeMax, google)) return invalid("timeMax", "Invalid ISO datetime");
  const rawMax = query.get("maxResults");
  const maxResults = rawMax === null || rawMax === "" ? 25 : Number(rawMax);
  if (!Number.isInteger(maxResults) || maxResults < 1) return invalid("maxResults", "Too small: expected number to be >=1");
  if (maxResults > 100) return invalid("maxResults", "Too big: expected number to be <=100");

  const scenario = state.scenarios[provider];
  if (scenario === "connection_missing") return { status: 409, body: { error: "needs_connection", message: google ? CONNECT_GOOGLE : CONNECT_MICROSOFT } };
  if (scenario === "policy_blocked") return { status: 403, body: { error: "policy_blocked", message: POLICY } };
  // Den checks granted scopes before calling the provider.
  if (scenario === "scope_missing") return { status: 409, body: { error: "needs_connection", message: google ? MISSING_GOOGLE : MISSING_MICROSOFT } };

  const failure = upstreamFailure(provider, scenario);
  if (failure) {
    const errorCode = google ? "google_api_error" : "microsoft_graph_error";
    const operation = google ? "Google Calendar events list" : "Microsoft 365 calendar list";
    return { status: 502, body: { error: errorCode, message: `${operation} failed: ${failure.status} ${JSON.stringify(failure.body).slice(0, 300)}` } };
  }
  if (google) {
    const upstream = googleEventsList(state, new URLSearchParams({ timeMin, timeMax, singleEvents: "true", orderBy: "startTime", maxResults: String(maxResults) }));
    return { status: 200, body: { ok: true, events: denExtractGoogleEvents(upstream.body) } };
  }
  const upstream = graphCalendarView(state, new URLSearchParams({ startDateTime: timeMin, endDateTime: timeMax, $top: String(maxResults), $orderby: "start/dateTime" }));
  return { status: 200, body: { ok: true, events: denExtractMicrosoftEvents(upstream.body) } };
}

// ── State and server ────────────────────────────────────────────────────────────────────────────────────

function scenarioFrom(value) {
  return SCENARIOS.includes(value) ? value : "ok";
}

export function createCalendarMockState(options = {}) {
  const env = options.env ?? {};
  const seedOptions = {
    now: options.now ?? (env.CALENDAR_MOCK_NOW ? Date.parse(env.CALENDAR_MOCK_NOW) : Date.now()),
    timeZone: options.timeZone ?? env.CALENDAR_MOCK_TIME_ZONE ?? env.DEMO_TIME_ZONE ?? "America/Los_Angeles",
    load: options.load ?? Number(env.CALENDAR_MOCK_LOAD ?? 0),
  };
  const state = {
    ...seedCalendars(seedOptions), version: 1, seedOptions,
    scenarios: { google: scenarioFrom(options.google ?? env.CALENDAR_MOCK_GOOGLE), microsoft: scenarioFrom(options.microsoft ?? env.CALENDAR_MOCK_MICROSOFT) },
    requests: [],
  };
  return state;
}

function reset(state) {
  const scenarios = state.scenarios;
  Object.assign(state, seedCalendars({ ...state.seedOptions, now: Date.now() }), { version: state.version + 1, scenarios });
}

const MCP_TOOLS = [
  { name: "google_workspace_calendar_events", provider: "google", title: "List Google Calendar events", description: "List the calling member's primary Google Calendar events overlapping a time range (OpenWork's GET /v1/capabilities/google-workspace/calendar-events)." },
  { name: "microsoft_365_calendar_events", provider: "microsoft", title: "List Outlook calendar events", description: "List the calling member's Outlook calendar instances overlapping a time range (OpenWork's GET /v1/capabilities/microsoft-365/calendar-events)." },
].map((tool) => ({
  ...tool,
  annotations: { readOnlyHint: true, openWorldHint: false },
  inputSchema: {
    type: "object", required: ["timeMin", "timeMax"], additionalProperties: false,
    properties: {
      timeMin: { type: "string", format: "date-time", description: tool.provider === "google" ? "Inclusive lower bound for event start time. RFC 3339 date-time with a UTC offset or Z." : "Inclusive lower bound for event start time." },
      timeMax: { type: "string", format: "date-time", description: tool.provider === "google" ? "Exclusive upper bound for event start time. RFC 3339 date-time with a UTC offset or Z." : "Exclusive upper bound for event start time." },
      maxResults: { type: "integer", minimum: 1, maximum: 100, default: 25, description: "Maximum events to return, capped at 100." },
    },
  },
}));

function handleRpc(state, message) {
  if (!message || message.jsonrpc !== "2.0" || typeof message.method !== "string") return { jsonrpc: "2.0", id: message?.id ?? null, error: { code: -32600, message: "Invalid Request" } };
  if (message.id === undefined || message.id === null) return null;
  const result = (value) => ({ jsonrpc: "2.0", id: message.id, result: value });
  const params = message.params && typeof message.params === "object" ? message.params : {};
  switch (message.method) {
    case "initialize": {
      const requested = typeof params.protocolVersion === "string" ? params.protocolVersion : PROTOCOL_VERSIONS[0];
      return result({ protocolVersion: PROTOCOL_VERSIONS.includes(requested) ? requested : PROTOCOL_VERSIONS[0], capabilities: { tools: { listChanged: false } }, serverInfo: { name: "calendar-mock", title: "Calendar (mock)", version: "1.0.0" }, instructions: `Alex Chen's Google Calendar and Outlook calendar. Times are returned as each provider returns them; the demo week is in ${state.timeZone}.` });
    }
    case "ping": return result({});
    case "tools/list": return result({ tools: MCP_TOOLS.map(({ provider, ...tool }) => tool) });
    case "tools/call": {
      const tool = MCP_TOOLS.find((entry) => entry.name === params.name);
      if (!tool) return { jsonrpc: "2.0", id: message.id, error: { code: -32602, message: `Unknown tool: ${params.name}` } };
      const args = params.arguments && typeof params.arguments === "object" ? params.arguments : {};
      const query = new URLSearchParams();
      for (const key of ["timeMin", "timeMax", "maxResults"]) if (args[key] !== undefined) query.set(key, String(args[key]));
      const response = denCalendarEvents(state, tool.provider, query);
      return result({ content: [{ type: "text", text: JSON.stringify(response.body) }], structuredContent: response.body, isError: response.status !== 200 });
    }
    case "resources/list": return result({ resources: [] });
    case "prompts/list": return result({ prompts: [] });
    default: return { jsonrpc: "2.0", id: message.id, error: { code: -32601, message: `Method not found: ${message.method}` } };
  }
}

const CORS = { "access-control-allow-origin": "*", "access-control-allow-headers": "authorization, content-type, accept, x-openwork-org-id, mcp-session-id, mcp-protocol-version, prefer", "access-control-allow-methods": "GET, POST, DELETE, OPTIONS" };

function send(res, status, body, headers = {}) {
  const text = body === undefined ? "" : JSON.stringify(body);
  res.writeHead(status, { ...CORS, ...(body === undefined ? {} : { "content-type": "application/json; charset=utf-8" }), "cache-control": "no-store", ...headers });
  res.end(text);
}
async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) { size += chunk.length; if (size > 1024 * 1024) throw new Error("Body too large"); chunks.push(chunk); }
  return Buffer.concat(chunks).toString("utf8");
}
const bearer = (req) => /^Bearer\s+(\S+)/i.exec(String(req.headers.authorization ?? ""))?.[1] ?? null;

export function createCalendarMockHandler(state) {
  return async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      state.requests.push({ method: req.method, path: url.pathname, query: url.search, at: new Date().toISOString() });
      if (state.requests.length > 500) state.requests.splice(0, state.requests.length - 500);
      if (req.method === "OPTIONS") return send(res, 204);
      if (url.pathname === "/health") return send(res, 200, { ok: true, timeZone: state.timeZone, scenarios: state.scenarios, events: { google: state.google.length, outlook: state.outlook.length } });
      if (url.pathname === "/state" && req.method === "GET") return send(res, 200, { timeZone: state.timeZone, scenarios: state.scenarios, google: state.google, outlook: state.outlook, requests: state.requests.slice(-50) });
      if (url.pathname === "/reset" && req.method === "POST") { reset(state); return send(res, 200, { ok: true }); }
      if (url.pathname === "/scenario" && req.method === "POST") {
        let body = {};
        try { body = JSON.parse(await readBody(req) || "{}"); } catch { return send(res, 400, { error: "invalid_json" }); }
        for (const provider of ["google", "microsoft"]) {
          if (body[provider] === undefined) continue;
          if (!SCENARIOS.includes(body[provider])) return send(res, 400, { error: "invalid_scenario", message: `Use one of ${SCENARIOS.join(", ")}.` });
          state.scenarios[provider] = body[provider];
        }
        return send(res, 200, { ok: true, scenarios: state.scenarios });
      }
      // Layer 2: Den capability routes.
      if (req.method === "GET" && url.pathname === "/v1/capabilities/google-workspace/calendar-events") {
        const answer = denCalendarEvents(state, "google", url.searchParams);
        return send(res, answer.status, answer.body);
      }
      if (req.method === "GET" && url.pathname === "/v1/capabilities/microsoft-365/calendar-events") {
        const answer = denCalendarEvents(state, "microsoft", url.searchParams);
        return send(res, answer.status, answer.body);
      }
      // Layer 1: provider upstreams (require a bearer token like the real APIs).
      if (req.method === "GET" && url.pathname === "/calendar/v3/calendars/primary/events") {
        if (!bearer(req)) return send(res, 401, googleError(401, "Request is missing required authentication credential.", "required"));
        const failure = upstreamFailure("google", state.scenarios.google);
        if (failure) return send(res, failure.status, failure.body, failure.headers);
        const answer = googleEventsList(state, url.searchParams);
        return send(res, answer.status, answer.body);
      }
      if (req.method === "GET" && url.pathname === "/v1.0/me/calendarView") {
        if (!bearer(req)) return send(res, 401, graphError("InvalidAuthenticationToken", "Access token is empty."));
        const failure = upstreamFailure("microsoft", state.scenarios.microsoft);
        if (failure) return send(res, failure.status, failure.body, failure.headers);
        const self = `http://${req.headers.host ?? "localhost"}${url.pathname}`;
        const answer = graphCalendarView(state, url.searchParams, String(req.headers.prefer ?? ""), self);
        return send(res, answer.status, answer.body, answer.headers);
      }
      // Layer 3: MCP.
      if (url.pathname === "/mcp" || url.pathname === "/mcp/") {
        if (req.method === "GET") return send(res, 405, { error: "SSE stream not offered; use POST." }, { allow: "POST, DELETE" });
        if (req.method === "DELETE") return send(res, 200, { ok: true });
        if (req.method !== "POST") return send(res, 405, { error: "method_not_allowed" });
        let payload;
        try { payload = JSON.parse(await readBody(req)); } catch { return send(res, 400, { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }); }
        const session = { "mcp-session-id": String(req.headers["mcp-session-id"] ?? randomUUID()) };
        if (Array.isArray(payload)) {
          const responses = payload.map((message) => handleRpc(state, message)).filter(Boolean);
          return responses.length ? send(res, 200, responses, session) : send(res, 202, undefined, session);
        }
        const response = handleRpc(state, payload);
        return response ? send(res, 200, response, session) : send(res, 202, undefined, session);
      }
      return send(res, 404, { error: "not_found" });
    } catch (error) {
      console.error(error);
      if (!res.headersSent) send(res, 500, { error: "internal_error" });
    }
  };
}

/** Starts the mock; resolves with its base URL and a stop function. */
export async function startCalendarMock(options = {}) {
  const state = createCalendarMockState(options);
  const server = createServer(createCalendarMockHandler(state));
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, options.host ?? "127.0.0.1", resolve);
  });
  const address = server.address();
  const baseUrl = `http://${options.host ?? "127.0.0.1"}:${typeof address === "object" && address ? address.port : options.port}`;
  return {
    baseUrl, state,
    stop: () => new Promise((resolve) => { server.closeAllConnections?.(); server.close(() => resolve()); }),
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const mock = await startCalendarMock({ env: process.env, host: process.env.HOST || "127.0.0.1", port: Number(process.env.PORT || 3991) });
  console.log(`[calendar-mock] listening on ${mock.baseUrl} (${mock.state.timeZone}; google=${mock.state.scenarios.google}, microsoft=${mock.state.scenarios.microsoft})`);
  for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => void mock.stop().then(() => process.exit(0)));
}
