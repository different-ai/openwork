import assert from "node:assert/strict"
import { after, test } from "node:test"
import { denGoogleCalendarEventsResponseSchema } from "../../../../../packages/calendar/src/den-contract.js"
import { bootDen, field, isRecord, list, startFakeHttpServer, summary, text } from "./harness.js"

const calls: { method: string; path: string; query: string; authorization: string; etag?: string; body: unknown }[] = []
const events = new Map<string, Record<string, unknown>>()
// Google PATCH merges nested objects and removes fields set to null.
function applyPatch(current: Record<string, unknown>, patch: Record<string, unknown>): Record<string, unknown> {
  const result = { ...current }
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete result[key]
    else result[key] = isRecord(value) ? applyPatch(isRecord(current[key]) ? current[key] : {}, value) : value
  }
  return result
}
const providerPath = "/calendar/v3/calendars/primary/events"
const path = "/v1/capabilities/google-workspace/calendar-working-location"
const eventPath = "/v1/capabilities/google-workspace/calendar-events"
const home = { type: "homeOffice", homeOffice: {} }
let nextId = 0
let receipt: "confirmed" | "wrong" | "cancelled" | "failure" = "confirmed"
let paginated = false
const provider = await startFakeHttpServer((request, body, response) => {
  const target = new URL(request.url ?? "/", "http://fixture.test")
  response.setHeader("content-type", "application/json")
  if (target.pathname === "/token") {
    const code = new URLSearchParams(body).get("code") ?? "unknown"
    return void response.end(JSON.stringify({ access_token: code, refresh_token: `refresh_${code}`, expires_in: 3600, token_type: "Bearer", scope: "openid https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/userinfo.profile https://www.googleapis.com/auth/calendar.readonly https://www.googleapis.com/auth/calendar.events" }))
  }
  if (target.pathname === "/userinfo") return void response.end(JSON.stringify({ sub: "calendar_account", email: "calendar@example.test", name: "Connected Member" }))
  const parsed: unknown = body ? JSON.parse(body) : null
  calls.push({ method: request.method ?? "GET", path: target.pathname, query: target.search, authorization: request.headers.authorization ?? "", etag: typeof request.headers["if-match"] === "string" ? request.headers["if-match"] : undefined, body: parsed })
  if (target.pathname === providerPath && request.method === "GET") {
    assert.equal(target.searchParams.get("singleEvents"), "true")
    const items = [...events.values()].filter((event) => !event.recurrence)
    if (target.searchParams.has("eventTypes")) {
      assert.equal(target.searchParams.get("eventTypes"), "workingLocation")
      assert.equal(target.searchParams.get("timeMin"), "2026-11-16T00:00:00+14:00")
      assert.ok(["2026-11-21T00:00:00-12:00", "2026-11-17T00:00:00-12:00"].includes(target.searchParams.get("timeMax") ?? ""))
      if (paginated && !target.searchParams.has("pageToken")) return void response.end(JSON.stringify({ items: [], nextPageToken: "second" }))
    }
    return void response.end(JSON.stringify({ items }))
  }
  const id = target.pathname.startsWith(`${providerPath}/`) ? target.pathname.slice(providerPath.length + 1) : ""
  const existing = events.get(id)
  if (existing && request.method === "GET") return void response.end(JSON.stringify(existing))
  if ((target.pathname === providerPath && request.method === "POST") || (existing && request.method === "PATCH")) {
    assert.ok(isRecord(parsed))
    assert.equal(target.searchParams.get("sendUpdates"), "none")
    assert.equal(parsed.attendees, undefined)
    assert.equal(parsed.recurrence, undefined)
    if (request.method === "PATCH") assert.equal(parsed.eventType, undefined, "eventType is immutable")
    const eventId = existing ? id : `location_${++nextId}`
    const event = { ...applyPatch(existing ?? {}, parsed), id: eventId, status: "confirmed", etag: '"version-1"' }
    events.set(eventId, event)
    if (receipt === "failure") { response.statusCode = 503; return void response.end(JSON.stringify({ error: { message: "Unavailable" } })) }
    if (receipt === "wrong") return void response.end(JSON.stringify({ ...event, workingLocationProperties: home }))
    if (receipt === "cancelled") return void response.end(JSON.stringify({ ...event, status: "cancelled" }))
    return void response.end(JSON.stringify(event))
  }
  response.statusCode = 404
  response.end(JSON.stringify({ error: { message: "Not found" } }))
})
const den = await bootDen({ env: {
  DEN_AUDIT_SELF_HOSTED_ENABLED: "true",
  DEN_GOOGLE_API_BASE_URL: provider.url,
  DEN_GOOGLE_OAUTH_AUTHORIZE_URL: `${provider.url}/authorize`,
  DEN_GOOGLE_OAUTH_TOKEN_URL: `${provider.url}/token`,
  DEN_GOOGLE_OAUTH_USERINFO_URL: `${provider.url}/userinfo`,
} })
after(async () => { await den.close(); await provider.close() })
const range = { from: "2026-11-16", to: "2026-11-20" }
const custom = { ...range, type: "custom", customLabel: "San Francisco" }
function seed(id: string, date: string, extra: Record<string, unknown> = {}) {
  events.set(id, { id, status: "confirmed", summary: "Home", eventType: "workingLocation", workingLocationProperties: home, start: { date }, end: { date: `2026-11-${Number(date.slice(-2)) + 1}` }, visibility: "public", transparency: "transparent", etag: '"version-1"', ...extra })
}

test("Google Calendar working locations use isolated provider requests and day-scoped mutations", async (t) => {
  const { owner, orgId } = await den.createOrg(await den.signUp("Working Location Owner"), "Working location workspace")
  const call = den.as(owner, orgId)
  const configured = await call("POST", "/v1/oauth-providers/google-workspace/client", { clientId: "fixture_client", clientSecret: "fixture_secret", features: ["calendarRead", "calendarWrite"] })
  assert.equal(configured.status, 200, summary(configured))
  await t.test("default-off working locations reject writes before contacting the provider", async () => {
    const before = calls.length
    const denied = await call("POST", path, custom)
    assert.equal(denied.status, 400, summary(denied))
    assert.ok(denied.text.includes("googleCalendarWorkingLocation"))
    assert.equal(calls.length, before)
  })
  assert.equal((await den.setFeature(orgId, "googleCalendarWorkingLocation", true)).status, 200)
  await t.test("an unconnected member cannot read or write the provider", async () => {
    const before = calls.length
    const denied = await call("POST", path, custom)
    assert.equal(denied.status, 409, summary(denied))
    assert.equal(calls.length, before)
  })
  const started = await call("GET", "/v1/oauth-providers/google-workspace/connect/start")
  assert.equal(started.status, 200, summary(started))
  const authorization = new URL(text(field(started.body, "authorizeUrl"), "authorization URL"))
  const callback = new URL(text(authorization.searchParams.get("redirect_uri"), "redirect URI"))
  callback.searchParams.set("state", text(authorization.searchParams.get("state"), "OAuth state"))
  callback.searchParams.set("code", "calendar_account")
  const connected = await den.request(null, "GET", callback.pathname + callback.search)
  assert.equal(connected.status, 200, summary(connected))

  await t.test("the agent discovers and executes the working-location capability using the same account", async () => {
    const mcpToken = await den.mintMcpToken(owner, orgId)
    const discovered = await den.callMcpTool(mcpToken, "search_capabilities", { query: "Google Calendar working location", limit: 20 })
    assert.ok(discovered.raw.includes("setGoogleCalendarWorkingLocation"), discovered.raw.slice(0, 1500))
    const set = await den.callMcpTool(mcpToken, "execute_capability", { name: "native:google-workspace:setGoogleCalendarWorkingLocation", body: custom })
    assert.equal(set.isError, false, set.text)
    assert.ok(set.text.includes("San Francisco"), set.text)
    events.clear()
    nextId = 0
  })
  await t.test("custom range creates exactly one public transparent all-day event per inclusive day without invitations", async () => {
    const before = calls.length
    const created = await call("POST", path, custom)
    assert.equal(created.status, 200, summary(created))
    assert.equal(field(created.body, "calendarId"), "primary")
    const returned = list(field(created.body, "events"))
    assert.equal(returned.length, 5)
    assert.deepEqual(returned.map((event) => field(event, "start", "date")), ["2026-11-16", "2026-11-17", "2026-11-18", "2026-11-19", "2026-11-20"])
    assert.equal(field(returned.at(-1), "end", "date"), "2026-11-21")
    assert.deepEqual(calls.slice(before).map((entry) => entry.method), ["GET", "POST", "POST", "POST", "POST", "POST"])
    for (const entry of calls.slice(before)) assert.equal(entry.authorization, "Bearer calendar_account")
    for (const event of returned) {
      assert.equal(event.eventType, "workingLocation")
      assert.equal(event.visibility, "public")
      assert.equal(event.transparency, "transparent")
      assert.deepEqual(event.workingLocationProperties, { type: "customLocation", customLocation: { label: "San Francisco" } })
    }
  })
  await t.test("list and get expose working-location type and properties, preserving ordinary event types", async () => {
    events.set("meeting", { id: "meeting", status: "confirmed", eventType: "default", summary: "Normal meeting" })
    const listed = await call("GET", `${eventPath}?timeMin=2026-11-16T00:00:00Z&timeMax=2026-11-21T00:00:00Z`)
    assert.equal(listed.status, 200, summary(listed))
    const desktop = denGoogleCalendarEventsResponseSchema.parse(listed.body)
    assert.equal(desktop.events[0]?.eventType, "workingLocation")
    assert.deepEqual(desktop.events[0]?.workingLocationProperties, { type: "customLocation", customLocation: { label: "San Francisco" } })
    const entries = list(field(listed.body, "events"))
    const location = entries.find((event) => event.id === "location_1")
    assert.equal(field(location, "eventType"), "workingLocation")
    assert.deepEqual(field(location, "workingLocationProperties"), { type: "customLocation", customLocation: { label: "San Francisco" } })
    assert.equal(field(entries.find((event) => event.id === "meeting"), "workingLocationProperties"), null)
    const got = await call("GET", `${eventPath}/location_1`)
    assert.equal(got.status, 200, summary(got))
    assert.deepEqual(field(got.body, "event", "workingLocationProperties"), field(location, "workingLocationProperties"))
    assert.equal(field(got.body, "event", "eventType"), "workingLocation")
    events.clear()
  })
  await t.test("pagination finds a recurring instance; replacement touches only that day, not master, sibling or ordinary events", async () => {
    seed("home_series", "2026-11-16", { recurrence: ["RRULE:FREQ=DAILY;COUNT=5"] })
    seed("home_16", "2026-11-16", { recurringEventId: "home_series" })
    seed("home_17", "2026-11-17", { recurringEventId: "home_series" })
    events.set("meeting", { id: "meeting", status: "confirmed", eventType: "default" })
    const untouched = new Map([...events].map(([id, event]) => [id, structuredClone(event)]))
    paginated = true
    const before = calls.length
    const changed = await call("POST", path, custom)
    paginated = false
    assert.equal(changed.status, 200, summary(changed))
    const writes = calls.slice(before).filter((entry) => entry.method !== "GET")
    assert.deepEqual(writes.map((entry) => entry.path), [`${providerPath}/home_16`, `${providerPath}/home_17`, providerPath, providerPath, providerPath])
    assert.equal(writes[0].etag, '"version-1"')
    assert.deepEqual(events.get("home_series"), untouched.get("home_series"))
    assert.deepEqual(events.get("meeting"), untouched.get("meeting"))
    assert.equal(events.get("home_16")?.recurringEventId, "home_series")
    assert.equal(field(events.get("home_16"), "workingLocationProperties", "homeOffice"), undefined)
    // Replace a single recurring Home day with custom; preserve its sibling.
    seed("home_16", "2026-11-16", { recurringEventId: "home_series" })
    const sibling = structuredClone(events.get("home_17"))
    const size = events.size
    const beforeSingle = calls.length
    const single = await call("POST", path, { ...custom, to: "2026-11-16" })
    assert.equal(single.status, 200, summary(single))
    assert.deepEqual(calls.slice(beforeSingle).map((entry) => entry.method), ["GET", "PATCH"])
    assert.equal(calls.at(-1)?.path, `${providerPath}/home_16`)
    assert.deepEqual(events.get("home_17"), sibling)
    assert.equal(events.size, size)
    assert.deepEqual(field(events.get("home_16"), "workingLocationProperties"), { type: "customLocation", customLocation: { label: "San Francisco" } })
    assert.deepEqual(events.get("home_series"), untouched.get("home_series"))
    events.clear()
  })
  await t.test("home and office payloads round-trip all optional office identifiers", async () => {
    for (const input of [{ ...range, type: "home" }, { ...range, type: "office", officeLabel: "HQ", buildingId: "b1", floorId: "f1", floorSectionId: "north", deskId: "d1" }]) {
      const created = await call("POST", path, input)
      assert.equal(created.status, 200, summary(created))
      const properties = field(list(field(created.body, "events"))[0], "workingLocationProperties")
      assert.deepEqual(properties, input.type === "home" ? home : { type: "officeLocation", officeLocation: { label: "HQ", buildingId: "b1", floorId: "f1", floorSectionId: "north", deskId: "d1" } })
      events.clear()
    }
  })
  await t.test("setting a new office clears old optional identifiers instead of retaining stale nested PATCH fields", async () => {
    seed("office", "2026-11-16", { workingLocationProperties: { type: "officeLocation", officeLocation: { label: "Old HQ", buildingId: "old", deskId: "old-desk" } } })
    const changed = await call("POST", path, { ...range, type: "office", officeLabel: "New HQ" })
    assert.equal(changed.status, 200, summary(changed))
    assert.deepEqual(field(events.get("office"), "workingLocationProperties"), { type: "officeLocation", officeLocation: { label: "New HQ" } })
    events.clear()
  })
  await t.test("invalid types, dates, ranges, labels and invitations are rejected before any provider read", async () => {
    const before = calls.length
    for (const input of [
      { ...custom, type: "unknown" }, { ...custom, from: "2026-02-30" }, { ...custom, to: "not-a-date" },
      { ...custom, from: "2026-11-21" }, { ...custom, to: "2026-12-17" }, { ...custom, from: "9999-12-31", to: "9999-12-31" }, { ...range, type: "custom" },
      { ...custom, customLabel: " " }, { ...range, type: "home", officeLabel: "HQ" },
      { ...custom, attendees: ["guest@example.test"] }, { ...custom, sendUpdates: "all" }, { ...custom, calendarId: "other" },
    ]) assert.equal((await call("POST", path, input)).status, 400)
    assert.equal(calls.length, before)
  })
  await t.test("duplicate or timed locations fail preflight without changing any day", async () => {
    for (const extra of [
      { start: { dateTime: "2026-11-17T09:00:00Z" }, end: { dateTime: "2026-11-17T17:00:00Z" } },
      { start: { date: "2026-11-15" }, end: { date: "2026-11-18" } },
      {},
    ]) {
      seed("first", "2026-11-17")
      seed("conflict", "2026-11-17", extra)
      const before = calls.length
      const snapshot = structuredClone([...events])
      assert.equal((await call("POST", path, custom)).status, 400)
      assert.deepEqual(calls.slice(before).map((entry) => entry.method), ["GET"])
      assert.deepEqual([...events], snapshot)
      events.clear()
    }
  })
  for (const mode of ["wrong", "cancelled", "failure"]) {
    await t.test(`unconfirmed ${mode} write stops the range and is never retried`, async () => {
      receipt = mode
      const before = calls.length
      try {
        const result = await call("POST", path, custom)
        assert.equal(result.status, 502, summary(result))
        assert.deepEqual(calls.slice(before).map((entry) => entry.method), ["GET", "POST"])
        assert.equal(events.size, 1, "a provider may store a write before returning an error")
      } finally { receipt = "confirmed"; events.clear() }
    })
  }
  await t.test("disabling working-location writes preserves read metadata and every stored instance", async () => {
    seed("keep", "2026-11-16", { recurringEventId: "home_series" })
    const snapshot = structuredClone([...events])
    assert.equal((await den.setFeature(orgId, "googleCalendarWorkingLocation", false)).status, 200)
    const before = calls.length
    assert.equal((await call("POST", path, custom)).status, 400)
    assert.equal(calls.length, before)
    const got = await call("GET", `${eventPath}/keep`)
    assert.equal(got.status, 200, summary(got))
    assert.deepEqual(field(got.body, "event", "workingLocationProperties"), home)
    assert.deepEqual([...events], snapshot)
    assert.equal((await den.setFeature(orgId, "googleCalendarWorkingLocation", true)).status, 200)
    events.clear()
  })
  await t.test("working-location audits record the operation without labels or credentials", async () => {
    // Audit capture is asynchronous; poll the public history before inspecting storage.
    const deadline = Date.now() + 5_000
    for (;;) {
      const history = await call("GET", "/v1/audit/operations?limit=50&action=capability.google_calendar.working_location.set.confirmed")
      assert.equal(history.status, 200, summary(history))
      if (list(field(history.body, "operations")).length > 0) break
      assert.ok(Date.now() < deadline, "working-location operation was not audited")
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    const audit = await den.auditStorageText()
    assert.ok(audit.includes("capability.google_calendar.working_location.set"))
    for (const privateValue of ["San Francisco", "Old HQ", "New HQ", "calendar_account", "fixture_secret"]) assert.equal(audit.includes(privateValue), false, `${privateValue} reached audit storage`)
  })
  await t.test("turning off Calendar write prevents even the replacement preflight", async () => {
    const changed = await call("POST", "/v1/oauth-providers/google-workspace/client", { clientId: "fixture_client", clientSecret: "fixture_secret", features: ["calendarRead"] })
    assert.equal(changed.status, 200, summary(changed))
    const before = calls.length
    const denied = await call("POST", path, custom)
    assert.equal(denied.status, 409, summary(denied))
    assert.equal(calls.length, before)
  })
})
