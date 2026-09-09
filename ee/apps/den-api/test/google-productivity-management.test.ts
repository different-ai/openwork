import { afterAll, describe, expect, mock, test } from "bun:test"
import { Hono, type MiddlewareHandler } from "hono"
import { generateSpecs } from "hono-openapi"
import { buildMcpCatalog } from "../src/mcp/catalog.js"
import { createDenTypeId } from "@openwork-ee/utils/typeid"
import type { OrganizationContext } from "../src/orgs.js"
import type { GoogleWorkspaceActionDependencies } from "../src/routes/org/google-workspace-actions.js"
import type { GoogleWorkspaceAccessToken } from "../src/routes/org/google-workspace.js"
import type { OrgRouteVariables } from "../src/routes/org/shared.js"

// Only the session/org lookup is substituted. Hono validation and the real grant/fetch helper run.
const memberGuard: MiddlewareHandler<{ Variables: OrgRouteVariables }> = async (c, next) => {
  if (!c.get("organizationContext")) return c.json({ error: "unauthorized" }, 401)
  await next()
}
mock.module("../src/middleware/route-access.js", () => ({ orgMemberRoute: () => memberGuard }))
mock.module("../src/env.js", () => ({ env: { googleApiBaseUrl: undefined } }))
const { registerGoogleProductivityManagementRoutes } = await import("../src/routes/org/google-productivity-management.js")
afterAll(() => mock.restore())

const base = "/v1/capabilities/google-workspace"
const scope = "https://www.googleapis.com/auth/"
const epoch = new Date("2026-01-01T00:00:00Z")
const organizationId = createDenTypeId("organization")
const memberId = createDenTypeId("member")
const secondMemberId = createDenTypeId("member")
function organizationContext(id = memberId): OrganizationContext {
  return {
    organization: { id: organizationId, name: "Test", slug: "test", logo: null, allowedEmailDomains: null, metadata: null, createdAt: epoch, updatedAt: epoch },
    currentMember: { id, userId: createDenTypeId("user"), role: "member", directRole: "member", adminTeams: [], createdAt: epoch, joinedAt: epoch, isOwner: false },
    members: [], invitations: [], roles: [], teams: [],
  }
}
type WitnessCall = { url: URL; method: string; headers: Headers; body: unknown }
function harness(options: {
  scopes?: string[] | null
  enabledScopes?: string[]
  member?: typeof memberId
  signedIn?: boolean
  tokenFailure?: "needs_connection" | "google_api_error"
  respond?: (call: WitnessCall) => Response | Promise<Response>
} = {}) {
  const calls: WitnessCall[] = []
  const tokenCalls: Parameters<GoogleWorkspaceActionDependencies["token"]>[0][] = []
  const app = new Hono<{ Variables: OrgRouteVariables }>()
  app.use("*", async (c, next) => {
    if (options.signedIn !== false) c.set("organizationContext", organizationContext(options.member))
    await next()
  })
  registerGoogleProductivityManagementRoutes(app, {
    token: async (input) => {
      tokenCalls.push(input)
      if (options.tokenFailure) return { kind: options.tokenFailure, message: "Synthetic token lookup failure" }
      const token: GoogleWorkspaceAccessToken = {
        kind: "ok", accessToken: `synthetic-${input.orgMembershipId}`,
        enabledScopes: options.enabledScopes ?? ["calendar.events", "calendar.readonly", "spreadsheets", "spreadsheets.readonly", "drive.file", "drive", "drive.readonly"].map((name) => scope + name),
        account: {
          id: createDenTypeId("connectedAccount"), organizationId: input.organizationId, orgMembershipId: input.orgMembershipId,
          providerId: "google-workspace", scopes: options.scopes === undefined ? [scope + "calendar.events", scope + "spreadsheets", scope + "drive.file"] : options.scopes,
          externalAccountId: "member@example.com", accessToken: null, refreshToken: null, tokenType: "Bearer", expiresAt: null,
          pendingCodeVerifier: null, credentialHealth: null, connectedAt: epoch, updatedAt: epoch,
        },
      }
      // Exercise absent runtime metadata while keeping it required for typed token resolvers.
      if ("enabledScopes" in options && options.enabledScopes === undefined) Reflect.deleteProperty(token, "enabledScopes")
      return token
    },
    fetch: async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : input.toString())
      const call = { url, method: init?.method ?? "GET", headers: new Headers(init?.headers), body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined }
      calls.push(call)
      if (options.respond) return options.respond(call)
      return Response.json({})
    },
  })
  const request = (path: string, method = "GET", body?: unknown) => app.request(base + path, {
    method, ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
  })
  return { app, calls, tokenCalls, request }
}
const event = { id: "event_1", status: "confirmed", summary: "Planning", start: { dateTime: "2026-09-10T10:00:00Z" }, end: { dateTime: "2026-09-10T11:00:00Z" }, attendees: [{ email: "guest@example.com" }] }
const spreadsheet = { spreadsheetId: "sheet_1", spreadsheetUrl: "https://docs.google.com/spreadsheets/d/sheet_1/edit", properties: { title: "Plan" }, sheets: [{ properties: { sheetId: 0, title: "Sheet1", index: 0, gridProperties: { rowCount: 1000, columnCount: 26 } } }] }
const update = { spreadsheetId: "sheet_1", updatedRange: "Sheet1!A1:C1", updatedRows: 1, updatedColumns: 3, updatedCells: 3 }
const file = { id: "file_1", name: "Folder", mimeType: "application/vnd.google-apps.folder", trashed: false, parents: ["parent_1"] }
const writes = [
  { path: "/calendar-events/event_1", method: "PATCH", body: { summary: "Planning" } },
  { path: "/calendar-events/event_1?confirmCancellation=true", method: "DELETE" },
  { path: "/spreadsheets", method: "POST", body: { title: "Plan" } },
  { path: "/spreadsheets/sheet_1/values", method: "PUT", body: { range: "A1:C1", values: [["=1+1", 2, true]] } },
  { path: "/spreadsheets/sheet_1/values/append", method: "POST", body: { range: "A1:C10", values: [["=1+1", 2, true]] } },
  { path: "/drive-folders", method: "POST", body: { name: "Folder" } },
  { path: "/drive-files/file_1", method: "PATCH", body: { name: "Renamed" } },
]

describe("Calendar event management", () => {
  test("reads a selected calendar event with the calling member's credential", async () => {
    const h = harness({ scopes: [scope + "calendar.readonly"], member: secondMemberId, respond: () => Response.json(event) })
    const response = await h.request("/calendar-events/event_1?calendarId=team%40group.calendar.google.com")
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ ok: true, calendarId: "team@group.calendar.google.com", event })
    expect(h.calls).toHaveLength(1)
    expect(h.calls[0].url.pathname).toBe("/calendar/v3/calendars/team%40group.calendar.google.com/events/event_1")
    expect(h.calls[0].method).toBe("GET")
    expect(h.calls[0].body).toBeUndefined()
    expect(h.calls[0].headers.get("authorization")).toBe(`Bearer synthetic-${secondMemberId}`)
    expect(h.tokenCalls).toEqual([{ organizationId, orgMembershipId: secondMemberId }])
    expect(h.calls[0].headers.get("authorization")).not.toBe(`Bearer synthetic-${memberId}`)
  })
  test("reschedules using PATCH, preserving offset/time zone and only supplied fields", async () => {
    const patch = { start: { dateTime: "2026-09-11T10:00:00+02:00", timeZone: "Europe/Paris" }, end: { dateTime: "2026-09-11T12:00:00+02:00", timeZone: "Europe/Paris" }, location: "Room 2" }
    const h = harness({ respond: () => Response.json({ ...event, ...patch }) })
    expect((await h.request("/calendar-events/event_1", "PATCH", patch)).status).toBe(200)
    expect(h.calls[0].method).toBe("PATCH")
    expect(h.calls[0].url.pathname).toContain("/calendars/primary/events/event_1")
    expect(h.calls[0].url.searchParams.get("sendUpdates")).toBe("none")
    expect(h.calls[0].body).toEqual(patch)
    expect(h.calls[0].headers.get("content-type")).toBe("application/json")
  })
  test("supports all-day dates, empty descriptions, attendee replacement and confirmed notifications", async () => {
    const patch = { start: { date: "2026-09-11" }, end: { date: "2026-09-12" }, description: "", attendees: [] }
    const h = harness({ respond: () => Response.json({ ...event, ...patch }) })
    expect((await h.request("/calendar-events/event_1?calendarId=selected", "PATCH", { ...patch, sendUpdates: "all", confirmNotifications: true })).status).toBe(200)
    expect(h.calls[0].body).toEqual(patch)
    expect(h.calls[0].url.searchParams.get("sendUpdates")).toBe("all")
  })
  test("reads all-day time zones and accepts omitted empty optional event fields after clearing", async () => {
    const data = { id: event.id, status: "confirmed", start: { date: "2026-09-11", timeZone: "Europe/Paris" }, end: { date: "2026-09-12", timeZone: "Europe/Paris" } }
    const h = harness({ respond: () => Response.json(data) })
    const read = await h.request("/calendar-events/event_1")
    expect(read.status).toBe(200)
    expect((await read.json()).event).toEqual(data)
    expect((await h.request("/calendar-events/event_1", "PATCH", { description: "", location: "", attendees: [] })).status).toBe(200)
  })
  test.each([
    {}, { summary: "Title", sendUpdates: "all" }, { summary: "Title", sendUpdates: "invalid" },
    { start: event.start }, { start: event.start, end: { date: "2026-09-12" } },
    { start: event.end, end: event.start }, { start: { date: "2026-09-11" }, end: { date: "2026-09-11" } },
    { start: { date: "2026-02-30" }, end: { date: "2026-03-02" } },
    { start: { dateTime: "2026-09-11T10:00:00Z", timeZone: "Invalid/Zone" }, end: event.end },
    { summary: "Title", attendees: Array.from({ length: 101 }, () => ({ email: "guest@example.com" })) },
    { summary: "Title", status: "cancelled" },
  ])("rejects invalid/unsafe event patches before credentials or fetch: %j", async (body) => {
    const h = harness()
    expect((await h.request("/calendar-events/event_1", "PATCH", body)).status).toBe(400)
    expect(h.calls).toHaveLength(0)
    expect(h.tokenCalls).toHaveLength(0)
  })
  test("cancellation requires confirmation and accepts only Google 204, with no provider request body", async () => {
    const h = harness({ respond: () => new Response(null, { status: 204 }) })
    expect((await h.request("/calendar-events/event_1", "DELETE")).status).toBe(400)
    expect((await h.request("/calendar-events/event_1?confirmCancellation=true&sendUpdates=all", "DELETE")).status).toBe(400)
    expect(h.calls).toHaveLength(0)
    const response = await h.request("/calendar-events/event_1?calendarId=selected&confirmCancellation=true&sendUpdates=externalOnly&confirmNotifications=true", "DELETE")
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ ok: true, calendarId: "selected", eventId: "event_1", cancelled: true, sendUpdates: "externalOnly" })
    expect(h.calls[0].method).toBe("DELETE")
    expect(h.calls[0].body).toBeUndefined()
    expect(h.calls[0].url.search).toBe("?sendUpdates=externalOnly")
  })
})

describe("Sheets v4 metadata and cell operations", () => {
  test("metadata excludes grid data and uses the real Sheets endpoint", async () => {
    const h = harness({ scopes: [scope + "spreadsheets.readonly"], respond: () => Response.json(spreadsheet) })
    const response = await h.request("/spreadsheets/sheet_1")
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ ok: true, spreadsheet })
    expect(h.calls[0].url.origin).toBe("https://sheets.googleapis.com")
    expect(h.calls[0].url.pathname).toBe("/v4/spreadsheets/sheet_1")
    expect(h.calls[0].url.searchParams.get("includeGridData")).toBe("false")
    expect(h.calls[0].url.searchParams.get("fields")).toContain("gridProperties(rowCount,columnCount)")
  })
  test("creates a spreadsheet resource, not a Drive text-file copy", async () => {
    const h = harness({ respond: () => Response.json(spreadsheet) })
    expect((await h.request("/spreadsheets", "POST", { title: "Plan" })).status).toBe(200)
    expect(h.calls[0].method).toBe("POST")
    expect(h.calls[0].url.origin + h.calls[0].url.pathname).toBe("https://sheets.googleapis.com/v4/spreadsheets")
    expect(h.calls[0].body).toEqual({ properties: { title: "Plan" }, sheets: [{ properties: { title: "Sheet1", gridProperties: { rowCount: 1000, columnCount: 26 } } }] })
  })
  test("reads bounded quoted A1 ranges and normalizes Google's empty-cell response", async () => {
    const range = "'Team''s Plan'!$A$1:$C$2"
    const h = harness({ scopes: [scope + "drive.readonly"], respond: () => Response.json({ range, majorDimension: "ROWS" }) })
    const response = await h.request(`/spreadsheets/sheet_1/values?range=${encodeURIComponent(range)}&valueRenderOption=FORMULA`)
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ ok: true, spreadsheetId: "sheet_1", range, majorDimension: "ROWS", values: [], valueRenderOption: "FORMULA" })
    expect(decodeURIComponent(h.calls[0].url.pathname)).toBe(`/v4/spreadsheets/sheet_1/values/${range}`)
    expect(h.calls[0].url.searchParams.get("majorDimension")).toBe("ROWS")
    expect(h.calls[0].url.searchParams.get("valueRenderOption")).toBe("FORMULA")
  })
  test("accepts an empty values response without optional values or majorDimension", async () => {
    const h = harness({ respond: () => Response.json({ range: "Sheet1!A1" }) })
    const response = await h.request("/spreadsheets/sheet_1/values?range=A1")
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ range: "Sheet1!A1", majorDimension: "ROWS", values: [] })
  })
  test("reads non-grid sheets and partial grid properties without requiring absent dimensions", async () => {
    for (const properties of [{ sheetId: 0, title: "Chart" }, { sheetId: 0, title: "Data", gridProperties: { rowCount: 10 } }]) {
      const data = { ...spreadsheet, sheets: [{ properties }] }
      const h = harness({ respond: () => Response.json(data) })
      const response = await h.request("/spreadsheets/sheet_1")
      expect(response.status).toBe(200)
      expect((await response.json()).spreadsheet).toEqual(data)
    }
  })
  test("returns real cell values and rejects a provider response larger than the requested rectangle", async () => {
    const h = harness({ respond: () => Response.json({ range: "Sheet1!A1:C2", majorDimension: "ROWS", values: [["Plan", 3, true], ["", 4, false]] }) })
    const response = await h.request("/spreadsheets/sheet_1/values?range=Sheet1!A1:C2&valueRenderOption=UNFORMATTED_VALUE")
    expect(response.status).toBe(200)
    expect((await response.json()).values).toEqual([["Plan", 3, true], ["", 4, false]])
    expect((await h.request("/spreadsheets/sheet_1/values?range=A1")).status).toBe(502)
  })
  test("accepts the maximum bounded rectangle but rejects arbitrary create properties", async () => {
    const h = harness({ respond: () => Response.json({ range: "Sheet1!A1:J500", majorDimension: "ROWS" }) })
    expect((await h.request("/spreadsheets/sheet_1/values?range=A1:J500")).status).toBe(200)
    expect((await h.request("/spreadsheets", "POST", { title: "Plan", rowCount: 10_001 })).status).toBe(400)
    expect((await h.request("/spreadsheets", "POST", { title: "Plan", sheets: [{ data: "unexpected grid data" }] })).status).toBe(400)
    expect(h.calls).toHaveLength(1)
  })
  test.each(["A:A", "1:5", "Sheet1", "NamedRange", "A1:A501", "A1:DW1", "A1:Z500", "B2:A1", "A0", "A1000001", "https://example.com", "A1?key=bad", "Sheet1!A1:B2!C3"])("rejects unbounded or invalid range %s before fetch", async (range) => {
    const h = harness()
    expect((await h.request(`/spreadsheets/sheet_1/values?range=${encodeURIComponent(range)}`)).status).toBe(400)
    expect((await h.request("/spreadsheets/sheet_1/values", "PUT", { range, values: [[1]] })).status).toBe(400)
    expect(h.calls).toHaveLength(0)
  })
  test("writes literal formula-looking strings using PUT with RAW by default", async () => {
    const h = harness({ respond: () => Response.json(update) })
    const input = { range: "Sheet1!A1:C1", values: [["=IMPORTXML(\"https://example.com\",\"//x\")", 2, true]] }
    const response = await h.request("/spreadsheets/sheet_1/values", "PUT", input)
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ ok: true, ...update, valueInputOption: "RAW" })
    expect(h.calls[0].method).toBe("PUT")
    expect(h.calls[0].url.searchParams.get("valueInputOption")).toBe("RAW")
    expect(h.calls[0].body).toEqual({ ...input, majorDimension: "ROWS" })
  })
  test("USER_ENTERED is explicit and confirmed, never inferred from string contents", async () => {
    const h = harness({ respond: () => Response.json(update) })
    const body = { range: "A1:C1", values: [["=1+1", 2, true]], valueInputOption: "USER_ENTERED" }
    expect((await h.request("/spreadsheets/sheet_1/values", "PUT", body)).status).toBe(400)
    expect(h.calls).toHaveLength(0)
    expect((await h.request("/spreadsheets/sheet_1/values", "PUT", { ...body, confirmUserEntered: true })).status).toBe(200)
    expect(h.calls[0].url.searchParams.get("valueInputOption")).toBe("USER_ENTERED")
    expect(h.calls[0].body).toEqual({ range: body.range, values: body.values, majorDimension: "ROWS" })
  })
  test("append inserts rows after the detected table and returns Google's actual written range", async () => {
    const updates = { ...update, updatedRange: "Sheet1!A11:C11" }
    const h = harness({ respond: () => Response.json({ spreadsheetId: "sheet_1", tableRange: "Sheet1!A1:C10", updates }) })
    const response = await h.request("/spreadsheets/sheet_1/values/append", "POST", { range: "A1:C10", values: [["x", 2, true]] })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ ok: true, ...updates, tableRange: "Sheet1!A1:C10", valueInputOption: "RAW" })
    expect(h.calls[0].url.pathname).toEndWith("/values/A1%3AC10:append")
    expect(h.calls[0].method).toBe("POST")
    expect(h.calls[0].body).toEqual({ range: "A1:C10", majorDimension: "ROWS", values: [["x", 2, true]] })
    expect(h.calls[0].url.searchParams.get("insertDataOption")).toBe("INSERT_ROWS")
    expect(h.calls[0].url.searchParams.get("valueInputOption")).toBe("RAW")
  })
  test("append permits an empty or omitted preexisting table range while still requiring write counts", async () => {
    for (const table of [{}, { tableRange: "" }]) {
      const h = harness({ respond: () => Response.json({ spreadsheetId: "sheet_1", ...table, updates: update }) })
      const response = await h.request("/spreadsheets/sheet_1/values/append", "POST", { range: "A1:C10", values: [["x", 2, true]] })
      expect(response.status).toBe(200)
      expect(await response.json()).toMatchObject({ ...update, tableRange: "", ok: true })
    }
  })
  test.each([
    { range: "A1", values: [[1, 2]] }, { range: "A1", values: [[1], [2]] },
    { range: "A1", values: [] }, { range: "A1", values: [[null]] }, { range: "A1", values: [[{ formula: "1+1" }]] },
    { range: "A1", values: [["x".repeat(50_001)]] },
    { range: "A1:J500", values: Array.from({ length: 501 }, () => [1]) },
    { range: "A1", values: [[1]], valueInputOption: "AUTOMATIC" },
  ])("rejects invalid, oversized, or misaligned cells", async (body) => {
    const h = harness()
    expect((await h.request("/spreadsheets/sheet_1/values", "PUT", body)).status).toBe(400)
    expect(h.calls).toHaveLength(0)
  })
  test("limits total JSON bytes before parsing or provider access", async () => {
    const h = harness()
    expect((await h.request("/spreadsheets/sheet_1/values", "PUT", { range: "A1:Z1", values: [Array.from({ length: 26 }, () => "x".repeat(50_000))] })).status).toBe(413)
    expect(h.calls).toHaveLength(0)
    expect(h.tokenCalls).toHaveLength(0)
  })
})

describe("Drive metadata mutations", () => {
  test("reads current parents with a read-only credential for a subsequent explicit move", async () => {
    const h = harness({ scopes: [scope + "drive.readonly"], respond: () => Response.json(file) })
    const response = await h.request("/drive-files/file_1")
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ ok: true, file })
    expect(h.calls[0].method).toBe("GET")
    expect(h.calls[0].body).toBeUndefined()
    expect(h.calls[0].url.searchParams.get("fields")).toContain("parents")
    expect((await h.request("/drive-files/file_1", "PATCH", { addParentId: "parent_2", removeParentId: "parent_1" })).status).toBe(409)
    expect(h.calls).toHaveLength(1)
  })
  test("creates a folder with files.create and selected parent", async () => {
    const h = harness({ respond: () => Response.json(file) })
    expect((await h.request("/drive-folders", "POST", { name: "Folder", parentId: "parent_1" })).status).toBe(200)
    expect(h.calls[0].url.origin + h.calls[0].url.pathname).toBe("https://www.googleapis.com/drive/v3/files")
    expect(h.calls[0].method).toBe("POST")
    expect(h.calls[0].body).toEqual({ name: "Folder", mimeType: "application/vnd.google-apps.folder", parents: ["parent_1"] })
    expect(h.calls[0].url.searchParams.get("supportsAllDrives")).toBe("true")
  })
  test("renames and moves using files.update with parent changes in query, not body", async () => {
    const h = harness({ respond: () => Response.json({ ...file, name: "Moved", parents: ["parent_2"] }) })
    const response = await h.request("/drive-files/file_1", "PATCH", { name: "Moved", addParentId: "parent_2", removeParentId: "parent_1" })
    expect(response.status).toBe(200)
    expect(h.calls[0].method).toBe("PATCH")
    expect(h.calls[0].url.pathname).toBe("/drive/v3/files/file_1")
    expect(h.calls[0].body).toEqual({ name: "Moved" })
    expect(h.calls[0].url.searchParams.get("addParents")).toBe("parent_2")
    expect(h.calls[0].url.searchParams.get("removeParents")).toBe("parent_1")
  })
  test("trashing is explicitly confirmed; restore also uses PATCH, never DELETE", async () => {
    const h = harness({ respond: (call) => Response.json({ ...file, ...(typeof call.body === "object" && call.body !== null ? call.body : {}) }) })
    expect((await h.request("/drive-files/file_1", "PATCH", { trashed: true })).status).toBe(400)
    expect((await h.request("/drive-files/file_1", "PATCH", { trashed: true, confirmTrash: true })).status).toBe(200)
    expect((await h.request("/drive-files/file_1", "PATCH", { trashed: false })).status).toBe(200)
    expect(h.calls.map((call) => call.method)).toEqual(["PATCH", "PATCH"])
    expect(h.calls.map((call) => call.body)).toEqual([{ trashed: true }, { trashed: false }])
    expect((await h.request("/drive-files/file_1", "DELETE")).status).toBe(404)
  })
  test.each([{}, { addParentId: "parent_1" }, { addParentId: "parent_1", removeParentId: "parent_1" }, { addParentId: "file_1", removeParentId: "parent_1" }, { name: "x", parents: ["parent_1"] }])("rejects unsafe or empty metadata patches %j", async (body) => {
    const h = harness()
    expect((await h.request("/drive-files/file_1", "PATCH", body)).status).toBe(400)
    expect(h.calls).toHaveLength(0)
  })
})

describe("Provider grants and honest receipts", () => {
  test.each(writes)("disabled or unknown connector permissions block stale write grants for $path", async ({ path, method, body }) => {
    for (const enabledScopes of [undefined, [], [scope + "calendar.readonly", scope + "drive.readonly", scope + "spreadsheets.readonly"]]) {
      const h = harness({ enabledScopes })
      const response = await h.request(path, method, body)
      expect(response.status).toBe(409)
      expect(await response.json()).toMatchObject({ error: "needs_connection" })
      expect(h.calls).toHaveLength(0)
    }
  })
  test.each(writes)("read-only grants cannot mutate $path", async ({ path, method, body }) => {
    for (const scopes of [[scope + "calendar.readonly", scope + "drive.readonly", scope + "spreadsheets.readonly"], [], null]) {
      const h = harness({ scopes })
      expect((await h.request(path, method, body)).status).toBe(409)
      expect(h.calls).toHaveLength(0)
    }
  })
  test.each(["drive.file", "drive", "spreadsheets"])("Sheets accepts official write grant %s", async (grant) => {
    const h = harness({ scopes: [scope + grant], respond: () => Response.json(spreadsheet) })
    expect((await h.request("/spreadsheets", "POST", { title: "Plan" })).status).toBe(200)
  })
  test("spreadsheets permission cannot mutate Drive metadata", async () => {
    const h = harness({ scopes: [scope + "spreadsheets"] })
    expect((await h.request("/drive-folders", "POST", { name: "Folder" })).status).toBe(409)
    expect(h.calls).toHaveLength(0)
  })
  test("unauthenticated requests and failed token lookup never fetch Google", async () => {
    const h = harness({ signedIn: false })
    expect((await h.request("/spreadsheets/sheet_1")).status).toBe(401)
    expect(h.tokenCalls).toHaveLength(0)
    for (const tokenFailure of ["needs_connection", "google_api_error"] as const) {
      const failed = harness({ tokenFailure })
      expect((await failed.request("/spreadsheets/sheet_1")).status).toBe(tokenFailure === "needs_connection" ? 409 : 502)
      expect(failed.calls).toHaveLength(0)
    }
  })
  test.each(writes)("uncertain $method $path is never retried or reported successful", async ({ path, method, body }) => {
    for (const respond of [
      () => { throw new Error("synthetic transport loss after dispatch") },
      () => new Response("not JSON", { status: 200 }),
      () => Response.json({}, { status: 200 }),
      () => Response.json({ error: "synthetic" }, { status: 503 }),
      () => Response.json({}, { status: 202 }),
    ]) {
      const h = harness({ respond })
      const response = await h.request(path, method, body)
      expect(response.status).toBe(502)
      const receipt = await response.json()
      expect(receipt.ok).toBeUndefined()
      expect(receipt.message).toMatch(/check.*before retrying|check whether.*before retrying/i)
      expect(h.calls).toHaveLength(1)
    }
  })
  test.each([401, 403, 404, 429])("provider HTTP %s remains a failure and is not retried", async (status) => {
    const h = harness({ respond: () => Response.json({ error: "do not leak provider details" }, { status }) })
    const response = await h.request("/drive-folders", "POST", { name: "Folder" })
    expect(response.status).toBe(status === 401 || status === 403 ? 409 : 502)
    expect(await response.text()).not.toContain("do not leak provider details")
    expect(h.calls).toHaveLength(1)
  })
  test("read failure does not return success-shaped empty data", async () => {
    const h = harness({ respond: () => Response.json({}) })
    for (const path of ["/calendar-events/event_1", "/spreadsheets/sheet_1", "/spreadsheets/sheet_1/values?range=A1", "/drive-files/file_1"]) expect((await h.request(path)).status).toBe(502)
  })
  test("provider JSON is bounded before parsing, even for otherwise ignored fields", async () => {
    const h = harness({ respond: () => Response.json({ ...spreadsheet, ignored: "x".repeat(6 * 1024 * 1024) }) })
    expect((await h.request("/spreadsheets/sheet_1")).status).toBe(502)
    expect(h.calls).toHaveLength(1)
  })
  test("mismatched IDs, unapplied metadata, and zero-cell receipts are not confirmations", async () => {
    for (const [payload, path, method, body] of [
      [{ ...event, id: "different_event" }, "/calendar-events/event_1", "PATCH", { summary: "Planning" }],
      [{ id: "event_1", status: "confirmed" }, "/calendar-events/event_1", "PATCH", { summary: "Planning" }],
      [event, "/calendar-events/event_1", "PATCH", { start: { date: "2026-09-12" }, end: { date: "2026-09-13" } }],
      [event, "/calendar-events/event_1", "PATCH", { attendees: [{ email: "different@example.com" }] }],
      [file, "/drive-files/file_1", "PATCH", { trashed: true, confirmTrash: true }],
      [file, "/drive-files/file_1", "PATCH", { addParentId: "parent_2", removeParentId: "parent_1" }],
      [file, "/drive-folders", "POST", { name: "Folder", parentId: "different_parent" }],
      [{ ...update, updatedCells: 0 }, "/spreadsheets/sheet_1/values", "PUT", { range: "A1:C1", values: [[1, 2, 3]] }],
      [{ ...update, updatedCells: 2 }, "/spreadsheets/sheet_1/values", "PUT", { range: "A1:C1", values: [[1, 2, 3]] }],
      [{ ...spreadsheet, spreadsheetId: "different_sheet" }, "/spreadsheets/sheet_1", "GET", undefined],
    ] as const) {
      const h = harness({ respond: () => Response.json(payload) })
      expect((await h.request(path, method, body)).status).toBe(502)
    }
  })
  test("rejects arbitrary URL, query, and payload extensions instead of proxying them", async () => {
    const h = harness()
    expect((await h.request("/spreadsheets/sheet_1?includeGridData=true")).status).toBe(400)
    expect((await h.request("/spreadsheets/sheet_1/values?range=A1&url=https://example.com")).status).toBe(400)
    expect((await h.request("/drive-folders", "POST", { name: "x", url: "https://example.com" })).status).toBe(400)
    expect((await h.request("/calendar-events/event_1?calendarId=selected&sendUpdates=all", "PATCH", { summary: "x" })).status).toBe(400)
    expect(h.calls).toHaveLength(0)
  })
  test("emits explicit OpenAPI request and receipt schemas for parent discovery", async () => {
    const h = harness()
    const spec = await generateSpecs(h.app)
    expect(buildMcpCatalog(spec).map((operation) => operation.name).sort()).toEqual([
      "getGoogleCalendarEvent", "updateGoogleCalendarEvent", "deleteGoogleCalendarEvent", "getGoogleSpreadsheet",
      "createGoogleSpreadsheet", "getGoogleSheetsValues", "updateGoogleSheetsValues", "appendGoogleSheetsValues",
      "createGoogleDriveFolder", "getGoogleDriveFileMetadata", "updateGoogleDriveFileMetadata",
    ].sort())
    expect(spec.paths?.[base + "/calendar-events/{eventId}"]?.patch?.responses?.["200"]).toBeDefined()
    expect(spec.paths?.[base + "/spreadsheets/{spreadsheetId}/values"]?.put?.requestBody).toBeDefined()
    expect(spec.paths?.[base + "/spreadsheets/{spreadsheetId}/values/append"]?.post?.responses?.["200"]).toBeDefined()
    expect(spec.paths?.[base + "/drive-files/{fileId}"]?.delete).toBeUndefined()
  })
})
