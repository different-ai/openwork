import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { extractCalendarEvents } from "../../../../ee/apps/den-api/src/capability-sources/google-workspace-api";
import { extractMicrosoftCalendarEvents } from "../../../../ee/apps/den-api/src/capability-sources/microsoft-graph";
import {
  createCalendarAdapter,
  normalizeGoogleEvent,
  normalizeMicrosoftEvent,
  type CalendarTransport,
} from "../../../../apps/app/src/react-app/domains/calendar/calendar-adapters";
import {
  denGoogleCalendarEventsResponseSchema,
  denMicrosoftCalendarEventsResponseSchema,
} from "../../../../apps/app/src/app/lib/den-calendar-contract";
import { CalendarConnectionError } from "../../../../apps/app/src/react-app/domains/calendar/calendar-event";
import { createMockCalendarTransport } from "../../../../apps/app/src/react-app/domains/calendar/calendar-source";
import { calendarRange } from "../../../../apps/app/src/react-app/domains/calendar/calendar-time";
import {
  createCalendarMockState,
  denCalendarEvents,
  googleEventsList,
  graphCalendarView,
  SCENARIOS,
  startCalendarMock,
} from "./calendar-mock.mjs";

/**
 * One chain, both providers: the calendar mock's provider payloads (Google
 * Calendar v3 / Graph calendarView shapes) → den-api's real extractors → the
 * Den capability route body → the desktop adapters' normalized events. The mock
 * must serve exactly what Den would, so the desktop can switch between the
 * mock and real connections with no code change.
 */

const ZONE = "America/Los_Angeles";
// Wednesday 2026-10-07 10:00 PDT: a fixed week so assertions are exact.
const NOW = Date.parse("2026-10-07T17:00:00Z");
const WEEK = calendarRange("week", { year: 2026, month: 10, day: 7 }, ZONE, 1);
const iso = (instant: number) => new Date(instant).toISOString().replace(/\.\d{3}Z$/, "Z");

function denQuery(timeMin: number, timeMax: number, maxResults?: number) {
  const query = new URLSearchParams({ timeMin: iso(timeMin), timeMax: iso(timeMax) });
  if (maxResults !== undefined) query.set("maxResults", String(maxResults));
  return query;
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Expected an object");
  return Object.fromEntries(Object.entries(value));
}

describe("calendar mock mirrors Den's calendar contracts", () => {
  const state = createCalendarMockState({ now: NOW, timeZone: ZONE });

  test("Google: the Den route body equals den-api's extractor over the upstream page", () => {
    const upstream = googleEventsList(state, new URLSearchParams({ timeMin: iso(WEEK.start), timeMax: iso(WEEK.end), singleEvents: "true", orderBy: "startTime", maxResults: "100" }));
    expect(upstream.status).toBe(200);
    const route = denCalendarEvents(state, "google", denQuery(WEEK.start, WEEK.end, 100));
    expect(route.status).toBe(200);
    expect(route.body).toEqual({ ok: true, events: extractCalendarEvents(upstream.body) });
  });

  test("Microsoft: the Den route body equals den-api's extractor over calendarView", () => {
    const upstream = graphCalendarView(state, new URLSearchParams({ startDateTime: iso(WEEK.start), endDateTime: iso(WEEK.end), $top: "100", $orderby: "start/dateTime" }));
    expect(upstream.status).toBe(200);
    const route = denCalendarEvents(state, "microsoft", denQuery(WEEK.start, WEEK.end, 100));
    expect(route.body).toEqual({ ok: true, events: extractMicrosoftCalendarEvents(upstream.body) });
  });

  test("route quirks match Den: default 25, maximum 100, no page token, Microsoft rejects offsets", () => {
    const wide = denQuery(WEEK.start - 21 * 86_400_000, WEEK.end + 21 * 86_400_000);
    const defaulted = record(denCalendarEvents(state, "google", wide).body);
    expect(Array.isArray(defaulted.events) && defaulted.events.length).toBe(25);
    expect(defaulted).not.toHaveProperty("nextPageToken");
    expect(denCalendarEvents(state, "google", denQuery(WEEK.start, WEEK.end, 101)).status).toBe(400);
    const offset = new URLSearchParams({ timeMin: "2026-10-05T00:00:00-07:00", timeMax: "2026-10-12T00:00:00-07:00" });
    expect(denCalendarEvents(state, "google", offset).status).toBe(200);
    expect(denCalendarEvents(state, "microsoft", offset).status).toBe(400);
  });

  test("upstream pagination and recurrence semantics follow the providers", () => {
    const firstPage = record(googleEventsList(state, new URLSearchParams({ singleEvents: "true", maxResults: "5" })).body);
    expect(typeof firstPage.nextPageToken).toBe("string");
    const masters = record(googleEventsList(state, new URLSearchParams({ timeMin: iso(WEEK.start - 30 * 86_400_000), timeMax: iso(WEEK.end) })).body);
    expect(JSON.stringify(masters.items)).toContain("RRULE:FREQ=WEEKLY");
    const ordered = googleEventsList(state, new URLSearchParams({ orderBy: "startTime" }));
    expect(ordered.status).toBe(400);
    const deleted = record(googleEventsList(state, new URLSearchParams({ timeMin: iso(WEEK.start), timeMax: iso(WEEK.end), singleEvents: "true", showDeleted: "true" })).body);
    expect(JSON.stringify(deleted.items)).toContain('"status":"cancelled"');
    const graphPage = record(graphCalendarView(state, new URLSearchParams({ startDateTime: iso(WEEK.start), endDateTime: iso(WEEK.end + 14 * 86_400_000), $top: "2" }), "", "http://mock/v1.0/me/calendarView").body);
    expect(String(graphPage["@odata.nextLink"])).toContain("%24skip=2");
    const pacific = record(graphCalendarView(state, new URLSearchParams({ startDateTime: iso(WEEK.start), endDateTime: iso(WEEK.end) }), 'outlook.timezone="America/Los_Angeles"').body);
    expect(JSON.stringify(pacific.value)).toContain('"timeZone":"America/Los_Angeles"');
  });
});

describe("desktop adapters normalize both providers", () => {
  const state = createCalendarMockState({ now: NOW, timeZone: ZONE });
  const google = denGoogleCalendarEventsResponseSchema.parse(denCalendarEvents(state, "google", denQuery(WEEK.start, WEEK.end + 7 * 86_400_000, 100)).body).events;
  const outlook = denMicrosoftCalendarEventsResponseSchema.parse(denCalendarEvents(state, "microsoft", denQuery(WEEK.start, WEEK.end + 7 * 86_400_000, 100)).body).events;

  test("Google timed events become instants with their offsets applied", () => {
    const briefing = google.map(normalizeGoogleEvent).find((event) => event?.title === "Press briefing");
    expect(briefing?.timing).toEqual({ kind: "timed", start: Date.parse("2026-10-06T18:00:00Z"), end: Date.parse("2026-10-06T19:00:00Z"), timeZone: null });
    expect(briefing?.meetingUrl).toBe("https://meet.google.com/prs-brfg-001");
    expect(briefing?.sourceUrl).toMatch(/^https:\/\/www\.google\.com\/calendar\/event\?eid=/);
  });

  test("Google all-day events keep dates with an exclusive end, including multi-day", () => {
    const events = google.map(normalizeGoogleEvent);
    expect(events.find((event) => event?.title === "Fleet 2.0 launch day")?.timing).toEqual({ kind: "all_day", startDate: { year: 2026, month: 10, day: 9 }, endDate: { year: 2026, month: 10, day: 10 } });
    expect(events.find((event) => event?.title === "Sales kickoff (offsite)")?.timing).toEqual({ kind: "all_day", startDate: { year: 2026, month: 10, day: 12 }, endDate: { year: 2026, month: 10, day: 14 } });
  });

  test("private Google events read as Busy and cancelled instances never appear", () => {
    const events = google.map(normalizeGoogleEvent);
    expect(events.some((event) => event?.title === "Busy")).toBe(true);
    const standups = events.filter((event) => event?.title === "Launch standup" && event.timing.kind === "timed" && event.timing.start < WEEK.end);
    expect(standups).toHaveLength(4); // Wednesday's instance was cancelled.
  });

  test("a Berlin-fixed meeting moves in Los Angeles across the European DST change", () => {
    const syncs = google.map(normalizeGoogleEvent).filter((event) => event?.title === "EU partner sync (Berlin)");
    const firstAll = createCalendarMockState({ now: Date.parse("2026-10-21T17:00:00Z"), timeZone: ZONE });
    const later = denGoogleCalendarEventsResponseSchema.parse(denCalendarEvents(firstAll, "google", denQuery(Date.parse("2026-10-19T07:00:00Z"), Date.parse("2026-11-03T08:00:00Z"), 100)).body).events;
    const starts = later.map(normalizeGoogleEvent).filter((event) => event?.title === "EU partner sync (Berlin)")
      .map((event) => event && event.timing.kind === "timed" ? new Date(event.timing.start).toISOString() : "");
    expect(syncs.length).toBeGreaterThan(0);
    // 17:00 CEST = 15:00Z (8 AM PDT); 17:00 CET after Oct 25 = 16:00Z (9 AM PDT); after Nov 1 still 16:00Z (8 AM PST).
    expect(starts).toEqual(["2026-10-19T15:00:00.000Z", "2026-10-26T16:00:00.000Z", "2026-11-02T16:00:00.000Z"]);
  });

  test("Microsoft UTC wall times, isAllDay and subjects normalize", () => {
    const events = outlook.map(normalizeMicrosoftEvent);
    const review = events.find((event) => event?.title === "Partner pipeline review");
    expect(review?.timing).toEqual({ kind: "timed", start: Date.parse("2026-10-06T20:00:00Z"), end: Date.parse("2026-10-06T20:45:00Z"), timeZone: "UTC" });
    expect(events.find((event) => event?.title === "Quarterly business review")?.meetingUrl).toContain("teams.microsoft.test");
    expect(events.find((event) => event?.title === "Company holiday")?.timing).toEqual({ kind: "all_day", startDate: { year: 2026, month: 10, day: 16 }, endDate: { year: 2026, month: 10, day: 17 } });
  });

  test("Microsoft zone pairs other than UTC (IANA and Windows names) resolve to the right instant", () => {
    const base = outlook.find((event) => event.subject === "Partner pipeline review");
    expect(base).toBeDefined();
    if (!base) return;
    const windows = normalizeMicrosoftEvent({ ...base, start: "2026-10-06T13:00:00.0000000", startTimeZone: "Pacific Standard Time", end: "2026-10-06T13:45:00.0000000", endTimeZone: "Pacific Standard Time" });
    const iana = normalizeMicrosoftEvent({ ...base, start: "2026-10-06T22:00:00.0000000", startTimeZone: "Europe/Berlin", end: "2026-10-06T22:45:00.0000000", endTimeZone: "Europe/Berlin" });
    expect(windows?.timing).toMatchObject({ start: Date.parse("2026-10-06T20:00:00Z"), end: Date.parse("2026-10-06T20:45:00Z") });
    expect(iana?.timing).toMatchObject({ start: Date.parse("2026-10-06T20:00:00Z") });
    const untitled = normalizeMicrosoftEvent({ ...base, subject: "  " });
    expect(untitled?.title).toBe("(No title)");
  });
});

describe("adapters against the running mock", () => {
  let mock: Awaited<ReturnType<typeof startCalendarMock>>;
  let transport: CalendarTransport;
  beforeAll(async () => {
    // 150 extra events on Tuesday overflow Den's 100-event page.
    mock = await startCalendarMock({ now: NOW, timeZone: ZONE, load: 150 });
    transport = createMockCalendarTransport(mock.baseUrl);
  });
  afterAll(async () => { await mock?.stop(); });

  test("full pages are split until every meeting in the week is read", async () => {
    for (const provider of ["google", "microsoft"] as const) {
      const result = await createCalendarAdapter(provider, transport).readRange({ start: WEEK.start, end: WEEK.end });
      expect(result.complete).toBe(true);
      expect(result.requests).toBeGreaterThan(1);
      expect(result.events.filter((event) => event.title.startsWith("Focus block"))).toHaveLength(150);
      expect(new Set(result.events.map((event) => event.key)).size).toBe(result.events.length);
    }
  });

  test.each([
    ["connection_missing", "not_connected"],
    ["scope_missing", "permission_missing"],
    ["policy_blocked", "policy_blocked"],
    ["expired_token", "auth_expired"],
    ["throttled", "throttled"],
  ] as const)("scenario %s becomes a typed %s error for both providers", async (scenario, kind) => {
    expect(SCENARIOS).toContain(scenario);
    for (const provider of ["google", "microsoft"] as const) {
      const response = await fetch(`${mock.baseUrl}/scenario`, { method: "POST", body: JSON.stringify({ [provider]: scenario }) });
      expect(response.ok).toBe(true);
      const error = await createCalendarAdapter(provider, transport).readRange({ start: WEEK.start, end: WEEK.end }).then(() => null, (caught: unknown) => caught);
      expect(error).toBeInstanceOf(CalendarConnectionError);
      expect(error instanceof CalendarConnectionError && error.kind).toBe(kind);
      await fetch(`${mock.baseUrl}/scenario`, { method: "POST", body: JSON.stringify({ [provider]: "ok" }) });
    }
  });

  test("the MCP endpoint returns the Den route body as structured content", async () => {
    const call = await fetch(`${mock.baseUrl}/mcp`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "google_workspace_calendar_events", arguments: { timeMin: iso(WEEK.start), timeMax: iso(WEEK.end), maxResults: 10 } } }),
    });
    const body = record(await call.json());
    const result = record(body.result);
    expect(result.isError).toBe(false);
    expect(result.structuredContent).toEqual(denCalendarEvents(mock.state, "google", denQuery(WEEK.start, WEEK.end, 10)).body);
  });
});
