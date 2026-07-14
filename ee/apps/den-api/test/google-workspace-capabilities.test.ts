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

function expectDraftMessage(): Record<string, unknown> {
  const payload = expectRecord(lastDraftPayload, "Gmail draft payload")
  return expectRecord(payload.message, "Gmail draft message")
}

function decodeDraftRaw(): string {
  const message = expectDraftMessage()
  const raw = expectString(message.raw, "Gmail draft raw")
  return Buffer.from(raw, "base64url").toString("utf8")
}

const GMAIL_READ_SCOPE = "https://www.googleapis.com/auth/gmail.readonly"
const CALENDAR_READ_SCOPE = "https://www.googleapis.com/auth/calendar.readonly"
const CALENDAR_EVENTS_SCOPE = "https://www.googleapis.com/auth/calendar.events"
const DRIVE_READ_SCOPE = "https://www.googleapis.com/auth/drive.readonly"
const FULL_SCOPES = [GMAIL_READ_SCOPE, CALENDAR_READ_SCOPE, CALENDAR_EVENTS_SCOPE, DRIVE_READ_SCOPE]

let lastAuthorization: string | null = null
let googleCallCount = 0
let googleCallUrls: string[] = []
let forceGoogleError = false
let forceGmailThreadError = false
let lastDriveQuery: string | null = null
let lastCalendarEventPayload: unknown = null
let lastCalendarUrl: string | null = null
let lastCalendarMethod: string | null = null
let calendarCreateCount = 0
let lastDraftPayload: unknown = null
let lastGmailThreadUrl: string | null = null

function resetFakeGoogle() {
  lastAuthorization = null
  googleCallCount = 0
  googleCallUrls = []
  forceGoogleError = false
  forceGmailThreadError = false
  lastDriveQuery = null
  lastCalendarEventPayload = null
  lastCalendarUrl = null
  lastCalendarMethod = null
  calendarCreateCount = 0
  lastDraftPayload = null
  lastGmailThreadUrl = null
}

// Trailing high bytes force base64url output ("-"/"_") to differ from standard base64 ("+"/"/").
const attachmentBytes = Buffer.concat([Buffer.from("%PDF-1.4 fake attachment", "utf8"), Buffer.from([0xfb, 0xef, 0xbe, 0xff])])

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
              ],
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

async function seedConnectedAccount(scopes: string[] | null = FULL_SCOPES) {
  await upsertConnectedAccount({
    organizationId,
    orgMembershipId: memberId,
    providerId: "google-workspace",
    externalAccountId: "google-user-1",
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
})

beforeEach(async () => {
  resetFakeGoogle()
  await db.delete(schema.ConnectedAccountTable).where(drizzle.eq(schema.ConnectedAccountTable.organizationId, organizationId))
  await seedConnectedAccount()
})

afterAll(async () => {
  await db.delete(schema.ConnectedAccountTable).where(drizzle.eq(schema.ConnectedAccountTable.organizationId, organizationId))
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
  expect(body).toEqual({ ok: true, draftId: "draft_1", messageId: "draft_msg_1", to, subject, threadId: null })
})

test("gmail plain draft attaches active workspace file bytes with filename and MIME type", async () => {
  const attachmentBytes = Buffer.from("%PDF-1.4\nworkspace invoice\n", "utf8")
  const response = await request("/v1/capabilities/google-workspace/gmail-drafts", {
    method: "POST",
    body: {
      to: "accounts@acme.test",
      subject: "Workspace invoice",
      body: "Please see the attached invoice.",
      attachments: [{
        filename: "invoice-2026.pdf",
        mimeType: "application/pdf",
        dataBase64: attachmentBytes.toString("base64"),
      }],
    },
  })
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

test("gmail threaded reply draft reads thread metadata and sends reply headers", async () => {
  const response = await request("/v1/capabilities/google-workspace/gmail-drafts", {
    method: "POST",
    body: {
      to: "sam@acme.test",
      cc: "ada@acme.test",
      subject: "Quarterly plan",
      threadId: "thread_1",
      body: "Reply body",
      attachments: [{
        filename: "notes.txt",
        mimeType: "text/plain",
        dataBase64: Buffer.from("workspace notes", "utf8").toString("base64"),
      }],
    },
  })
  expect(response.status).toBe(200)
  expect(googleCallCount).toBe(2)
  const firstUrl = new URL(expectString(googleCallUrls[0], "first Google URL"))
  expect(firstUrl.pathname).toBe("/gmail/v1/users/me/threads/thread_1")
  expect(firstUrl.searchParams.get("format")).toBe("metadata")
  expect(firstUrl.searchParams.getAll("metadataHeaders")).toEqual(["Message-ID", "References", "Subject"])
  const secondUrl = new URL(expectString(googleCallUrls[1], "second Google URL"))
  expect(secondUrl.pathname).toBe("/gmail/v1/users/me/drafts")
  expect(lastGmailThreadUrl).toBe(expectString(googleCallUrls[0], "first Google URL"))
  const message = expectDraftMessage()
  expect(message.threadId).toBe("thread_1")
  const decoded = decodeDraftRaw()
  expect(decoded).toContain("In-Reply-To: <orig-2@mail.gmail.com>\r\n")
  expect(decoded).toContain("References: <orig-1@mail.gmail.com> <orig-2@mail.gmail.com>\r\n")
  expect(decoded).toContain('Content-Disposition: attachment; filename="notes.txt"')
  expect(decoded).toContain(Buffer.from("workspace notes", "utf8").toString("base64"))
  const body: unknown = await response.json()
  const responseBody = expectRecord(body, "threaded draft response")
  expect(responseBody.threadId).toBe("thread_1")
})

test("gmail draft rejects invalid attachment encoding and MIME type without calling Google", async () => {
  for (const attachment of [
    { filename: "invoice.pdf", mimeType: "application/pdf", dataBase64: "not base64!" },
    { filename: "invoice.pdf", mimeType: "invalid mime type", dataBase64: "aW52b2ljZQ==" },
    { filename: "invoice.pdf\r\nBcc: attacker@acme.test", mimeType: "application/pdf", dataBase64: "aW52b2ljZQ==" },
  ]) {
    resetFakeGoogle()
    const response = await request("/v1/capabilities/google-workspace/gmail-drafts", {
      method: "POST",
      body: {
        to: "sam@acme.test",
        subject: "Quarterly plan",
        body: "Draft body",
        attachments: [attachment],
      },
    })
    expect(response.status).toBe(400)
    expect(googleCallCount).toBe(0)
    const body: unknown = await response.json()
    expect(expectRecord(body, "invalid attachment response").error).toBe("invalid_request")
  }
})

test("gmail draft rejects attachments over per-file and aggregate size limits without calling Google", async () => {
  const overPerFile = Buffer.alloc((10 * 1024 * 1024) + 1).toString("base64")
  const aggregateFiles = Array.from({ length: 3 }, (_, index) => ({
    filename: `part-${index}.bin`,
    mimeType: "application/octet-stream",
    dataBase64: Buffer.alloc(7 * 1024 * 1024).toString("base64"),
  }))
  for (const attachments of [
    [{ filename: "large.bin", mimeType: "application/octet-stream", dataBase64: overPerFile }],
    aggregateFiles,
  ]) {
    resetFakeGoogle()
    const response = await request("/v1/capabilities/google-workspace/gmail-drafts", {
      method: "POST",
      body: { to: "sam@acme.test", subject: "Quarterly plan", body: "Draft body", attachments },
    })
    expect(response.status).toBe(400)
    expect(googleCallCount).toBe(0)
  }
})

test("gmail draft rejects empty and excessive attachment lists without calling Google", async () => {
  for (const attachments of [[], Array.from({ length: 11 }, (_, index) => ({
    filename: `file-${index}.txt`,
    mimeType: "text/plain",
    dataBase64: "ZmlsZQ==",
  }))]) {
    resetFakeGoogle()
    const response = await request("/v1/capabilities/google-workspace/gmail-drafts", {
      method: "POST",
      body: { to: "sam@acme.test", subject: "Quarterly plan", body: "Draft body", attachments },
    })
    expect(response.status).toBe(400)
    expect(googleCallCount).toBe(0)
  }
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
  expect(searchCapabilities(catalog, "calendar events list", 10)[0]?.name).toBe("getCapabilitiesGoogleWorkspaceCalendarEvents")
  expect(searchCapabilities(catalog, "add meet link existing event", 10)[0]?.name).toBe("patchCapabilitiesGoogleWorkspaceCalendarEvent")
  expect(searchCapabilities(catalog, "drive files", 10)[0]?.name).toBe("getCapabilitiesGoogleWorkspaceDriveFiles")
  expect(searchCapabilities(catalog, "gmail search read messages", 10)[0]?.name).toBe("getCapabilitiesGoogleWorkspaceGmailMessages")
  const draftMatch = searchCapabilities(catalog, "gmail draft workspace attachment", 10)[0]
  expect(draftMatch?.name).toBe("postCapabilitiesGoogleWorkspaceGmailDrafts")
  expect(draftMatch?.summary).toContain("attachments: [{ filename, mimeType, dataBase64 }]")
  expect(draftMatch?.summary).toContain("standard base64")
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
    "postCapabilitiesGoogleWorkspaceGmailDrafts",
  ]
  const catalogNames = new Set(catalog.map((tool) => tool.name))
  for (const name of expectedNames) {
    expect(catalogNames.has(name)).toBe(true)
    expect(name.length).toBeLessThanOrEqual(49)
    expect(name).not.toMatch(/_[a-z0-9]{7}/)
  }
})
