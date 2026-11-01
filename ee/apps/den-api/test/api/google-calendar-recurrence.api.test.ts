import assert from "node:assert/strict"
import { after, test } from "node:test"
import { bootDen, field, isRecord, list, startFakeHttpServer, summary, text } from "./harness.js"

const calls: { method: string; path: string; authorization: string; body: unknown }[] = []
const events = new Map<string, Record<string, unknown>>()
const providerPath = "/calendar/v3/calendars/primary/events"
const path = "/v1/capabilities/google-workspace/calendar-events"
const start = "2026-11-02T09:00:00-05:00"
const end = "2026-11-02T09:30:00-05:00"
const timeZone = "America/New_York"
const times = { start: { dateTime: start, timeZone }, end: { dateTime: end, timeZone } }
const recurrence = { frequency: "weekly", byWeekday: ["MO", "WE"], count: 10 }
const structuredRules = ["RRULE:FREQ=WEEKLY;BYDAY=MO,WE;COUNT=10"]
const rawRules = ["RRULE:FREQ=WEEKLY;COUNT=10"]
const eventInput = { summary: "Planning meeting", start, end }
const equivalentRules = [
  "RRULE:FREQ=WEEKLY;BYDAY=MO,WE;COUNT=10",
  "EXDATE:20261104T140000Z,20261109T140000Z",
  "RDATE:20261105T140000Z,20261110T140000Z",
]
const reorderedRules = [
  "RDATE:20261110T140000Z,20261105T140000Z",
  "RRULE:COUNT=10;BYDAY=WE,MO;INTERVAL=1;FREQ=WEEKLY",
  "EXDATE:20261109T140000Z,20261104T140000Z",
]
let nextId = 0
let mismatchReceipt = false
let createReceipt: "confirmed" | "omitted" | "mismatched" | "cancelled" = "confirmed"
let reorderReceipt = false
const provider = await startFakeHttpServer((request, body, response) => {
  const target = new URL(request.url ?? "/", "http://fixture.test")
  response.setHeader("content-type", "application/json")
  if (target.pathname === "/token") {
    const code = new URLSearchParams(body).get("code") ?? "unknown"
    return void response.end(JSON.stringify({ access_token: code, refresh_token: `refresh_${code}`, expires_in: 3600, token_type: "Bearer", scope: "openid https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/userinfo.profile https://www.googleapis.com/auth/calendar.readonly https://www.googleapis.com/auth/calendar.events" }))
  }
  if (target.pathname === "/userinfo") return void response.end(JSON.stringify({ sub: "calendar_account", email: "calendar@example.test", name: "Connected Member" }))
  const parsed: unknown = body ? JSON.parse(body) : null
  calls.push({ method: request.method ?? "GET", path: target.pathname, authorization: request.headers.authorization ?? "", body: parsed })
  if (target.pathname === providerPath && request.method === "POST") {
    assert.ok(isRecord(parsed))
    const id = `event_${++nextId}`
    const event: Record<string, unknown> = { ...parsed, id, status: "confirmed", htmlLink: `https://calendar.google.com/calendar/event?eid=${id}` }
    events.set(id, event)
    if (createReceipt === "omitted") {
      const { recurrence: _recurrence, ...withoutRecurrence } = event
      return void response.end(JSON.stringify(withoutRecurrence))
    }
    if (createReceipt === "mismatched") return void response.end(JSON.stringify({ ...event, recurrence: ["RRULE:FREQ=DAILY;COUNT=2"] }))
    if (createReceipt === "cancelled") return void response.end(JSON.stringify({ ...event, status: "cancelled" }))
    return void response.end(JSON.stringify(reorderReceipt ? { ...event, recurrence: reorderedRules } : event))
  }
  if (target.pathname === providerPath && request.method === "GET") {
    assert.equal(target.searchParams.get("singleEvents"), "true")
    return void response.end(JSON.stringify({ items: [...events.values()] }))
  }
  const id = target.pathname.startsWith(`${providerPath}/`) ? target.pathname.slice(providerPath.length + 1) : ""
  const existing = events.get(id)
  if (existing && request.method === "GET") return void response.end(JSON.stringify(existing))
  if (existing && request.method === "PATCH") {
    assert.ok(isRecord(parsed))
    assert.equal(target.searchParams.get("sendUpdates"), "none")
    const updated = { ...existing, ...parsed }
    events.set(id, updated)
    if (mismatchReceipt) return void response.end(JSON.stringify({ ...updated, recurrence: ["RRULE:FREQ=DAILY;COUNT=2"] }))
    return void response.end(JSON.stringify(reorderReceipt ? { ...updated, recurrence: reorderedRules } : updated))
  }
  response.statusCode = 404
  response.end(JSON.stringify({ error: { message: "Not found" } }))
})
const den = await bootDen({ env: {
  DEN_GOOGLE_API_BASE_URL: provider.url,
  DEN_GOOGLE_OAUTH_AUTHORIZE_URL: `${provider.url}/authorize`,
  DEN_GOOGLE_OAUTH_TOKEN_URL: `${provider.url}/token`,
  DEN_GOOGLE_OAUTH_USERINFO_URL: `${provider.url}/userinfo`,
} })
after(async () => { await den.close(); await provider.close() })

test("Google Calendar recurrence is gated, normalized and confirmed through the real API", async (t) => {
  const { owner, orgId } = await den.createOrg(await den.signUp("Calendar Owner"), "Calendar recurrence workspace")
  const call = den.as(owner, orgId)
  const configured = await call("POST", "/v1/oauth-providers/google-workspace/client", { clientId: "fixture_client", clientSecret: "fixture_secret", features: ["calendarRead", "calendarWrite"] })
  assert.equal(configured.status, 200, summary(configured))
  const started = await call("GET", "/v1/oauth-providers/google-workspace/connect/start")
  assert.equal(started.status, 200, summary(started))
  const authorization = new URL(text(field(started.body, "authorizeUrl"), "authorization URL"))
  const callback = new URL(text(authorization.searchParams.get("redirect_uri"), "redirect URI"))
  callback.searchParams.set("state", text(authorization.searchParams.get("state"), "OAuth state"))
  callback.searchParams.set("code", "calendar_account")
  const connected = await den.request(null, "GET", callback.pathname + callback.search)
  assert.equal(connected.status, 200, summary(connected))

  await t.test("default-off recurrence rejects structured and raw creates before contacting Google", async () => {
    const org = await call("GET", "/v1/org")
    assert.equal(org.status, 200, summary(org))
    assert.equal(field(org.body, "features", "googleCalendarRecurrence"), false)
    const before = calls.length
    for (const rule of [{ recurrence }, { rrule: rawRules }]) {
      const denied = await call("POST", path, { ...eventInput, timeZone, ...rule })
      assert.equal(denied.status, 400, summary(denied))
      assert.ok(denied.text.includes("googleCalendarRecurrence"), denied.text)
    }
    assert.equal(calls.length, before, "disabled recurrence never contacts the provider")
  })

  const enabled = await den.setFeature(orgId, "googleCalendarRecurrence", true)
  assert.equal(enabled.status, 200, summary(enabled))
  let masterId = ""
  await t.test("enabled structured recurrence sends only Google recurrence lines and returns the series receipt", async () => {
    const created = await call("POST", path, { ...eventInput, timeZone, recurrence })
    assert.equal(created.status, 200, summary(created))
    assert.equal(field(created.body, "ok"), true)
    assert.deepEqual(field(created.body, "recurrence"), structuredRules)
    masterId = text(field(created.body, "eventId"), "series master ID")
    assert.deepEqual(calls.at(-1), { method: "POST", path: providerPath, authorization: "Bearer calendar_account", body: { summary: eventInput.summary, ...times, recurrence: structuredRules } })
    assert.equal(field(created.body, "start"), start)
    assert.equal(field(created.body, "end"), end)
  })

  await t.test("enabled raw rrule is forwarded as recurrence and list exposes an occurrence's recurringEventId", async () => {
    const created = await call("POST", path, { ...eventInput, timeZone, rrule: rawRules })
    assert.equal(created.status, 200, summary(created))
    assert.deepEqual(field(created.body, "recurrence"), rawRules)
    assert.deepEqual(calls.at(-1)?.body, { summary: eventInput.summary, ...times, recurrence: rawRules })
    events.set("occurrence_one", { id: "occurrence_one", status: "confirmed", summary: eventInput.summary, ...times, recurringEventId: masterId })
    const listed = await call("GET", `${path}?timeMin=2026-11-01T00:00:00Z&timeMax=2026-12-01T00:00:00Z`)
    assert.equal(listed.status, 200, summary(listed))
    const occurrence = list(field(listed.body, "events")).find((event) => event.id === "occurrence_one")
    assert.equal(field(occurrence, "recurringEventId"), masterId)
    assert.equal(field(occurrence, "recurrence"), null)
  })

  await t.test("recurring creates require an IANA timeZone and reject recurrence combined with rrule before Google", async () => {
    const before = calls.length
    for (const input of [
      { ...eventInput, recurrence },
      { ...eventInput, rrule: rawRules },
      { ...eventInput, timeZone: "invalid/timezone", recurrence },
      { ...eventInput, timeZone, recurrence, rrule: rawRules },
    ]) {
      const invalid = await call("POST", path, input)
      assert.equal(invalid.status, 400, summary(invalid))
    }
    assert.equal(calls.length, before)
  })

  await t.test("recurrence patches require both timed endpoints with IANA zones and mutually exclusive rule inputs", async () => {
    const before = calls.length
    for (const input of [
      { recurrence },
      { start: times.start, recurrence },
      { start: { dateTime: start }, end: times.end, recurrence },
      { start: times.start, end: { dateTime: end }, rrule: rawRules },
      { start: { dateTime: start, timeZone: "invalid/timezone" }, end: times.end, recurrence },
      { start: { date: "2026-11-02" }, end: { date: "2026-11-03" }, recurrence },
      { ...times, recurrence, rrule: rawRules },
      { recurrence: null, rrule: rawRules },
    ]) {
      const invalid = await call("PATCH", `${path}/${masterId}`, { ...input, sendUpdates: "none" })
      assert.equal(invalid.status, 400, summary(invalid))
    }
    assert.equal(calls.length, before, "invalid patches do not even fetch the existing event")
  })

  await t.test("numeric offset timeZone values are rejected on recurring create and patch before Google", async () => {
    const before = calls.length
    for (const rule of [{ recurrence }, { rrule: rawRules }]) {
      const created = await call("POST", path, { ...eventInput, timeZone: "+01:00", ...rule })
      assert.equal(created.status, 400, summary(created))
      const patched = await call("PATCH", `${path}/${masterId}`, {
        start: { dateTime: start, timeZone: "+01:00" },
        end: { dateTime: end, timeZone: "+01:00" },
        ...rule,
        sendUpdates: "none",
      })
      assert.equal(patched.status, 400, summary(patched))
    }
    assert.equal(calls.length, before)
  })

  await t.test("structured and raw UNTIL before start are rejected on create and patch before Google", async () => {
    const before = calls.length
    for (const rule of [
      { recurrence: { frequency: "weekly", until: "2026-11-02T13:59:59Z" } },
      { recurrence: { frequency: "weekly", until: "2026-11-01" } },
      { rrule: ["RRULE:FREQ=WEEKLY;UNTIL=20261102T135959Z"] },
    ]) {
      const created = await call("POST", path, { ...eventInput, timeZone, ...rule })
      assert.equal(created.status, 400, summary(created))
      const patched = await call("PATCH", `${path}/${masterId}`, { ...times, ...rule, sendUpdates: "none" })
      assert.equal(patched.status, 400, summary(patched))
    }
    assert.equal(calls.length, before)
  })

  await t.test("date-only RDATE and EXDATE are rejected for timed creates and patches before Google", async () => {
    const before = calls.length
    for (const exception of ["RDATE:20261104", "EXDATE:20261104"]) {
      const rrule = [...rawRules, exception]
      const created = await call("POST", path, { ...eventInput, timeZone, rrule })
      assert.equal(created.status, 400, summary(created))
      const patched = await call("PATCH", `${path}/${masterId}`, { ...times, rrule, sendUpdates: "none" })
      assert.equal(patched.status, 400, summary(patched))
    }
    assert.equal(calls.length, before)
  })

  for (const mode of ["omitted", "mismatched", "cancelled"]) {
    const receiptProblem = mode === "cancelled" ? "cancelled status" : `${mode} recurrence`
    await t.test(`a create receipt with ${receiptProblem} returns 502 after storage without retrying`, async () => {
      const beforeCalls = calls.length
      const beforeEvents = events.size
      assert.ok(mode === "omitted" || mode === "mismatched" || mode === "cancelled")
      createReceipt = mode
      try {
        const unconfirmed = await call("POST", path, { ...eventInput, timeZone, recurrence })
        assert.equal(unconfirmed.status, 502, summary(unconfirmed))
        assert.deepEqual(calls.slice(beforeCalls).map((entry) => entry.method), ["POST"], "uncertain creates are never retried")
        assert.equal(events.size, beforeEvents + 1, "Google stored the event before returning an unconfirmed receipt")
        assert.deepEqual(events.get(`event_${nextId}`)?.recurrence, structuredRules)
      } finally {
        createReceipt = "confirmed"
      }
    })
  }

  await t.test("equivalent reordered recurrence rules are accepted in create and patch receipts", async () => {
    reorderReceipt = true
    try {
      const beforeCreate = calls.length
      const created = await call("POST", path, { ...eventInput, timeZone, rrule: equivalentRules })
      assert.equal(created.status, 200, summary(created))
      assert.equal(field(created.body, "ok"), true)
      assert.deepEqual(field(created.body, "recurrence"), reorderedRules)
      const id = text(field(created.body, "eventId"), "reordered receipt series ID")
      assert.deepEqual(calls.slice(beforeCreate).map((entry) => entry.method), ["POST"])
      assert.deepEqual(calls.at(-1)?.body, { summary: eventInput.summary, ...times, recurrence: equivalentRules })
      const beforePatch = calls.length
      const patched = await call("PATCH", `${path}/${id}`, { ...times, rrule: equivalentRules, sendUpdates: "none" })
      assert.equal(patched.status, 200, summary(patched))
      assert.equal(field(patched.body, "ok"), true)
      assert.deepEqual(field(patched.body, "event", "recurrence"), reorderedRules)
      assert.deepEqual(calls.slice(beforePatch).map((entry) => entry.method), ["GET", "PATCH"])
      assert.deepEqual(calls.at(-1)?.body, { ...times, recurrence: equivalentRules })
    } finally {
      reorderReceipt = false
    }
  })

  await t.test("master recurrence patches replace structured or raw rules and clear with recurrence null", async () => {
    for (const rule of [{ recurrence }, { rrule: rawRules }]) {
      const expected = "rrule" in rule ? rawRules : structuredRules
      const before = calls.length
      const updated = await call("PATCH", `${path}/${masterId}`, { ...times, ...rule, sendUpdates: "none" })
      assert.equal(updated.status, 200, summary(updated))
      assert.equal(field(updated.body, "ok"), true)
      assert.equal(field(updated.body, "event", "id"), masterId)
      assert.deepEqual(field(updated.body, "event", "recurrence"), expected)
      assert.deepEqual(calls.slice(before).map((entry) => entry.method), ["GET", "PATCH"])
      assert.deepEqual(calls.at(-1)?.body, { ...times, recurrence: expected })
    }
    const before = calls.length
    const cleared = await call("PATCH", `${path}/${masterId}`, { recurrence: null, sendUpdates: "none" })
    assert.equal(cleared.status, 200, summary(cleared))
    assert.equal(field(cleared.body, "event", "id"), masterId)
    assert.deepEqual(field(cleared.body, "event", "recurrence"), [])
    assert.deepEqual(calls.slice(before).map((entry) => entry.method), ["GET", "PATCH"])
    assert.deepEqual(calls.at(-1)?.body, { recurrence: [] }, "Google removes recurrence with an empty recurrence array, not a structured object")
  })

  await t.test("occurrence recurrence changes are rejected after reading recurringEventId without writing Google", async () => {
    for (const rule of [{ recurrence }, { rrule: rawRules }, { recurrence: null }]) {
      const before = calls.length
      const denied = await call("PATCH", `${path}/occurrence_one`, { ...times, ...rule, sendUpdates: "none" })
      assert.equal(denied.status, 400, summary(denied))
      assert.deepEqual(calls.slice(before).map((entry) => ({ method: entry.method, path: entry.path })), [{ method: "GET", path: `${providerPath}/occurrence_one` }])
    }
  })

  await t.test("a mismatched Google recurrence receipt is not reported as a successful patch or retried", async () => {
    const before = calls.filter((entry) => entry.method === "PATCH").length
    mismatchReceipt = true
    try {
      const unconfirmed = await call("PATCH", `${path}/${masterId}`, { ...times, rrule: rawRules, sendUpdates: "none" })
      assert.equal(unconfirmed.status, 502, summary(unconfirmed))
      assert.equal(calls.filter((entry) => entry.method === "PATCH").length, before + 1)
    } finally {
      mismatchReceipt = false
    }
  })

  await t.test("disabling recurrence again blocks creates, replacements and clears while ordinary events remain usable", async () => {
    const disabled = await den.setFeature(orgId, "googleCalendarRecurrence", false)
    assert.equal(disabled.status, 200, summary(disabled))
    const before = calls.length
    for (const rule of [{ recurrence }, { rrule: rawRules }]) {
      const denied = await call("POST", path, { ...eventInput, timeZone, ...rule })
      assert.equal(denied.status, 400, summary(denied))
    }
    for (const rule of [{ recurrence }, { rrule: rawRules }, { recurrence: null }]) {
      const denied = await call("PATCH", `${path}/${masterId}`, { ...times, ...rule, sendUpdates: "none" })
      assert.equal(denied.status, 400, summary(denied))
    }
    assert.equal(calls.length, before, "turning recurrence off blocks writes before Google is contacted")
    const created = await call("POST", path, eventInput)
    assert.equal(created.status, 200, summary(created))
    assert.equal(field(created.body, "recurrence"), null)
    assert.deepEqual(calls.at(-1)?.body, { summary: eventInput.summary, start: { dateTime: start }, end: { dateTime: end } })
    const id = text(field(created.body, "eventId"), "ordinary event ID")
    const updated = await call("PATCH", `${path}/${id}`, { summary: "Updated planning meeting", sendUpdates: "none" })
    assert.equal(updated.status, 200, summary(updated))
    assert.equal(field(updated.body, "event", "summary"), "Updated planning meeting")
    assert.deepEqual(calls.at(-1)?.body, { summary: "Updated planning meeting" })
  })
})
