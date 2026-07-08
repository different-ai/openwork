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

const GMAIL_READ_SCOPE = "https://www.googleapis.com/auth/gmail.readonly"
const CALENDAR_READ_SCOPE = "https://www.googleapis.com/auth/calendar.readonly"
const CALENDAR_EVENTS_SCOPE = "https://www.googleapis.com/auth/calendar.events"
const DRIVE_READ_SCOPE = "https://www.googleapis.com/auth/drive.readonly"
const FULL_SCOPES = [GMAIL_READ_SCOPE, CALENDAR_READ_SCOPE, CALENDAR_EVENTS_SCOPE, DRIVE_READ_SCOPE]

let lastAuthorization: string | null = null
let googleCallCount = 0
let forceGoogleError = false
let lastDriveQuery: string | null = null

function resetFakeGoogle() {
  lastAuthorization = null
  googleCallCount = 0
  forceGoogleError = false
  lastDriveQuery = null
}

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
    lastAuthorization = request.headers.get("authorization")

    if (forceGoogleError && url.pathname === "/calendar/v3/calendars/primary/events") {
      return new Response("calendar exploded", { status: 500 })
    }

    if (url.pathname === "/gmail/v1/users/me/messages") {
      return json({ messages: [{ id: "msg_1", threadId: "thread_1" }] })
    }
    if (url.pathname === "/gmail/v1/users/me/messages/msg_1") {
      return json(gmailMessagePayload())
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
      return json({
        id: "created_event_1",
        summary: "Created event",
        start: { dateTime: "2026-07-08T12:00:00Z" },
        end: { dateTime: "2026-07-08T12:30:00Z" },
        htmlLink: "https://calendar.google.com/event?eid=created_event_1",
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
      },
    ],
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
    message: "Connect your Google account first: open Settings, then Extensions, and use Connect your account on the Google Workspace card.",
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
  expect(searchCapabilities(catalog, "drive files", 10)[0]?.name).toBe("getCapabilitiesGoogleWorkspaceDriveFiles")
  expect(searchCapabilities(catalog, "gmail search read messages", 10)[0]?.name).toBe("getCapabilitiesGoogleWorkspaceGmailMessages")

  const expectedNames = [
    "getCapabilitiesGoogleWorkspaceGmailMessages",
    "getCapabilitiesGoogleWorkspaceGmailMessage",
    "getCapabilitiesGoogleWorkspaceCalendarEvents",
    "postCapabilitiesGoogleWorkspaceCalendarEvents",
    "getCapabilitiesGoogleWorkspaceDriveFiles",
    "getCapabilitiesGoogleWorkspaceDriveFile",
  ]
  const catalogNames = new Set(catalog.map((tool) => tool.name))
  for (const name of expectedNames) {
    expect(catalogNames.has(name)).toBe(true)
    expect(name.length).toBeLessThanOrEqual(49)
    expect(name).not.toMatch(/_[a-z0-9]{7}/)
  }
})
