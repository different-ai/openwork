import { createDenTypeId } from "@openwork-ee/utils/typeid"
import { afterAll, beforeAll, beforeEach, expect, mock, test } from "bun:test"
import type { OpenApiOperation } from "../src/mcp/policy.js"

function seedRequiredEnv() {
  process.env.DATABASE_URL = process.env.DATABASE_URL ?? "mysql://root:password@127.0.0.1:3306/openwork_test_gwscaps"
  process.env.DEN_DB_ENCRYPTION_KEY = process.env.DEN_DB_ENCRYPTION_KEY ?? "local-dev-db-encryption-key-please-change-1234567890"
  process.env.BETTER_AUTH_SECRET = process.env.BETTER_AUTH_SECRET ?? "local-dev-secret-not-for-production-use!!"
  process.env.BETTER_AUTH_URL = process.env.BETTER_AUTH_URL ?? "http://127.0.0.1:8790"
  process.env.CORS_ORIGINS = process.env.CORS_ORIGINS ?? "http://127.0.0.1:8790"
}

function base64Url(text: string): string {
  return Buffer.from(text, "utf8").toString("base64url")
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

type TestOpenApiDocument = {
  paths?: Record<string, Record<string, OpenApiOperation>>
}

function isOpenApiDocument(value: unknown): value is TestOpenApiDocument {
  if (!isRecord(value)) return false
  return value.paths === undefined || isRecord(value.paths)
}

function expectMessage(body: unknown): string {
  if (!isRecord(body) || typeof body.message !== "string") {
    throw new Error("Expected response body with a message string")
  }
  return body.message
}

function expectRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error(`Expected ${label} to be an object`)
  }
  return value
}

function expectString(value: unknown, label: string): string {
  if (typeof value !== "string") {
    throw new Error(`Expected ${label} to be a string`)
  }
  return value
}

function readString(record: Record<string, unknown>, key: string): string {
  const value = record[key]
  return typeof value === "string" ? value : ""
}

function expectDraftMessage(): Record<string, unknown> {
  const payload = expectRecord(lastDraftPayload, "Gmail draft payload")
  return expectRecord(payload.message, "Gmail draft message")
}

function decodeDraftRaw(): string {
  const message = expectDraftMessage()
  const raw = expectString(message.raw, "Gmail draft raw")
  return Buffer.from(raw, "base64url").toString("utf8")
}

function decodeDraftTextBody(): string {
  const encoded = decodeDraftRaw().match(/Content-Transfer-Encoding: base64\r\n\r\n([A-Za-z0-9+/=\r\n]+)/)?.[1] ?? ""
  return Buffer.from(encoded.replace(/\r\n/g, ""), "base64").toString("utf8")
}

const GMAIL_READ_SCOPE = "https://www.googleapis.com/auth/gmail.readonly"
const CALENDAR_READ_SCOPE = "https://www.googleapis.com/auth/calendar.readonly"
const CALENDAR_EVENTS_SCOPE = "https://www.googleapis.com/auth/calendar.events"
const DRIVE_FILE_SCOPE = "https://www.googleapis.com/auth/drive.file"
const DRIVE_READ_SCOPE = "https://www.googleapis.com/auth/drive.readonly"
const DRIVE_FULL_SCOPE = "https://www.googleapis.com/auth/drive"
const FULL_SCOPES = [GMAIL_READ_SCOPE, CALENDAR_READ_SCOPE, CALENDAR_EVENTS_SCOPE, DRIVE_READ_SCOPE, DRIVE_FILE_SCOPE]

let lastAuthorization: string | null = null
let googleCallCount = 0
let googleCallUrls: string[] = []
let forceGoogleError = false
let forceGmailThreadError = false
let lastDriveQuery: string | null = null
let lastDriveUploadContentType: string | null = null
let lastDriveUploadBody: Buffer | null = null
let lastDriveSharePayload: unknown = null
let lastDriveShareUrl: string | null = null
let lastCalendarEventPayload: unknown = null
let lastCalendarUrl: string | null = null
let lastCalendarMethod: string | null = null
let calendarCreateCount = 0
let lastDraftPayload: unknown = null
let lastGmailThreadUrl: string | null = null
let forceDriveUploadError = false
let largeDriveContentHitCount = 0

function resetFakeGoogle() {
  lastAuthorization = null
  googleCallCount = 0
  googleCallUrls = []
  forceGoogleError = false
  forceGmailThreadError = false
  lastDriveQuery = null
  lastDriveUploadContentType = null
  lastDriveUploadBody = null
  lastDriveSharePayload = null
  lastDriveShareUrl = null
  lastCalendarEventPayload = null
  lastCalendarUrl = null
  lastCalendarMethod = null
  calendarCreateCount = 0
  lastDraftPayload = null
  lastGmailThreadUrl = null
  forceDriveUploadError = false
  largeDriveContentHitCount = 0
}

// Trailing high bytes force base64url output ("-"/"_") to differ from standard base64 ("+"/"/").
const attachmentBytes = Buffer.concat([Buffer.from("%PDF-1.4 fake attachment", "utf8"), Buffer.from([0xfb, 0xef, 0xbe, 0xff])])
const binaryDriveBytes = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xfb, 0xef, 0xbe, 0xff]), Buffer.from("binary fixture", "utf8")])
const dxfDriveText = "0\nSECTION\n2\nHEADER\n0\nENDSEC\n0\nEOF\n"

function gmailMessagePayload() {
  return {
    id: "msg_1",
    threadId: "thread_1",
    snippet: "Gmail snippet",
    payload: {
      mimeType: "multipart/mixed",
      headers: [
        { name: "From", value: "Ada <ada@example.com>" },
        { name: "To", value: "Ben <ben@example.com>" },
        { name: "Bcc", value: "Investors <investors@example.com>" },
        { name: "Subject", value: "Quarterly plan" },
        { name: "Date", value: "Tue, 07 Jul 2026 10:00:00 +0000" },
      ],
      parts: [
        { mimeType: "text/plain", body: { data: base64Url("Plain Gmail body") } },
        { filename: "plan.pdf", mimeType: "application/pdf", body: { attachmentId: "att_1", size: 123 } },
      ],
    },
  }
}

const fakeGoogleServer = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    const url = new URL(request.url)
    googleCallCount += 1
    googleCallUrls.push(request.url)
    lastAuthorization = request.headers.get("authorization")

    if (url.pathname.startsWith("/calendar/v3/calendars/primary/events")) {
      lastCalendarUrl = request.url
      lastCalendarMethod = request.method
    }

    if (forceGoogleError && url.pathname === "/calendar/v3/calendars/primary/events") {
      return new Response("calendar exploded", { status: 500 })
    }

    if (url.pathname === "/gmail/v1/users/me/messages") {
      return json({ messages: [{ id: "msg_1", threadId: "thread_1" }] })
    }
    if (url.pathname === "/gmail/v1/users/me/messages/msg_1") {
      return json(gmailMessagePayload())
    }
    if (url.pathname === "/gmail/v1/users/me/messages/msg_1/attachments/att_1") {
      return json({ attachmentId: "att_1", size: attachmentBytes.byteLength, data: attachmentBytes.toString("base64url") })
    }
    if (url.pathname === "/gmail/v1/users/me/threads/thread_1") {
      lastGmailThreadUrl = request.url
      if (forceGmailThreadError) {
        return new Response("thread exploded", { status: 500 })
      }
      return json({
        messages: [
          {
            id: "msg_1",
            payload: {
              headers: [
                { name: "Message-ID", value: "<orig-1@mail.gmail.com>" },
                { name: "Subject", value: "Quarterly plan" },
              ],
            },
          },
          {
            id: "msg_2",
            payload: {
              headers: [
                { name: "Message-ID", value: "<orig-2@mail.gmail.com>" },
                { name: "References", value: "<orig-1@mail.gmail.com>" },
                { name: "Subject", value: "Quarterly plan" },
                { name: "From", value: "Ada <ada@example.com>" },
                { name: "Date", value: "Thu, 16 Jul 2026 15:21:00 +0000" },
              ],
              parts: [{ mimeType: "text/plain", body: { data: base64Url("Original line\n> previous quote") } }],
            },
          },
        ],
      })
    }
    if (url.pathname === "/gmail/v1/users/me/drafts" && request.method === "POST") {
      const body: unknown = await request.json()
      lastDraftPayload = body
      return json({ id: "draft_1", message: { id: "draft_msg_1", threadId: "thread_1" } })
    }

    if (url.pathname === "/calendar/v3/calendars/primary/events" && request.method === "GET") {
      return json({
        items: [
          {
            id: "event_1",
            summary: "Planning",
            description: "Discuss launch",
            location: "Room 1",
            start: { dateTime: "2026-07-08T10:00:00Z" },
            end: { dateTime: "2026-07-08T10:30:00Z" },
            status: "confirmed",
            htmlLink: "https://calendar.google.com/event?eid=event_1",
            attendees: [{ email: "ada@example.com" }, { email: "ben@example.com" }],
            hangoutLink: "https://meet.google.com/list-meet",
          },
          {
            id: "event_2",
            summary: "Offsite",
            start: { date: "2026-07-09" },
            end: { date: "2026-07-10" },
          },
        ],
      })
    }
    if (url.pathname === "/calendar/v3/calendars/primary/events" && request.method === "POST") {
      const body: unknown = await request.json()
      lastCalendarEventPayload = body
      calendarCreateCount += 1
      return json({
        id: "created_event_1",
        summary: "Created event",
        start: { dateTime: "2026-07-08T12:00:00Z" },
        end: { dateTime: "2026-07-08T12:30:00Z" },
        htmlLink: "https://calendar.google.com/event?eid=created_event_1",
        hangoutLink: "https://meet.google.com/created-meet",
      })
    }
    if (url.pathname === "/calendar/v3/calendars/primary/events/existing_event_1" && request.method === "PATCH") {
      const body: unknown = await request.json()
      lastCalendarEventPayload = body
      return json({
        id: "existing_event_1",
        summary: "Existing event",
        start: { dateTime: "2026-07-08T14:00:00Z" },
        end: { dateTime: "2026-07-08T14:30:00Z" },
        htmlLink: "https://calendar.google.com/event?eid=existing_event_1",
        conferenceData: {
          entryPoints: [{ entryPointType: "video", uri: "https://meet.google.com/updated-meet" }],
        },
      })
    }

    if (url.pathname === "/drive/v3/files") {
      lastDriveQuery = url.searchParams.get("q")
      return json({
        files: [
          {
            id: "file_1",
            name: "Quarterly Plan.txt",
            mimeType: "text/plain",
            modifiedTime: "2026-07-08T11:00:00Z",
            webViewLink: "https://drive.google.com/file/d/file_1/view",
            size: "42",
          },
        ],
      })
    }
    if (url.pathname === "/upload/drive/v3/files" && request.method === "POST") {
      lastDriveUploadContentType = request.headers.get("content-type")
      lastDriveUploadBody = Buffer.from(await request.arrayBuffer())
      if (forceDriveUploadError) {
        return new Response("upload exploded", { status: 500 })
      }
      return json({
        id: "uploaded_file_1",
        name: "plan.pdf",
        mimeType: "application/pdf",
        modifiedTime: "2026-07-08T12:00:00Z",
        webViewLink: "https://drive.google.com/file/d/uploaded_file_1/view",
        size: "28",
      })
    }
    if (url.pathname === "/drive/v3/files/file_1/permissions" && request.method === "POST") {
      const body: unknown = await request.json()
      lastDriveSharePayload = body
      lastDriveShareUrl = request.url
      const payload = isRecord(body) ? body : {}
      return json({
        id: readString(payload, "type") === "domain" ? "perm_domain_1" : "perm_user_1",
        type: readString(payload, "type"),
        role: readString(payload, "role"),
      })
    }
    if (url.pathname === "/drive/v3/files/file_1" && url.searchParams.get("alt") === "media") {
      return new Response("Drive file text", { headers: { "content-type": "text/plain" } })
    }
    if (url.pathname === "/drive/v3/files/file_1") {
      return json({
        id: "file_1",
        name: "Quarterly Plan.txt",
        mimeType: "text/plain",
        modifiedTime: "2026-07-08T11:00:00Z",
        webViewLink: "https://drive.google.com/file/d/file_1/view",
        size: "42",
      })
    }
    if (url.pathname === "/drive/v3/files/binary_file" && url.searchParams.get("alt") === "media") {
      return new Response(binaryDriveBytes, { headers: { "content-type": "application/octet-stream" } })
    }
    if (url.pathname === "/drive/v3/files/binary_file") {
      return json({
        id: "binary_file",
        name: "fixture.png",
        mimeType: "application/octet-stream",
        modifiedTime: "2026-07-08T11:00:00Z",
        webViewLink: "https://drive.google.com/file/d/binary_file/view",
        size: String(binaryDriveBytes.byteLength),
      })
    }
    if (url.pathname === "/drive/v3/files/dxf_file" && url.searchParams.get("alt") === "media") {
      return new Response(dxfDriveText, { headers: { "content-type": "image/vnd.dxf" } })
    }
    if (url.pathname === "/drive/v3/files/dxf_file") {
      return json({
        id: "dxf_file",
        name: "drawing.dxf",
        mimeType: "image/vnd.dxf",
        modifiedTime: "2026-07-08T11:00:00Z",
        webViewLink: "https://drive.google.com/file/d/dxf_file/view",
        size: String(Buffer.byteLength(dxfDriveText)),
      })
    }
    if (url.pathname === "/drive/v3/files/large_file" && url.searchParams.get("alt") === "media") {
      largeDriveContentHitCount += 1
      return new Response("should not be fetched")
    }
    if (url.pathname === "/drive/v3/files/large_file") {
      return json({
        id: "large_file",
        name: "large.bin",
        mimeType: "application/octet-stream",
        modifiedTime: "2026-07-08T11:00:00Z",
        webViewLink: "https://drive.google.com/file/d/large_file/view",
        size: "20971520",
      })
    }
    if (url.pathname === "/drive/v3/files/doc_1") {
      return json({
        id: "doc_1",
        name: "Project Doc",
        mimeType: "application/vnd.google-apps.document",
        modifiedTime: "2026-07-08T11:00:00Z",
        webViewLink: "https://docs.google.com/document/d/doc_1/edit",
        size: null,
      })
    }
    if (url.pathname === "/drive/v3/files/doc_1/export") {
      return new Response("Exported doc text", { headers: { "content-type": "text/plain" } })
    }

    return new Response(`Unhandled fake Google route: ${url.pathname}`, { status: 404 })
  },
})

seedRequiredEnv()
process.env.DEN_GOOGLE_API_BASE_URL = fakeGoogleServer.url.origin

let app: typeof import("../src/app.js").default
let db: typeof import("../src/db.js").db
let schema: typeof import("@openwork-ee/den-db/schema")
let drizzle: typeof import("@openwork-ee/den-db/drizzle")
let session: typeof import("../src/session.js")
let upsertConnectedAccount: typeof import("../src/capability-sources/oauth-credentials.js").upsertConnectedAccount
let buildMcpCatalog: typeof import("../src/mcp/catalog.js").buildMcpCatalog
let searchCapabilities: typeof import("../src/mcp/search.js").searchCapabilities

const userId = createDenTypeId("user")
const organizationId = createDenTypeId("organization")
const memberId = createDenTypeId("member")
const authSessionId = createDenTypeId("session")
const authSessionToken = `gws-caps-session-${authSessionId}`
let directUploadMcpToken = ""

async function seedConnectedAccount(scopes: string[] | null = FULL_SCOPES) {
  await upsertConnectedAccount({
    organizationId,
    orgMembershipId: memberId,
    providerId: "google-workspace",
    externalAccountId: "google-user-1@example.com",
    scopes,
    accessToken: "gws-token",
    refreshToken: "gws-refresh-token",
    tokenType: "Bearer",
    expiresAt: new Date("2037-01-01T00:00:00Z"),
    pendingCodeVerifier: null,
  })
}

function authHeaders(): Headers {
  return new Headers({
    "x-den-internal-mcp-principal": session.createInternalMcpPrincipalHeader({ userId, organizationId }),
  })
}

function request(path: string, init?: { method?: string; body?: unknown }) {
  const headers = authHeaders()
  const body = init?.body
  if (body !== undefined) {
    headers.set("content-type", "application/json")
  }

  return app.request(`http://den-api.local${path}`, {
    method: init?.method ?? "GET",
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  })
}

function requestForm(path: string, form: FormData) {
  return app.request(`http://den-api.local${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${directUploadMcpToken}` },
    body: form,
  })
}

beforeAll(async () => {
  mock.restore()
  const realDb = (await import("@openwork-ee/den-db")).createDenDb({
    databaseUrl: process.env.DATABASE_URL,
    mode: "mysql",
  }).db
  mock.module("../src/db.js", () => ({ db: realDb }))

  const [appMod, dbMod, schemaMod, drizzleMod, sessionMod, credentialsMod, catalogMod, searchMod] = await Promise.all([
    import("../src/app.js"),
    import("../src/db.js"),
    import("@openwork-ee/den-db/schema"),
    import("@openwork-ee/den-db/drizzle"),
    import("../src/session.js"),
    import("../src/capability-sources/oauth-credentials.js"),
    import("../src/mcp/catalog.js"),
    import("../src/mcp/search.js"),
  ])
  app = appMod.default
  db = dbMod.db
  schema = schemaMod
  drizzle = drizzleMod
  session = sessionMod
  upsertConnectedAccount = credentialsMod.upsertConnectedAccount
  buildMcpCatalog = catalogMod.buildMcpCatalog
  searchCapabilities = searchMod.searchCapabilities

  await db.insert(schema.AuthUserTable).values({
    id: userId,
    name: "Google Workspace Capabilities User",
    email: `gws-caps+${userId}@test.local`,
  })
  await db.insert(schema.OrganizationTable).values({
    id: organizationId,
    name: "Google Workspace Capabilities Org",
    slug: `gws-caps-${organizationId}`,
  })
  await db.insert(schema.MemberTable).values({
    id: memberId,
    organizationId,
    userId,
    role: "member",
  })
  await db.insert(schema.AuthSessionTable).values({
    id: authSessionId,
    userId,
    activeOrganizationId: organizationId,
    token: authSessionToken,
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
  })
  const tokenResponse = await app.request("http://den-api.local/v1/mcp/token", {
    method: "POST",
    headers: {
      authorization: `Bearer ${authSessionToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ scopes: ["mcp:write"] }),
  })
  expect(tokenResponse.status).toBe(200)
  const tokenBody: unknown = await tokenResponse.json()
  directUploadMcpToken = expectString(expectRecord(tokenBody, "MCP token response").token, "MCP upload token")
})

beforeEach(async () => {
  resetFakeGoogle()
  await db.delete(schema.ConnectedAccountTable).where(drizzle.eq(schema.ConnectedAccountTable.organizationId, organizationId))
  await seedConnectedAccount()
})

afterAll(async () => {
  await db.delete(schema.ConnectedAccountTable).where(drizzle.eq(schema.ConnectedAccountTable.organizationId, organizationId))
  await db.delete(schema.OAuthAccessTokenTable).where(drizzle.eq(schema.OAuthAccessTokenTable.referenceId, organizationId))
  await db.delete(schema.AuthSessionTable).where(drizzle.eq(schema.AuthSessionTable.id, authSessionId))
  await db.delete(schema.MemberTable).where(drizzle.eq(schema.MemberTable.organizationId, organizationId))
  await db.delete(schema.OrganizationRoleTable).where(drizzle.eq(schema.OrganizationRoleTable.organizationId, organizationId))
  await db.delete(schema.OrganizationTable).where(drizzle.eq(schema.OrganizationTable.id, organizationId))
  await db.delete(schema.AuthUserTable).where(drizzle.eq(schema.AuthUserTable.id, userId))
  fakeGoogleServer.stop(true)
  mock.restore()
})

test("calendar list returns mapped events and sends the member token", async () => {
  const response = await request("/v1/capabilities/google-workspace/calendar-events?timeMin=2026-07-08T00%3A00%3A00Z&timeMax=2026-07-11T00%3A00%3A00Z")
  expect(response.status).toBe(200)
  expect(lastAuthorization).toBe("Bearer gws-token")
  const body: unknown = await response.json()
  expect(body).toEqual({
    ok: true,
    events: [
      {
        id: "event_1",
        summary: "Planning",
        description: "Discuss launch",
        location: "Room 1",
        start: "2026-07-08T10:00:00Z",
        end: "2026-07-08T10:30:00Z",
        status: "confirmed",
        htmlLink: "https://calendar.google.com/event?eid=event_1",
        attendees: ["ada@example.com", "ben@example.com"],
        meetLink: "https://meet.google.com/list-meet",
      },
      {
        id: "event_2",
        summary: "Offsite",
        description: "",
        location: "",
        start: "2026-07-09",
        end: "2026-07-10",
        status: "",
        htmlLink: "",
        attendees: [],
        meetLink: null,
      },
    ],
  })
})

test("calendar create requests a Google Meet link when asked", async () => {
  const response = await request("/v1/capabilities/google-workspace/calendar-events", {
    method: "POST",
    body: {
      summary: "Planning call",
      start: "2026-07-08T12:00:00Z",
      end: "2026-07-08T12:30:00Z",
      attendees: ["ada@example.com"],
      createMeetLink: true,
    },
  })
  expect(response.status).toBe(200)
  expect(lastCalendarMethod).toBe("POST")
  if (!lastCalendarUrl) {
    throw new Error("Expected calendar create URL to be recorded")
  }
  const url = new URL(lastCalendarUrl)
  expect(url.pathname).toBe("/calendar/v3/calendars/primary/events")
  expect(url.searchParams.get("conferenceDataVersion")).toBe("1")

  const payload = expectRecord(lastCalendarEventPayload, "calendar create payload")
  expect(payload.summary).toBe("Planning call")
  expect(payload.attendees).toEqual([{ email: "ada@example.com" }])
  const conferenceData = expectRecord(payload.conferenceData, "calendar create conferenceData")
  const createRequest = expectRecord(conferenceData.createRequest, "calendar create createRequest")
  const requestId = createRequest.requestId
  if (typeof requestId !== "string") {
    throw new Error("Expected calendar create requestId to be a string")
  }
  expect(requestId.startsWith("openwork-")).toBe(true)
  const solutionKey = expectRecord(createRequest.conferenceSolutionKey, "calendar create conferenceSolutionKey")
  expect(solutionKey.type).toBe("hangoutsMeet")

  const body: unknown = await response.json()
  expect(body).toEqual({
    ok: true,
    eventId: "created_event_1",
    htmlLink: "https://calendar.google.com/event?eid=created_event_1",
    summary: "Created event",
    start: "2026-07-08T12:00:00Z",
    end: "2026-07-08T12:30:00Z",
    meetLink: "https://meet.google.com/created-meet",
  })
})

test("calendar patch adds a Google Meet link without creating a duplicate", async () => {
  const response = await request("/v1/capabilities/google-workspace/calendar-event/existing_event_1", {
    method: "PATCH",
    body: { createMeetLink: true },
  })
  expect(response.status).toBe(200)
  expect(lastCalendarMethod).toBe("PATCH")
  expect(calendarCreateCount).toBe(0)
  if (!lastCalendarUrl) {
    throw new Error("Expected calendar update URL to be recorded")
  }
  const url = new URL(lastCalendarUrl)
  expect(url.pathname).toBe("/calendar/v3/calendars/primary/events/existing_event_1")
  expect(url.searchParams.get("conferenceDataVersion")).toBe("1")

  const payload = expectRecord(lastCalendarEventPayload, "calendar update payload")
  const conferenceData = expectRecord(payload.conferenceData, "calendar update conferenceData")
  const createRequest = expectRecord(conferenceData.createRequest, "calendar update createRequest")
  const requestId = createRequest.requestId
  if (typeof requestId !== "string") {
    throw new Error("Expected calendar update requestId to be a string")
  }
  expect(requestId.startsWith("openwork-")).toBe(true)
  const solutionKey = expectRecord(createRequest.conferenceSolutionKey, "calendar update conferenceSolutionKey")
  expect(solutionKey.type).toBe("hangoutsMeet")

  const body: unknown = await response.json()
  expect(body).toEqual({
    ok: true,
    eventId: "existing_event_1",
    htmlLink: "https://calendar.google.com/event?eid=existing_event_1",
    summary: "Existing event",
    start: "2026-07-08T14:00:00Z",
    end: "2026-07-08T14:30:00Z",
    meetLink: "https://meet.google.com/updated-meet",
  })
})

test("gmail list returns metadata-mapped messages", async () => {
  const response = await request("/v1/capabilities/google-workspace/gmail-messages?q=from%3Aada&maxResults=5")
  expect(response.status).toBe(200)
  expect(lastAuthorization).toBe("Bearer gws-token")
  const body: unknown = await response.json()
  expect(body).toEqual({
    ok: true,
    messages: [
      {
        id: "msg_1",
        threadId: "thread_1",
        from: "Ada <ada@example.com>",
        to: "Ben <ben@example.com>",
        bcc: "Investors <investors@example.com>",
        subject: "Quarterly plan",
        date: "Tue, 07 Jul 2026 10:00:00 +0000",
        snippet: "Gmail snippet",
      },
    ],
  })
})

test("gmail attachment download returns standard base64 bytes and sends the member token", async () => {
  // The fixture must exercise base64url -> base64 normalization, or this test proves nothing.
  expect(attachmentBytes.toString("base64url")).not.toBe(attachmentBytes.toString("base64"))

  const response = await request("/v1/capabilities/google-workspace/gmail-attachment/msg_1/att_1")
  expect(response.status).toBe(200)
  expect(lastAuthorization).toBe("Bearer gws-token")
  const body: unknown = await response.json()
  expect(body).toEqual({
    ok: true,
    messageId: "msg_1",
    attachmentId: "att_1",
    size: attachmentBytes.byteLength,
    dataBase64: attachmentBytes.toString("base64"),
  })
})

test("gmail attachment download requires Gmail read scope before calling Google", async () => {
  await seedConnectedAccount([CALENDAR_READ_SCOPE, CALENDAR_EVENTS_SCOPE, DRIVE_READ_SCOPE])
  resetFakeGoogle()
  const response = await request("/v1/capabilities/google-workspace/gmail-attachment/msg_1/att_1")
  expect(response.status).toBe(409)
  expect(googleCallCount).toBe(0)
  const body: unknown = await response.json()
  expect(expectMessage(body)).toContain("missing the Gmail read permission")
})

test("gmail attachment download returns google_api_error when Google rejects the attachment id", async () => {
  const response = await request("/v1/capabilities/google-workspace/gmail-attachment/msg_1/att_missing")
  expect(response.status).toBe(502)
  const body: unknown = await response.json()
  const responseBody = expectRecord(body, "attachment error response")
  expect(responseBody.error).toBe("google_api_error")
  expect(expectMessage(body).startsWith("Gmail attachment download failed: 404")).toBe(true)
})

test("gmail plain draft supports cc without requiring a thread", async () => {
  const to = "sam@acme.test"
  const subject = "Quarterly plan"
  const response = await request("/v1/capabilities/google-workspace/gmail-drafts", {
    method: "POST",
    body: {
      to,
      cc: "ada@acme.test, grace@acme.test",
      subject,
      body: "Draft body",
    },
  })
  expect(response.status).toBe(200)
  expect(googleCallCount).toBe(1)
  const message = expectDraftMessage()
  expect("threadId" in message).toBe(false)
  const decoded = decodeDraftRaw()
  expect(decoded).toContain("To: sam@acme.test\r\n")
  expect(decoded).toContain("Cc: ada@acme.test, grace@acme.test\r\n")
  expect(decoded).toContain("Subject: Quarterly plan\r\n")
  const body: unknown = await response.json()
  expect(body).toEqual({
    ok: true,
    draftId: "draft_1",
    messageId: "draft_msg_1",
    draftUrl: "https://mail.google.com/mail/u/?authuser=google-user-1%40example.com#drafts?compose=draft_msg_1",
    threadUrl: null,
    to,
    subject,
    threadId: null,
    quotedHistoryIncluded: false,
  })
})

test("direct Gmail upload attaches exact workspace bytes without model-facing base64", async () => {
  const attachmentBytes = Buffer.from("%PDF-1.4\nworkspace invoice\n", "utf8")
  const form = new FormData()
  form.append("payload", JSON.stringify({
    to: "accounts@acme.test",
    subject: "Workspace invoice",
    body: "Please see the attached invoice.",
  }))
  form.append("file", new File([attachmentBytes], "invoice-2026.pdf", { type: "application/pdf" }))
  const response = await requestForm("/v1/direct-uploads/google-workspace/gmail-drafts", form)
  expect(response.status).toBe(200)
  expect(googleCallCount).toBe(1)
  const decoded = decodeDraftRaw()
  expect(decoded).toContain("Content-Type: multipart/mixed;")
  expect(decoded).toContain('Content-Type: application/pdf; name="invoice-2026.pdf"')
  expect(decoded).toContain('Content-Disposition: attachment; filename="invoice-2026.pdf"')
  expect(decoded).toContain(attachmentBytes.toString("base64"))
  const body: unknown = await response.json()
  expect(expectRecord(body, "attachment draft response").attachments).toEqual([{
    filename: "invoice-2026.pdf",
    mimeType: "application/pdf",
    size: attachmentBytes.byteLength,
  }])
})

test("direct Gmail upload keeps threaded reply metadata and attachment bytes", async () => {
  const form = new FormData()
  form.append("payload", JSON.stringify({
    to: "sam@acme.test",
    cc: "ada@acme.test",
    subject: "Quarterly plan",
    threadId: "thread_1",
    body: "Reply body",
  }))
  form.append("file", new File([Buffer.from("workspace notes", "utf8")], "notes.txt", { type: "text/plain" }))
  const response = await requestForm("/v1/direct-uploads/google-workspace/gmail-drafts", form)
  expect(response.status).toBe(200)
  expect(googleCallCount).toBe(2)
  const firstUrl = new URL(expectString(googleCallUrls[0], "first Google URL"))
  expect(firstUrl.pathname).toBe("/gmail/v1/users/me/threads/thread_1")
  expect(firstUrl.searchParams.get("format")).toBe("full")
  expect(firstUrl.searchParams.getAll("metadataHeaders")).toEqual([])
  const secondUrl = new URL(expectString(googleCallUrls[1], "second Google URL"))
  expect(secondUrl.pathname).toBe("/gmail/v1/users/me/drafts")
  expect(lastGmailThreadUrl).toBe(expectString(googleCallUrls[0], "first Google URL"))
  const message = expectDraftMessage()
  expect(message.threadId).toBe("thread_1")
  const decoded = decodeDraftRaw()
  expect(decoded).toContain("In-Reply-To: <orig-2@mail.gmail.com>\r\n")
  expect(decoded).toContain("References: <orig-1@mail.gmail.com> <orig-2@mail.gmail.com>\r\n")
  expect(decodeDraftTextBody()).toBe([
    "Reply body",
    "",
    "On Thu, 16 Jul 2026 at 15:21 UTC, Ada <ada@example.com> wrote:",
    "> Original line",
    "> > previous quote",
  ].join("\n"))
  expect(decoded).toContain('Content-Disposition: attachment; filename="notes.txt"')
  expect(decoded).toContain(Buffer.from("workspace notes", "utf8").toString("base64"))
  const body: unknown = await response.json()
  const responseBody = expectRecord(body, "threaded draft response")
  expect(responseBody.threadId).toBe("thread_1")
  expect(responseBody.draftUrl).toBe("https://mail.google.com/mail/u/?authuser=google-user-1%40example.com#drafts?compose=draft_msg_1")
  expect(responseBody.threadUrl).toBe("https://mail.google.com/mail/u/?authuser=google-user-1%40example.com#all/thread_1")
  expect(responseBody.quotedHistoryIncluded).toBe(true)
})

test("gmail reply-looking draft requires threadId before calling Google", async () => {
  const response = await request("/v1/capabilities/google-workspace/gmail-drafts", {
    method: "POST",
    body: {
      to: "sam@acme.test",
      subject: "Re: Quarterly plan",
      body: "Reply body",
    },
  })
  expect(response.status).toBe(400)
  expect(googleCallCount).toBe(0)
  const body: unknown = await response.json()
  expect(body).toEqual({
    error: "missing_thread_id",
    message: "Subject looks like a reply but threadId is missing. Fetch the thread with the gmail-messages capability and pass threadId so the draft stays on the conversation. Only omit threadId for brand-new emails.",
  })
})

test("Gmail JSON capability rejects legacy inline attachment bytes", async () => {
  const response = await request("/v1/capabilities/google-workspace/gmail-drafts", {
    method: "POST",
    body: {
      to: "sam@acme.test",
      subject: "Quarterly plan",
      body: "Draft body",
      attachments: [{ filename: "file.txt", mimeType: "text/plain", dataBase64: "ZmlsZQ==" }],
    },
  })
  expect(response.status).toBe(400)
  expect(googleCallCount).toBe(0)
})

test("gmail threaded reply draft requires Gmail read scope before calling Google", async () => {
  await seedConnectedAccount([CALENDAR_READ_SCOPE, CALENDAR_EVENTS_SCOPE, DRIVE_READ_SCOPE])
  resetFakeGoogle()
  const response = await request("/v1/capabilities/google-workspace/gmail-drafts", {
    method: "POST",
    body: {
      to: "sam@acme.test",
      subject: "Quarterly plan",
      threadId: "thread_1",
      body: "Reply body",
    },
  })
  expect(response.status).toBe(409)
  expect(googleCallCount).toBe(0)
  const body: unknown = await response.json()
  expect(expectMessage(body)).toContain("missing the Gmail read permission")
})

test("gmail plain draft still works without Gmail read scope", async () => {
  await seedConnectedAccount([CALENDAR_READ_SCOPE, CALENDAR_EVENTS_SCOPE, DRIVE_READ_SCOPE])
  resetFakeGoogle()
  const response = await request("/v1/capabilities/google-workspace/gmail-drafts", {
    method: "POST",
    body: {
      to: "sam@acme.test",
      subject: "Quarterly plan",
      body: "Draft body",
    },
  })
  expect(response.status).toBe(200)
  expect(googleCallCount).toBe(1)
})

test("gmail draft rejects unknown body keys without calling Google", async () => {
  const response = await request("/v1/capabilities/google-workspace/gmail-drafts", {
    method: "POST",
    body: {
      to: "sam@acme.test",
      subject: "Quarterly plan",
      body: "Draft body",
      replyTo: "x@y.z",
    },
  })
  expect(response.status).toBe(400)
  expect(googleCallCount).toBe(0)
  const body: unknown = await response.json()
  expect(expectRecord(body, "invalid request response").error).toBe("invalid_request")
})

test("gmail threaded reply draft returns google_api_error when thread metadata fetch fails", async () => {
  forceGmailThreadError = true
  const response = await request("/v1/capabilities/google-workspace/gmail-drafts", {
    method: "POST",
    body: {
      to: "sam@acme.test",
      subject: "Quarterly plan",
      threadId: "thread_1",
      body: "Reply body",
    },
  })
  expect(response.status).toBe(502)
  expect(googleCallCount).toBe(1)
  const body: unknown = await response.json()
  const responseBody = expectRecord(body, "thread error response")
  expect(responseBody.error).toBe("google_api_error")
  expect(expectMessage(body).startsWith("Gmail thread read failed: 500")).toBe(true)
})

test("drive search returns mapped files", async () => {
  const response = await request("/v1/capabilities/google-workspace/drive-files?query=quarterly&maxResults=3")
  expect(response.status).toBe(200)
  expect(lastAuthorization).toBe("Bearer gws-token")
  expect(lastDriveQuery).toBe("trashed = false and (name contains 'quarterly' or fullText contains 'quarterly')")
  const body: unknown = await response.json()
  expect(body).toEqual({
    ok: true,
    files: [
      {
        id: "file_1",
        name: "Quarterly Plan.txt",
        mimeType: "text/plain",
        modifiedTime: "2026-07-08T11:00:00Z",
        webViewLink: "https://drive.google.com/file/d/file_1/view",
        size: "42",
      },
    ],
  })
})

test("drive file read returns strict UTF-8 text metadata", async () => {
  const response = await request("/v1/capabilities/google-workspace/drive-file/file_1")
  expect(response.status).toBe(200)
  const body: unknown = await response.json()
  const responseBody = expectRecord(body, "drive text response")
  expect(responseBody.ok).toBe(true)
  const file = expectRecord(responseBody.file, "drive text file")
  expect(file.content).toBe("Drive file text")
  expect(file.encoding).toBe("text")
  expect(file.contentBase64).toBeNull()
  expect(file.contentUnavailableReason).toBeNull()
})

test("drive file read preserves binary bytes through standard base64", async () => {
  const response = await request("/v1/capabilities/google-workspace/drive-file/binary_file")
  expect(response.status).toBe(200)
  const body: unknown = await response.json()
  const responseBody = expectRecord(body, "drive binary response")
  expect(responseBody.ok).toBe(true)
  const file = expectRecord(responseBody.file, "drive binary file")
  expect(file.encoding).toBe("base64")
  expect(file.content).toBeNull()
  expect(Buffer.compare(Buffer.from(expectString(file.contentBase64, "drive binary content"), "base64"), binaryDriveBytes)).toBe(0)
})

test("drive file read sniffs text independently of MIME type", async () => {
  const response = await request("/v1/capabilities/google-workspace/drive-file/dxf_file")
  expect(response.status).toBe(200)
  const body: unknown = await response.json()
  const file = expectRecord(expectRecord(body, "drive DXF response").file, "drive DXF file")
  expect(file.encoding).toBe("text")
  expect(file.content).toBe(dxfDriveText)
})

test("drive file read skips content fetch when metadata exceeds the binary limit", async () => {
  const response = await request("/v1/capabilities/google-workspace/drive-file/large_file")
  expect(response.status).toBe(200)
  const body: unknown = await response.json()
  const file = expectRecord(expectRecord(body, "large drive response").file, "large drive file")
  expect(file.contentUnavailableReason).toBe("file_too_large")
  expect(file.encoding).toBe("none")
  expect(file.content).toBeNull()
  expect(file.contentBase64).toBeNull()
  expect(file.truncated).toBe(false)
  expect(largeDriveContentHitCount).toBe(0)
})

test("drive file read keeps the Google Apps text export branch", async () => {
  const response = await request("/v1/capabilities/google-workspace/drive-file/doc_1")
  expect(response.status).toBe(200)
  const body: unknown = await response.json()
  const file = expectRecord(expectRecord(body, "Google Apps response").file, "Google Apps file")
  expect(file.encoding).toBe("text")
  expect(file.content).toBe("Exported doc text")
})

test("direct Drive upload preserves exact multipart bytes and returns the user-facing link", async () => {
  await seedConnectedAccount([DRIVE_FILE_SCOPE])
  resetFakeGoogle()
  const uploadBytes = Buffer.from("%PDF-1.4\nDrive upload bytes\n", "utf8")
  const form = new FormData()
  form.append("file", new File([uploadBytes], "plan.pdf", { type: "application/pdf" }))
  form.append("folderId", "folder_1")
  const response = await requestForm("/v1/direct-uploads/google-workspace/drive-files", form)
  expect(response.status).toBe(200)
  expect(lastAuthorization).toBe("Bearer gws-token")
  const contentType = expectString(lastDriveUploadContentType, "drive upload content type")
  const boundary = contentType.match(/boundary=(.+)$/)?.[1]
  if (!boundary) {
    throw new Error("Expected multipart boundary")
  }
  expect(contentType).toBe(`multipart/related; boundary=${boundary}`)
  if (!lastDriveUploadBody) {
    throw new Error("Expected drive upload body")
  }
  expect(lastDriveUploadBody.includes(Buffer.from(`--${boundary}\r\n`, "utf8"))).toBe(true)
  expect(lastDriveUploadBody.includes(Buffer.from('{"name":"plan.pdf","parents":["folder_1"]}', "utf8"))).toBe(true)
  expect(lastDriveUploadBody.includes(uploadBytes)).toBe(true)
  const body: unknown = await response.json()
  expect(body).toEqual({
    ok: true,
    file: {
      id: "uploaded_file_1",
      name: "plan.pdf",
      mimeType: "application/pdf",
      modifiedTime: "2026-07-08T12:00:00Z",
      webViewLink: "https://drive.google.com/file/d/uploaded_file_1/view",
      size: "28",
    },
  })
})

test("drive upload requires Drive write scope before calling Google", async () => {
  await seedConnectedAccount([DRIVE_READ_SCOPE])
  resetFakeGoogle()
  const form = new FormData()
  form.append("file", new File([Buffer.from("drive bytes", "utf8")], "plan.pdf", { type: "application/pdf" }))
  const response = await requestForm("/v1/direct-uploads/google-workspace/drive-files", form)
  expect(response.status).toBe(409)
  expect(googleCallCount).toBe(0)
  const body: unknown = await response.json()
  expect(expectMessage(body)).toContain("missing the Google Drive write permission")
})

test("drive share grants user access and sends notification by default", async () => {
  await seedConnectedAccount([DRIVE_FILE_SCOPE])
  resetFakeGoogle()
  const response = await request("/v1/capabilities/google-workspace/drive-file-share/file_1", {
    method: "POST",
    body: { type: "user", emailAddress: "raghav@openworklabs.com" },
  })
  expect(response.status).toBe(200)
  expect(lastDriveSharePayload).toEqual({ type: "user", role: "reader", emailAddress: "raghav@openworklabs.com" })
  const url = new URL(expectString(lastDriveShareUrl, "drive share URL"))
  expect(url.pathname).toBe("/drive/v3/files/file_1/permissions")
  expect(url.searchParams.get("sendNotificationEmail")).toBe("true")
  expect(url.searchParams.get("fields")).toBe("id,type,role")
  const body: unknown = await response.json()
  expect(body).toEqual({ ok: true, fileId: "file_1", permissionId: "perm_user_1", type: "user", role: "reader" })
})

test("drive share grants domain access", async () => {
  await seedConnectedAccount([DRIVE_FULL_SCOPE])
  resetFakeGoogle()
  const response = await request("/v1/capabilities/google-workspace/drive-file-share/file_1", {
    method: "POST",
    body: { type: "domain", domain: "openworklabs.com", sendNotificationEmail: false },
  })
  expect(response.status).toBe(200)
  expect(lastDriveSharePayload).toEqual({ type: "domain", role: "reader", domain: "openworklabs.com" })
  const url = new URL(expectString(lastDriveShareUrl, "drive share URL"))
  expect(url.searchParams.get("sendNotificationEmail")).toBe("false")
  const body: unknown = await response.json()
  expect(body).toEqual({ ok: true, fileId: "file_1", permissionId: "perm_domain_1", type: "domain", role: "reader" })
})

test("drive share validates user email before calling Google", async () => {
  const response = await request("/v1/capabilities/google-workspace/drive-file-share/file_1", {
    method: "POST",
    body: { type: "user" },
  })
  expect(response.status).toBe(400)
  expect(googleCallCount).toBe(0)
  const body: unknown = await response.json()
  expect(expectRecord(body, "invalid share response").error).toBe("invalid_request")
})

test("drive upload returns google_api_error when Google rejects the upload", async () => {
  await seedConnectedAccount([DRIVE_FILE_SCOPE])
  resetFakeGoogle()
  forceDriveUploadError = true
  const form = new FormData()
  form.append("file", new File([Buffer.from("drive bytes", "utf8")], "plan.pdf", { type: "application/pdf" }))
  const response = await requestForm("/v1/direct-uploads/google-workspace/drive-files", form)
  expect(response.status).toBe(502)
  expect(googleCallCount).toBe(1)
  const body: unknown = await response.json()
  expect(body).toEqual({
    error: "google_api_error",
    message: "Google Drive file upload failed: 500 upload exploded",
  })
})

test("no connected account returns needs_connection", async () => {
  await db.delete(schema.ConnectedAccountTable).where(drizzle.eq(schema.ConnectedAccountTable.organizationId, organizationId))
  const response = await request("/v1/capabilities/google-workspace/calendar-events?timeMin=2026-07-08T00%3A00%3A00Z&timeMax=2026-07-11T00%3A00%3A00Z")
  expect(response.status).toBe(409)
  expect(googleCallCount).toBe(0)
  const body: unknown = await response.json()
  expect(body).toEqual({
    error: "needs_connection",
    message: "Connect your Google account first: open Settings > Connect and use Connect your account on the Google Workspace row, or connect from the OpenWork Cloud dashboard.",
  })
})

test("missing Gmail read scope returns needs_connection without calling Google", async () => {
  await seedConnectedAccount([CALENDAR_READ_SCOPE, CALENDAR_EVENTS_SCOPE, DRIVE_READ_SCOPE])
  resetFakeGoogle()
  const response = await request("/v1/capabilities/google-workspace/gmail-messages")
  expect(response.status).toBe(409)
  expect(googleCallCount).toBe(0)
  const body: unknown = await response.json()
  expect(expectMessage(body)).toContain("missing the Gmail read permission")
})

test("Google errors become 502 google_api_error", async () => {
  forceGoogleError = true
  const response = await request("/v1/capabilities/google-workspace/calendar-events?timeMin=2026-07-08T00%3A00%3A00Z&timeMax=2026-07-11T00%3A00%3A00Z")
  expect(response.status).toBe(502)
  const body: unknown = await response.json()
  expect(body).toEqual({
    error: "google_api_error",
    message: "Google Calendar events list failed: 500 calendar exploded",
  })
})

test("Google Workspace capability tools are discoverable and keep readable names", async () => {
  const openApiResponse = await app.request("http://den-api.local/openapi.json")
  expect(openApiResponse.status).toBe(200)
  const document: unknown = await openApiResponse.json()
  if (!isOpenApiDocument(document)) {
    throw new Error("openapi.json did not look like an OpenAPI document")
  }

  const catalog = buildMcpCatalog(document)
  const calendarMatch = searchCapabilities(catalog, "calendar events list", 10)[0]
  expect(calendarMatch?.name).toBe("getCapabilitiesGoogleWorkspaceCalendarEvents")
  expect(calendarMatch?.queryParams).toEqual(["timeMin", "timeMax", "maxResults"])
  expect(searchCapabilities(catalog, "add meet link existing event", 10)[0]?.name).toBe("patchCapabilitiesGoogleWorkspaceCalendarEvent")
  const driveMatch = searchCapabilities(catalog, "drive files", 10)[0]
  expect(driveMatch?.name).toBe("getCapabilitiesGoogleWorkspaceDriveFiles")
  expect(driveMatch?.queryParams).toEqual(["query", "maxResults"])
  expect(catalog.some((tool) => tool.name === "postCapabilitiesGoogleWorkspaceDriveFiles")).toBe(false)
  expect(catalog.some((tool) => tool.name.includes("DirectUploads"))).toBe(false)
  expect(searchCapabilities(catalog, "share drive file", 10)[0]?.name).toBe("postCapabilitiesGoogleWorkspaceDriveFileShare")
  const gmailMatch = searchCapabilities(catalog, "gmail search read messages", 10)[0]
  expect(gmailMatch?.name).toBe("getCapabilitiesGoogleWorkspaceGmailMessages")
  expect(gmailMatch?.queryParams).toEqual(["q", "maxResults"])
  expect(searchCapabilities(catalog, "outlook mail messages", 20).find((match) => match.name === "getCapabilitiesMicrosoft365MailMessages")?.queryParams).toEqual(["search", "maxResults"])
  const draftMatch = searchCapabilities(catalog, "gmail draft without attachments", 10)[0]
  expect(draftMatch?.name).toBe("postCapabilitiesGoogleWorkspaceGmailDrafts")
  expect(draftMatch?.summary).toContain("without attachments")
  expect(searchCapabilities(catalog, "download gmail attachment bytes", 10)[0]?.name).toBe("getCapabilitiesGoogleWorkspaceGmailAttachment")

  const expectedNames = [
    "getCapabilitiesGoogleWorkspaceGmailMessages",
    "getCapabilitiesGoogleWorkspaceGmailMessage",
    "getCapabilitiesGoogleWorkspaceGmailAttachment",
    "getCapabilitiesGoogleWorkspaceCalendarEvents",
    "postCapabilitiesGoogleWorkspaceCalendarEvents",
    "patchCapabilitiesGoogleWorkspaceCalendarEvent",
    "getCapabilitiesGoogleWorkspaceDriveFiles",
    "getCapabilitiesGoogleWorkspaceDriveFile",
    "postCapabilitiesGoogleWorkspaceDriveFileShare",
    "postCapabilitiesGoogleWorkspaceGmailDrafts",
  ]
  const catalogNames = new Set(catalog.map((tool) => tool.name))
  for (const name of expectedNames) {
    expect(catalogNames.has(name)).toBe(true)
    expect(name.length).toBeLessThanOrEqual(49)
    expect(name).not.toMatch(/_[a-z0-9]{7}/)
  }
})
