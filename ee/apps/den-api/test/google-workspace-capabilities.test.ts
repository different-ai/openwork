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

function decodeDraftTextBody(kind: "plain" | "html" = "plain"): string {
  const encoded = decodeDraftRaw().match(new RegExp(`Content-Type: text/${kind}; charset="UTF-8"\r\nContent-Transfer-Encoding: base64\r\n\r\n([A-Za-z0-9+/=\r\n]+)`))?.[1] ?? ""
  return Buffer.from(encoded.replace(/\r\n/g, ""), "base64").toString("utf8")
}

const GMAIL_READ_SCOPE = "https://www.googleapis.com/auth/gmail.readonly"
const GMAIL_MODIFY_SCOPE = "https://www.googleapis.com/auth/gmail.modify"
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
let forceDriveAuthorizationError = false
let forceDriveShareForbidden = false
let largeDriveContentHitCount = 0
let gmailListMessageIds = ["msg_1"]
let gmailNextPageToken: unknown = undefined
let driveNextPageToken: unknown = undefined
let driveIncompleteSearch: unknown = undefined
let gmailMetadataDelayMs = 0
let gmailMetadataFailureId: string | null = null
let activeGmailMetadataRequests = 0
let maxActiveGmailMetadataRequests = 0
let gmailMessageBody = "Plain Gmail body"
let gmailThreadBody = "Original line\n> previous quote"
let gmailThreadMimeType = "text/plain"
let gmailDraftReturnedThreadId: string | undefined = "thread_1"
let driveFileText = "Drive file text"
let driveDocumentText = "Exported doc text"

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
  forceDriveAuthorizationError = false
  forceDriveShareForbidden = false
  largeDriveContentHitCount = 0
  gmailListMessageIds = ["msg_1"]
  gmailNextPageToken = undefined
  driveNextPageToken = undefined
  driveIncompleteSearch = undefined
  gmailMetadataDelayMs = 0
  gmailMetadataFailureId = null
  activeGmailMetadataRequests = 0
  maxActiveGmailMetadataRequests = 0
  gmailMessageBody = "Plain Gmail body"
  gmailThreadBody = "Original line\n> previous quote"
  gmailThreadMimeType = "text/plain"
  gmailDraftReturnedThreadId = "thread_1"
  driveFileText = "Drive file text"
  driveDocumentText = "Exported doc text"
}

// Trailing high bytes force base64url output ("-"/"_") to differ from standard base64 ("+"/"/").
const attachmentBytes = Buffer.concat([Buffer.from("%PDF-1.4 fake attachment", "utf8"), Buffer.from([0xfb, 0xef, 0xbe, 0xff])])
const binaryDriveBytes = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xfb, 0xef, 0xbe, 0xff]), Buffer.from("binary fixture", "utf8")])
const dxfDriveText = "0\nSECTION\n2\nHEADER\n0\nENDSEC\n0\nEOF\n"

function gmailMessagePayload(id = "msg_1") {
  const messageNumber = id.replace(/^msg_/, "")
  return {
    id,
    threadId: `thread_${messageNumber}`,
    snippet: id === "msg_1" ? "Gmail snippet" : `Gmail snippet ${id}`,
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
        { mimeType: "text/plain", body: { data: base64Url(gmailMessageBody) } },
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
      return json({ messages: gmailListMessageIds.map((id) => ({ id, threadId: `thread_${id.replace(/^msg_/, "")}` })), nextPageToken: gmailNextPageToken })
    }
    const gmailMessageMatch = url.pathname.match(/^\/gmail\/v1\/users\/me\/messages\/([^/]+)$/)
    if (gmailMessageMatch?.[1]) {
      if (url.searchParams.get("format") === "metadata") {
        activeGmailMetadataRequests += 1
        maxActiveGmailMetadataRequests = Math.max(maxActiveGmailMetadataRequests, activeGmailMetadataRequests)
        try {
          if (gmailMessageMatch[1] === gmailMetadataFailureId) {
            return new Response("metadata exploded", { status: 500 })
          }
          if (gmailMetadataDelayMs > 0) {
            await new Promise((resolve) => setTimeout(resolve, gmailMetadataDelayMs))
          }
        } finally {
          activeGmailMetadataRequests -= 1
        }
      }
      return json(gmailMessagePayload(gmailMessageMatch[1]))
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
              parts: [{ mimeType: gmailThreadMimeType, body: { data: base64Url(gmailThreadBody) } }],
            },
          },
        ],
      })
    }
    if (url.pathname === "/gmail/v1/users/me/drafts" && request.method === "POST") {
      const body: unknown = await request.json()
      lastDraftPayload = body
      return json({ id: "draft_1", message: { id: "draft_msg_1", threadId: gmailDraftReturnedThreadId } })
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
      if (forceDriveAuthorizationError) {
        return json({
          error: {
            code: 403,
            message: `${"x".repeat(400)} Insufficient Permission`,
            status: "PERMISSION_DENIED",
            errors: [{ reason: "insufficientPermissions" }],
          },
        }, 403)
      }
      return json({
        nextPageToken: driveNextPageToken,
        incompleteSearch: driveIncompleteSearch,
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
      if (forceDriveShareForbidden) {
        return json({ error: { code: 403, message: "The target file cannot be shared.", status: "PERMISSION_DENIED" } }, 403)
      }
      const payload = isRecord(body) ? body : {}
      return json({
        id: readString(payload, "type") === "domain" ? "perm_domain_1" : "perm_user_1",
        type: readString(payload, "type"),
        role: readString(payload, "role"),
      })
    }
    if (url.pathname === "/drive/v3/files/file_1" && url.searchParams.get("alt") === "media") {
      return new Response(driveFileText, { headers: { "content-type": "text/plain" } })
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
    if (url.pathname === "/drive/v3/files/user_created_file" && url.searchParams.get("alt") === "media") {
      return new Response("Created directly in My Drive", { headers: { "content-type": "text/plain" } })
    }
    if (url.pathname === "/drive/v3/files/user_created_file") {
      return json({
        id: "user_created_file",
        name: "Created in My Drive.txt",
        mimeType: "text/plain",
        modifiedTime: "2026-08-31T12:00:00Z",
        webViewLink: "https://drive.google.com/file/d/user_created_file/view",
        size: "28",
      })
    }
    if (url.pathname === "/drive/v3/files/missing_file") {
      return json({ error: { code: 404, message: "File not found: missing_file.", status: "NOT_FOUND" } }, 404)
    }
    if (url.pathname === "/drive/v3/files/folder_1") {
      return json({
        id: "folder_1",
        name: "Planning folder",
        mimeType: "application/vnd.google-apps.folder",
        modifiedTime: "2026-08-31T12:00:00Z",
        webViewLink: "https://drive.google.com/drive/folders/folder_1",
        size: null,
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
        size: String(128 * 1024),
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
      return new Response(driveDocumentText, { headers: { "content-type": "text/plain" } })
    }
    if (url.pathname === "/drive/v3/files/sheet_1") {
      return json({
        id: "sheet_1",
        name: "Planning workbook",
        mimeType: "application/vnd.google-apps.spreadsheet",
        webViewLink: "https://docs.google.com/spreadsheets/d/sheet_1/edit",
      })
    }
    if (url.pathname === "/drive/v3/files/sheet_1/export") {
      if (url.searchParams.get("mimeType") !== "text/csv") return new Response("Unsupported export type", { status: 400 })
      return new Response("Task,Status\r\nPlanning,Ready\r\n", { headers: { "content-type": "text/csv" } })
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
const otherUserId = createDenTypeId("user")
const otherMemberId = createDenTypeId("member")
const authSessionId = createDenTypeId("session")
const authSessionToken = `gws-caps-session-${authSessionId}`
let directUploadMcpToken = ""

const workspaceDraft = {
  to: "sam@acme.test",
  subject: "Workspace notes",
  body: "Please review the attached notes.",
  attachments: ["notes.txt"],
}
const expectedFileInputPreflight = {
  ok: false,
  error: "file_input_requires_host",
  created: false,
  message: "Workspace attachments require a supporting OpenWork host. No draft was created. Do not retry without attachments.",
}

function gmailUploadForm(payload: Record<string, unknown> = {}) {
  const form = new FormData()
  form.append("payload", JSON.stringify({
    to: workspaceDraft.to,
    subject: workspaceDraft.subject,
    body: workspaceDraft.body,
    ...payload,
  }))
  form.append("file", new File(["workspace notes"], "notes.txt", { type: "text/plain" }))
  return form
}

async function seedUploadConnection(options: {
  providerKey?: string
  restricted?: boolean
  otherAccountOnly?: boolean
} = {}) {
  const { createExternalMcpConnection } = await import("../src/capability-sources/external-mcp-connections.js")
  const { upsertOrgOAuthClient } = await import("../src/capability-sources/oauth-credentials.js")
  const connection = await createExternalMcpConnection({
    organizationId,
    name: "Workspace Mail",
    url: "https://workspace.google.com",
    authType: "oauth",
    kind: "native_provider",
    nativeProviderKey: options.providerKey ?? "google-workspace",
    credentialMode: "per_member",
    createdByOrgMembershipId: otherMemberId,
    access: { orgWide: !options.restricted, memberIds: options.restricted ? [otherMemberId] : [], teamIds: [] },
  })
  await upsertOrgOAuthClient({
    organizationId,
    providerId: connection.id,
    clientId: `client-${connection.id}`,
    clientSecret: "test-client-secret",
    createdByOrgMembershipId: otherMemberId,
  })
  // Both members can own an account on the same connector; only the caller's
  // credential may be used, even when another member configured it.
  for (const accountMemberId of options.otherAccountOnly ? [otherMemberId] : [memberId, otherMemberId]) {
    await upsertConnectedAccount({
      organizationId,
      orgMembershipId: accountMemberId,
      providerId: connection.id,
      externalAccountId: `${accountMemberId}@acme.test`,
      scopes: FULL_SCOPES,
      accessToken: `${connection.id}-${accountMemberId}`,
      refreshToken: "test-refresh-token",
      tokenType: "Bearer",
      expiresAt: new Date("2037-01-01T00:00:00Z"),
      pendingCodeVerifier: null,
    })
  }
  return connection.id
}

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

async function mcpToolCall(name: string, args: Record<string, unknown>, token = directUploadMcpToken): Promise<Record<string, unknown>> {
  const response = await app.request("http://den-api.local/mcp/agent", {
    method: "POST",
    headers: {
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name, arguments: args },
    }),
  })
  expect(response.status).toBe(200)
  const responseText = await response.text()
  const dataLine = responseText.split("\n").find((line) => line.startsWith("data: "))
  const payload: unknown = JSON.parse(dataLine?.slice("data: ".length) ?? responseText)
  const envelope = expectRecord(payload, "MCP JSON-RPC response")
  return expectRecord(envelope.result, "MCP tool result")
}

function mcpText(result: Record<string, unknown>): string {
  const content = Array.isArray(result.content) ? result.content : []
  for (const part of content) {
    const record = isRecord(part) ? part : null
    if (record?.type === "text" && typeof record.text === "string") return record.text
  }
  throw new Error("Expected MCP text result")
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
  await db.insert(schema.AuthUserTable).values({
    id: otherUserId,
    name: "Other Workspace Member",
    email: `gws-caps+${otherUserId}@test.local`,
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
  await db.insert(schema.MemberTable).values({
    id: otherMemberId,
    organizationId,
    userId: otherUserId,
    role: "member",
  })
  await db.insert(schema.AuthSessionTable).values({
    id: authSessionId,
    userId,
    activeOrganizationId: organizationId,
    token: authSessionToken,
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
  })
  await credentialsMod.upsertOrgOAuthClient({
    organizationId,
    providerId: "google-workspace",
    clientId: "gws-caps-client",
    clientSecret: "gws-caps-secret",
    createdByOrgMembershipId: memberId,
  })
  const tokenResponse = await app.request("http://den-api.local/v1/mcp/token", {
    method: "POST",
    headers: {
      authorization: `Bearer ${authSessionToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ scopes: ["mcp:read", "mcp:write"] }),
  })
  expect(tokenResponse.status).toBe(200)
  const tokenBody: unknown = await tokenResponse.json()
  directUploadMcpToken = expectString(expectRecord(tokenBody, "MCP token response").token, "MCP upload token")
})

beforeEach(async () => {
  resetFakeGoogle()
  await db.delete(schema.ConnectedAccountTable).where(drizzle.eq(schema.ConnectedAccountTable.organizationId, organizationId))
  await db.delete(schema.OrgOAuthClientTable).where(drizzle.and(
    drizzle.eq(schema.OrgOAuthClientTable.organizationId, organizationId),
    drizzle.sql`${schema.OrgOAuthClientTable.providerId} <> ${"google-workspace"}`,
  ))
  await db.delete(schema.ExternalMcpConnectionAccessGrantTable).where(drizzle.eq(schema.ExternalMcpConnectionAccessGrantTable.organizationId, organizationId))
  await db.delete(schema.ExternalMcpConnectionTable).where(drizzle.eq(schema.ExternalMcpConnectionTable.organizationId, organizationId))
  await seedConnectedAccount()
})

afterAll(async () => {
  await db.delete(schema.ConnectedAccountTable).where(drizzle.eq(schema.ConnectedAccountTable.organizationId, organizationId))
  await db.delete(schema.OrgOAuthClientTable).where(drizzle.eq(schema.OrgOAuthClientTable.organizationId, organizationId))
  await db.delete(schema.ExternalMcpConnectionAccessGrantTable).where(drizzle.eq(schema.ExternalMcpConnectionAccessGrantTable.organizationId, organizationId))
  await db.delete(schema.ExternalMcpConnectionTable).where(drizzle.eq(schema.ExternalMcpConnectionTable.organizationId, organizationId))
  await db.delete(schema.OAuthAccessTokenTable).where(drizzle.eq(schema.OAuthAccessTokenTable.referenceId, organizationId))
  await db.delete(schema.AuthSessionTable).where(drizzle.eq(schema.AuthSessionTable.id, authSessionId))
  await db.delete(schema.MemberTable).where(drizzle.eq(schema.MemberTable.organizationId, organizationId))
  await db.delete(schema.OrganizationRoleTable).where(drizzle.eq(schema.OrganizationRoleTable.organizationId, organizationId))
  await db.delete(schema.OrganizationTable).where(drizzle.eq(schema.OrganizationTable.id, organizationId))
  await db.delete(schema.AuthUserTable).where(drizzle.inArray(schema.AuthUserTable.id, [userId, otherUserId]))
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

test("calendar events list accepts RFC 3339 offsets and forwards them verbatim", async () => {
  const response = await request("/v1/capabilities/google-workspace/calendar-events?timeMin=2026-09-03T00%3A00%3A00%2B02%3A00&timeMax=2026-09-04T00%3A00%3A00%2B02%3A00")
  expect(response.status).toBe(200)
  const url = new URL(expectString(lastCalendarUrl, "calendar list URL"))
  expect(url.searchParams.get("timeMin")).toBe("2026-09-03T00:00:00+02:00")
  expect(url.searchParams.get("timeMax")).toBe("2026-09-04T00:00:00+02:00")
  expect(url.searchParams.get("maxResults")).toBe("25")
  expect(googleCallCount).toBe(1)

  const mixedOffsets = new URLSearchParams({ timeMin: "2026-09-03T17:00:00+02:00", timeMax: "2026-09-03T16:00:00Z", maxResults: "100" })
  expect((await request(`/v1/capabilities/google-workspace/calendar-events?${mixedOffsets}`)).status).toBe(200)
  const mixedOffsetUrl = new URL(expectString(lastCalendarUrl, "mixed-offset calendar URL"))
  expect(mixedOffsetUrl.searchParams.get("timeMin")).toBe(mixedOffsets.get("timeMin"))
  expect(mixedOffsetUrl.searchParams.get("timeMax")).toBe(mixedOffsets.get("timeMax"))
  expect(mixedOffsetUrl.searchParams.get("maxResults")).toBe("100")

  resetFakeGoogle()
  const invalidResponse = await request("/v1/capabilities/google-workspace/calendar-events?timeMin=2026-09-03%2000%3A00&timeMax=2026-09-04%2000%3A00")
  expect(invalidResponse.status).toBe(400)
  const invalidBody = expectRecord(await invalidResponse.json(), "invalid calendar list response")
  expect(invalidBody.error).toBe("invalid_request")
  expect(googleCallCount).toBe(0)
})

test("calendar list rejects equal or reversed instants before calling Google", async () => {
  for (const timeMax of ["2026-09-03T17:00:00+02:00", "2026-09-03T15:00:00Z", "2026-09-03T14:59:59Z", "2026-09-03T18:00:00+04:00"]) {
    const query = new URLSearchParams({ timeMin: "2026-09-03T17:00:00+02:00", timeMax })
    const response = await request(`/v1/capabilities/google-workspace/calendar-events?${query}`)
    expect(response.status).toBe(400)
    expect(expectRecord(await response.json(), "invalid calendar range").error).toBe("invalid_request")
    expect(googleCallCount).toBe(0)
  }
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

test("calendar event create accepts RFC 3339 offsets and forwards them verbatim", async () => {
  const response = await request("/v1/capabilities/google-workspace/calendar-events", {
    method: "POST",
    body: {
      summary: "Offset event",
      start: "2026-09-03T17:00:00+02:00",
      end: "2026-09-03T17:30:00+02:00",
    },
  })
  expect(response.status).toBe(200)
  const payload = expectRecord(lastCalendarEventPayload, "offset calendar create payload")
  expect(expectRecord(payload.start, "offset calendar start").dateTime).toBe("2026-09-03T17:00:00+02:00")
  expect(expectRecord(payload.end, "offset calendar end").dateTime).toBe("2026-09-03T17:30:00+02:00")

  resetFakeGoogle()
  const invalidResponse = await request("/v1/capabilities/google-workspace/calendar-events", {
    method: "POST",
    body: {
      summary: "Invalid offset event",
      start: "2026-09-03T17:00",
      end: "2026-09-03T17:30",
    },
  })
  expect(invalidResponse.status).toBe(400)
  const invalidBody = expectRecord(await invalidResponse.json(), "invalid calendar create response")
  expect(invalidBody.error).toBe("invalid_request")
  expect(googleCallCount).toBe(0)
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

test("gmail list overlaps metadata requests with bounded concurrency and preserves list order", async () => {
  gmailListMessageIds = ["msg_1", "msg_2", "msg_3", "msg_4", "msg_5", "msg_6"]
  gmailMetadataDelayMs = 40
  const response = await request("/v1/capabilities/google-workspace/gmail-messages?maxResults=6")
  expect(response.status).toBe(200)
  const body = expectRecord(await response.json(), "concurrent Gmail response")
  const messages = Array.isArray(body.messages) ? body.messages.map((message) => expectRecord(message, "Gmail message")) : []
  expect(messages.map((message) => message.id)).toEqual(gmailListMessageIds)
  expect(maxActiveGmailMetadataRequests).toBeGreaterThan(1)
  expect(maxActiveGmailMetadataRequests).toBeLessThanOrEqual(4)
})

test("gmail list forwards opaque page tokens and preserves the provider's next page", async () => {
  gmailNextPageToken = "next+/= page"
  const query = new URLSearchParams({ q: "from:ada", maxResults: "5", pageToken: "current+/= page" })
  const response = await request(`/v1/capabilities/google-workspace/gmail-messages?${query}`)
  expect(response.status).toBe(200)
  const url = new URL(expectString(googleCallUrls[0], "Gmail list URL"))
  expect(url.pathname).toBe("/gmail/v1/users/me/messages")
  expect(url.searchParams.get("q")).toBe("from:ada")
  expect(url.searchParams.get("maxResults")).toBe("5")
  expect(url.searchParams.get("pageToken")).toBe("current+/= page")
  const body = expectRecord(await response.json(), "paginated Gmail response")
  expect(body.nextPageToken).toBe(gmailNextPageToken)
  expect(body.messages).toHaveLength(1)
  expect(googleCallCount).toBe(2)
})

test("gmail empty pages retain continuation without requesting message metadata", async () => {
  gmailListMessageIds = []
  gmailNextPageToken = "next-empty-page"
  const response = await request("/v1/capabilities/google-workspace/gmail-messages")
  expect(response.status).toBe(200)
  expect(await response.json()).toEqual({ ok: true, messages: [], nextPageToken: "next-empty-page" })
  expect(googleCallCount).toBe(1)
  expect(new URL(expectString(googleCallUrls[0], "Gmail list URL")).searchParams.get("pageToken")).toBeNull()
})

test.each(["", "x".repeat(2049)])("gmail rejects invalid page token (case %#) before calling Google", async (pageToken) => {
  const response = await request(`/v1/capabilities/google-workspace/gmail-messages?${new URLSearchParams({ pageToken })}`)
  expect(response.status).toBe(400)
  expect(expectRecord(await response.json(), "invalid Gmail pagination").error).toBe("invalid_request")
  expect(googleCallCount).toBe(0)
})

test.each([
  "/v1/capabilities/google-workspace/gmail-messages",
  "/v1/capabilities/google-workspace/gmail-message/msg_1",
  "/v1/capabilities/google-workspace/gmail-attachment/msg_1/att_1",
])("gmail.modify authorizes existing read route %s", async (path) => {
  await seedConnectedAccount([GMAIL_MODIFY_SCOPE])
  const response = await request(path)
  expect(response.status).toBe(200)
  expect(expectRecord(await response.json(), "Gmail modify-scope read").ok).toBe(true)
  expect(lastAuthorization).toBe("Bearer gws-token")
  expect(googleCallCount).toBe(path.endsWith("gmail-messages") ? 2 : 1)
})

test("gmail scope implications reject lookalike grants before calling Google", async () => {
  await seedConnectedAccount([`${GMAIL_MODIFY_SCOPE}.lookalike`, `prefix.${GMAIL_READ_SCOPE}`])
  const response = await request("/v1/capabilities/google-workspace/gmail-messages")
  expect(response.status).toBe(409)
  expect(expectRecord(await response.json(), "Gmail lookalike grant response").error).toBe("needs_connection")
  expect(googleCallCount).toBe(0)
})

test("gmail metadata failure stops new work and returns the existing upstream error shape", async () => {
  gmailListMessageIds = ["msg_1", "msg_2", "msg_3", "msg_4", "msg_5", "msg_6", "msg_7", "msg_8"]
  gmailMetadataFailureId = "msg_2"
  gmailMetadataDelayMs = 40
  const response = await request("/v1/capabilities/google-workspace/gmail-messages?maxResults=8")
  expect(response.status).toBe(502)
  const metadataCalls = googleCallUrls.filter((value) => new URL(value).searchParams.get("format") === "metadata")
  expect(metadataCalls).toHaveLength(4)
  expect(metadataCalls.some((value) => value.includes("/msg_5"))).toBe(false)
  expect(await response.json()).toEqual({
    error: "google_api_error",
    message: "Gmail message metadata failed: 500 metadata exploded",
  })
})

test("gmail message body retains the existing retrieval limit before MCP serialization", async () => {
  gmailMessageBody = "g".repeat(120_000)
  const response = await request("/v1/capabilities/google-workspace/gmail-message/msg_1")
  expect(response.status).toBe(200)
  const body = expectRecord(await response.json(), "bounded Gmail response")
  const message = expectRecord(body.message, "bounded Gmail message")
  expect(expectString(message.body, "bounded Gmail body")).toHaveLength(100_000)
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

for (const transport of ["JSON", "multipart"]) {
  test(`gmail ${transport} draft rejects CR and LF in every caller-supplied header before calling Google`, async () => {
    for (const field of ["to", "cc", "bcc", "subject"]) {
      for (const value of ["safe@example.com\r\nBcc: injected@example.com", "safe@example.com\rBcc: injected@example.com", "safe@example.com\nBcc: injected@example.com", "\r\nsafe@example.com", "safe@example.com\r\n"]) {
        const payload = { to: "recipient@example.com", subject: "Reply", threadId: "thread_1", body: "Reply body", [field]: value }
        let response: Response
        if (transport === "JSON") {
          response = await request("/v1/capabilities/google-workspace/gmail-drafts", { method: "POST", body: payload })
        } else {
          const form = new FormData()
          form.append("payload", JSON.stringify(payload))
          form.append("file", new File(["notes"], "notes.txt", { type: "text/plain" }))
          response = await requestForm("/v1/direct-uploads/google-workspace/gmail-drafts", form)
        }
        expect(response.status).toBe(400)
        expect(expectRecord(await response.json(), "invalid draft header").error).toBe("invalid_request")
        expect(googleCallCount).toBe(0)
        expect(lastDraftPayload).toBeNull()
      }
    }
  })
}

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
    threadUrl: "https://mail.google.com/mail/u/?authuser=google-user-1%40example.com#all/thread_1",
    to,
    subject,
    threadId: "thread_1",
    quotedHistoryIncluded: false,
  })
})

test("Gmail JSON attachments return the exact no-write host preflight before reading a thread", async () => {
  for (const body of [workspaceDraft, { ...workspaceDraft, threadId: "thread_1" }]) {
    const response = await request("/v1/capabilities/google-workspace/gmail-drafts", { method: "POST", body })
    expect(response.status).toBe(422)
    expect(await response.json()).toEqual(expectedFileInputPreflight)
    expect(googleCallCount).toBe(0)
    expect(lastDraftPayload).toBeNull()
  }
})

test("Gmail JSON attachment paths must be a nonempty bounded array of nonempty strings", async () => {
  for (const attachments of [[], [""], ["  "], Array.from({ length: 11 }, () => "notes.txt"), "notes.txt", [null]]) {
    const response = await request("/v1/capabilities/google-workspace/gmail-drafts", {
      method: "POST", body: { ...workspaceDraft, attachments },
    })
    expect(response.status).toBe(400)
    expect(googleCallCount).toBe(0)
  }
  const response = await request("/v1/capabilities/google-workspace/gmail-drafts", {
    method: "POST", body: { ...workspaceDraft, attachments: Array.from({ length: 10 }, () => "notes.txt") },
  })
  expect(response.status).toBe(422)
  expect(await response.json()).toEqual(expectedFileInputPreflight)
  expect(googleCallCount).toBe(0)
})

test("Gmail attachment preflight preserves authentication, account and threaded scope gates", async () => {
  const unauthenticated = await app.request("http://den-api.local/v1/capabilities/google-workspace/gmail-drafts", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(workspaceDraft),
  })
  expect(unauthenticated.status).toBe(401)
  await seedConnectedAccount([DRIVE_READ_SCOPE])
  const missingScope = await request("/v1/capabilities/google-workspace/gmail-drafts", {
    method: "POST", body: { ...workspaceDraft, threadId: "thread_1" },
  })
  expect(missingScope.status).toBe(409)
  expect(expectMessage(await missingScope.json())).toContain("missing the Gmail read permission")
  await db.delete(schema.ConnectedAccountTable).where(drizzle.eq(schema.ConnectedAccountTable.organizationId, organizationId))
  const missingAccount = await request("/v1/capabilities/google-workspace/gmail-drafts", { method: "POST", body: workspaceDraft })
  expect(missingAccount.status).toBe(409)
  expect(expectRecord(await missingAccount.json(), "missing account").error).toBe("needs_connection")
  expect(googleCallCount).toBe(0)
})

test("only direct native Gmail execution returns the non-error host handoff; Code Mode remains an error", async () => {
  const search = await mcpToolCall("search_capabilities", { query: "gmail draft attachments", limit: 10 })
  const matches = expectRecord(search.structuredContent, "search result").matches
  if (!Array.isArray(matches)) throw new Error("Expected capability matches")
  const draft = expectRecord(matches.find((match) => isRecord(match)
    && match.name === "native:google-workspace:postCapabilitiesGoogleWorkspaceGmailDrafts"), "draft capability")
  const name = expectString(draft.name, "draft name")
  const direct = await mcpToolCall("execute_capability", { name, body: JSON.stringify(workspaceDraft) })
  expect(direct.isError).toBe(false)
  expect(JSON.parse(mcpText(direct))).toEqual(expectedFileInputPreflight)
  expect(googleCallCount).toBe(0)

  const scriptPath = expectString(draft.scriptPath, "draft script path")
  const script = await mcpToolCall("execute_capability_script", {
    code: `return await ${scriptPath}({ body: input });`, input: workspaceDraft,
  })
  expect(script.isError).toBe(true)
  expect(mcpText(script)).toContain("file_input_requires_host")
  expect(googleCallCount).toBe(0)
  expect(lastDraftPayload).toBeNull()

  const invalid = await mcpToolCall("execute_capability", { name, body: { ...workspaceDraft, attachments: [] } })
  expect(invalid.isError).toBe(true)
  expect(mcpText(invalid)).not.toContain("file_input_requires_host")
  for (const unrelatedName of [
    `mcp:${createDenTypeId("externalMcpConnection")}:postCapabilitiesGoogleWorkspaceGmailDrafts`,
    "native:microsoft-365:postCapabilitiesGoogleWorkspaceGmailDrafts",
    `${name}:other`,
  ]) {
    const result = await mcpToolCall("execute_capability", { name: unrelatedName, body: workspaceDraft })
    expect(result.isError).toBe(true)
    expect(mcpText(result)).not.toContain("file_input_requires_host")
    expect(googleCallCount).toBe(0)
  }
  const unrelated = await mcpToolCall("execute_capability", {
    name: "native:google-workspace:getCapabilitiesGoogleWorkspaceGmailAttachment",
    path: { messageId: "msg_1", attachmentId: "missing" },
  })
  expect(unrelated.isError).toBe(true)
  expect(mcpText(unrelated)).toContain("google_api_error")
  expect(lastDraftPayload).toBeNull()
})

test("direct Gmail uploads select the exact native connection and calling member account", async () => {
  const selectedId = await seedUploadConnection()
  await seedUploadConnection()
  const preflight = await mcpToolCall("execute_capability", {
    name: `native:${selectedId}:postCapabilitiesGoogleWorkspaceGmailDrafts`, body: workspaceDraft,
  })
  expect(preflight.isError).toBe(false)
  expect(JSON.parse(mcpText(preflight))).toEqual(expectedFileInputPreflight)
  expect(googleCallCount).toBe(0)
  const response = await requestForm("/v1/direct-uploads/google-workspace/gmail-drafts", gmailUploadForm({ connectionId: selectedId }))
  expect(response.status).toBe(200)
  expect(googleCallCount).toBe(1)
  expect(lastAuthorization).toBe(`Bearer ${selectedId}-${memberId}`)
  expect(decodeDraftRaw()).toContain(Buffer.from("workspace notes").toString("base64"))
  expect(expectRecord(await response.json(), "selected draft").draftUrl).toContain(encodeURIComponent(`${memberId}@acme.test`))
})

test("explicit unavailable, wrong-provider, restricted and other-member Gmail upload selections never fall back", async () => {
  const selectedIds = [
    createDenTypeId("externalMcpConnection"),
    "unknown-provider",
    await seedUploadConnection({ providerKey: "microsoft-365" }),
    await seedUploadConnection({ restricted: true }),
    await seedUploadConnection({ otherAccountOnly: true }),
  ]
  for (const connectionId of selectedIds) {
    const response = await requestForm("/v1/direct-uploads/google-workspace/gmail-drafts", gmailUploadForm({ connectionId }))
    expect(response.status).toBe(409)
    expect(expectRecord(await response.json(), "unavailable selection").error).toBe("needs_connection")
    expect(googleCallCount).toBe(0)
    expect(lastDraftPayload).toBeNull()
  }
})

test("explicit legacy Gmail upload uses only the legacy credential, never a usable connector fallback", async () => {
  await seedUploadConnection()
  const response = await requestForm("/v1/direct-uploads/google-workspace/gmail-drafts", gmailUploadForm({ connectionId: "google-workspace" }))
  expect(response.status).toBe(200)
  expect(lastAuthorization).toBe("Bearer gws-token")
  await db.delete(schema.ConnectedAccountTable).where(drizzle.and(
    drizzle.eq(schema.ConnectedAccountTable.organizationId, organizationId),
    drizzle.eq(schema.ConnectedAccountTable.providerId, "google-workspace"),
  ))
  resetFakeGoogle()
  const unavailable = await requestForm("/v1/direct-uploads/google-workspace/gmail-drafts", gmailUploadForm({ connectionId: "google-workspace" }))
  expect(unavailable.status).toBe(409)
  expect(googleCallCount).toBe(0)
  expect(lastDraftPayload).toBeNull()
})

test("direct Gmail multipart payload rejects model attachment paths and empty connection selection", async () => {
  for (const payload of [{ attachments: ["notes.txt"] }, { connectionId: "" }, { connectionId: null }]) {
    const response = await requestForm("/v1/direct-uploads/google-workspace/gmail-drafts", gmailUploadForm(payload))
    expect(response.status).toBe(400)
    expect(googleCallCount).toBe(0)
  }
})

test("Gmail attachment preflight and direct upload preserve MCP write-scope enforcement", async () => {
  const tokenResponse = await app.request("http://den-api.local/v1/mcp/token", {
    method: "POST",
    headers: { authorization: `Bearer ${authSessionToken}`, "content-type": "application/json" },
    body: JSON.stringify({ scopes: ["mcp:read"] }),
  })
  expect(tokenResponse.status).toBe(200)
  const readToken = expectString(expectRecord(await tokenResponse.json(), "read token").token, "read token value")
  const preflight = await mcpToolCall("execute_capability", {
    name: "native:google-workspace:postCapabilitiesGoogleWorkspaceGmailDrafts", body: workspaceDraft,
  }, readToken)
  expect(preflight.isError).toBe(true)
  expect(JSON.parse(mcpText(preflight))).toEqual({ error: "insufficient_mcp_scope", requiredScope: "mcp:write" })
  const upload = await app.request("http://den-api.local/v1/direct-uploads/google-workspace/gmail-drafts", {
    method: "POST", headers: { authorization: `Bearer ${readToken}` }, body: gmailUploadForm(),
  })
  expect(upload.status).toBe(403)
  expect(await upload.json()).toEqual({ error: "insufficient_mcp_scope", requiredScope: "mcp:write" })
  expect(googleCallCount).toBe(0)
  expect(lastDraftPayload).toBeNull()
})

test("direct Gmail upload does not accept signed internal headers as host authentication or selection", async () => {
  const selectedId = await seedUploadConnection()
  const headers = authHeaders()
  headers.set("x-den-internal-capability-connector", session.createInternalCapabilityConnectorHeader({
    userId, organizationId, connectorId: selectedId,
  }))
  const unauthenticated = await app.request("http://den-api.local/v1/direct-uploads/google-workspace/gmail-drafts", {
    method: "POST", headers, body: gmailUploadForm(),
  })
  expect(unauthenticated.status).toBe(401)
  expect(googleCallCount).toBe(0)
  headers.set("authorization", `Bearer ${directUploadMcpToken}`)
  const response = await app.request("http://den-api.local/v1/direct-uploads/google-workspace/gmail-drafts", {
    method: "POST", headers, body: gmailUploadForm(),
  })
  expect(response.status).toBe(200)
  expect(lastAuthorization).toBe("Bearer gws-token")
  expect(googleCallCount).toBe(1)
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
    bcc: "hidden@acme.test",
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
  expect(decoded).toContain("Cc: ada@acme.test\r\nBcc: hidden@acme.test\r\n")
  expect(decoded).toContain("In-Reply-To: <orig-2@mail.gmail.com>\r\n")
  expect(decoded).toContain("References: <orig-1@mail.gmail.com> <orig-2@mail.gmail.com>\r\n")
  expect(decodeDraftTextBody()).toBe([
    "Reply body",
    "",
    "On Thu, 16 Jul 2026 at 15:21 UTC, Ada <ada@example.com> wrote:",
    "> Original line",
    "> > previous quote",
  ].join("\n"))
  const html = decodeDraftTextBody("html")
  expect(html).toContain('<div>Reply body</div><div><br></div><div class="gmail_quote"><div dir="ltr" class="gmail_attr">On Thu, 16 Jul 2026 at 15:21 UTC, Ada &lt;ada@example.com&gt; wrote:</div><blockquote class="gmail_quote"')
  expect(html).toContain('<div>Original line</div><div>&gt; previous quote</div></blockquote></div>')
  expect(html).not.toContain("&gt; Original line")
  expect(html).not.toContain("&gt; &gt; previous quote")
  expect(decoded).toContain('Content-Disposition: attachment; filename="notes.txt"')
  expect(decoded).toContain(Buffer.from("workspace notes", "utf8").toString("base64"))
  const body: unknown = await response.json()
  const responseBody = expectRecord(body, "threaded draft response")
  expect(responseBody.threadId).toBe("thread_1")
  expect(responseBody.draftUrl).toBe("https://mail.google.com/mail/u/?authuser=google-user-1%40example.com#drafts?compose=draft_msg_1")
  expect(responseBody.threadUrl).toBe("https://mail.google.com/mail/u/?authuser=google-user-1%40example.com#all/thread_1")
  expect(responseBody.quotedHistoryIncluded).toBe(true)
})

test("gmail JSON reply quotes HTML-only originals as escaped text", async () => {
  gmailThreadMimeType = "text/html"
  gmailThreadBody = '<p>Original &amp; &lt;img src=x onerror=unsafe()&gt;<br>Next</p><script>hidden()</script>'
  const response = await request("/v1/capabilities/google-workspace/gmail-drafts", {
    method: "POST",
    body: { to: "sam@acme.test", subject: "Quarterly plan", threadId: "thread_1", body: "Reply <script>unsafe()</script>" },
  })
  expect(response.status).toBe(200)
  expect(expectDraftMessage().threadId).toBe("thread_1")
  expect(decodeDraftTextBody()).toContain("\n> Original & <img src=x onerror=unsafe()>\n> Next")
  const html = decodeDraftTextBody("html")
  expect(html).toContain('<div>Reply &lt;script&gt;unsafe()&lt;/script&gt;</div>')
  expect(html).toContain('<blockquote class="gmail_quote"')
  expect(html).toContain('<div>Original &amp; &lt;img src=x onerror=unsafe()&gt;</div><div>Next</div>')
  expect(html).not.toMatch(/<script|<img|hidden\(\)|<div>&gt;/)
  expect(expectRecord(await response.json(), "HTML reply response").quotedHistoryIncluded).toBe(true)
})

test("gmail reply preserves caller-supplied quoted history without duplicating it", async () => {
  const body = "Reply\n\nAda wrote:\n> Already quoted <text>"
  const response = await request("/v1/capabilities/google-workspace/gmail-drafts", {
    method: "POST",
    body: { to: "sam@acme.test", subject: "Quarterly plan", threadId: "thread_1", body },
  })
  expect(response.status).toBe(200)
  expect(decodeDraftTextBody()).toBe(body)
  expect(decodeDraftTextBody("html")).not.toContain("gmail_quote")
  expect(decodeDraftTextBody("html")).not.toContain("Original line")
  expect(expectRecord(await response.json(), "already quoted response").quotedHistoryIncluded).toBe(true)
})

test("gmail draft reports only returned thread metadata, not the requested target", async () => {
  for (const returnedThreadId of ["different_thread", undefined]) {
    gmailDraftReturnedThreadId = returnedThreadId
    const response = await request("/v1/capabilities/google-workspace/gmail-drafts", {
      method: "POST",
      body: { to: "sam@acme.test", subject: "Quarterly plan", threadId: "thread_1", body: "Reply" },
    })
    expect(response.status).toBe(200)
    expect(expectDraftMessage().threadId).toBe("thread_1")
    const result = expectRecord(await response.json(), "returned thread response")
    expect(result.threadId).toBe(returnedThreadId ?? null)
    expect(result.threadUrl).toBe(returnedThreadId
      ? "https://mail.google.com/mail/u/?authuser=google-user-1%40example.com#all/different_thread"
      : null)
  }
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

  const url = new URL(expectString(googleCallUrls.at(-1), "Drive search URL"))
  expect(url.searchParams.get("pageSize")).toBe("3")
  expect(url.searchParams.get("corpora")).toBe("allDrives")
  expect(url.searchParams.get("spaces")).toBe("drive")
  expect(url.searchParams.get("supportsAllDrives")).toBe("true")
  expect(url.searchParams.get("includeItemsFromAllDrives")).toBe("true")
  expect(url.searchParams.get("orderBy")).toBeNull()
  expect(url.searchParams.get("fields")).toBe("files(id,name,mimeType,modifiedTime,webViewLink,size),nextPageToken,incompleteSearch")
  expect(url.searchParams.get("pageToken")).toBeNull()
})

test("Drive lists files without search text and retains continuation and incomplete coverage", async () => {
  driveNextPageToken = "drive-next+/= page"
  driveIncompleteSearch = true
  const response = await request("/v1/capabilities/google-workspace/drive-files")
  expect(response.status).toBe(200)
  expect(lastDriveQuery).toBe("trashed = false")
  const url = new URL(expectString(googleCallUrls[0], "Drive list URL"))
  expect(url.searchParams.get("pageSize")).toBe("10")
  expect(url.searchParams.get("pageToken")).toBeNull()
  const body = expectRecord(await response.json(), "Drive list response")
  expect(body.ok).toBe(true)
  expect(body.files).toHaveLength(1)
  expect(body.nextPageToken).toBe(driveNextPageToken)
  expect(body.incompleteSearch).toBe(true)
  expect(googleCallCount).toBe(1)
})

test.each([undefined, "quarterly"])("Drive combines date and folder filters with optional search (case %#)", async (query) => {
  driveIncompleteSearch = false
  const params = new URLSearchParams({
    modifiedAfter: "2026-09-03T17:00:00+02:00", folderId: "folder_1-a", pageToken: "drive-current+/= page", maxResults: "3",
  })
  if (query) params.set("query", query)
  const response = await request(`/v1/capabilities/google-workspace/drive-files?${params}`)
  expect(response.status).toBe(200)
  expect(lastDriveQuery).toBe(`${query ? "trashed = false and (name contains 'quarterly' or fullText contains 'quarterly')" : "trashed = false"} and modifiedTime > '2026-09-03T17:00:00+02:00' and 'folder_1-a' in parents`)
  const url = new URL(expectString(googleCallUrls[0], "filtered Drive URL"))
  expect(url.searchParams.get("pageToken")).toBe("drive-current+/= page")
  expect(url.searchParams.get("pageSize")).toBe("3")
  const body = expectRecord(await response.json(), "filtered Drive response")
  expect(body.incompleteSearch).toBe(false)
  expect(body).not.toHaveProperty("nextPageToken")
  expect(googleCallCount).toBe(1)
})

test.each([
  ["modifiedAfter", "2026-09-03"],
  ["modifiedAfter", "2026-09-03T17:00:00"],
  ["modifiedAfter", "2026-09-03T17:00:00Z' or trashed = true"],
  ["folderId", "folder_1' or 'x' in parents"],
  ["folderId", "folder/child"],
  ["pageToken", ""],
  ["pageToken", "x".repeat(2049)],
])("Drive rejects invalid %s (case %#) before calling Google", async (key, value) => {
  const response = await request(`/v1/capabilities/google-workspace/drive-files?${new URLSearchParams({ [key]: value })}`)
  expect(response.status).toBe(400)
  expect(expectRecord(await response.json(), "invalid Drive filter response").error).toBe("invalid_request")
  expect(googleCallCount).toBe(0)
})

test("listing responses omit malformed provider pagination fields", async () => {
  gmailNextPageToken = 123
  driveNextPageToken = 123
  driveIncompleteSearch = "false"
  for (const path of ["gmail-messages", "drive-files"]) {
    const response = await request(`/v1/capabilities/google-workspace/${path}`)
    expect(response.status).toBe(200)
    const body = expectRecord(await response.json(), "malformed provider pagination response")
    expect(body).not.toHaveProperty("nextPageToken")
    expect(body).not.toHaveProperty("incompleteSearch")
  }
})

test("Google Drive authorization failures become an actionable connector response", async () => {
  forceDriveAuthorizationError = true
  const response = await request("/v1/capabilities/google-workspace/drive-files?query=quarterly")
  expect(response.status).toBe(409)
  const body = expectRecord(await response.json(), "Google Drive authorization error")
  expect(body.error).toBe("needs_connection")
  expect(expectMessage(body)).toContain("enable Read all Drive files")
  expect(expectMessage(body)).toContain("reconnect Google Workspace")
})

test("drive.file alone cannot execute general Drive search", async () => {
  await seedConnectedAccount([DRIVE_FILE_SCOPE])
  resetFakeGoogle()
  const response = await request("/v1/capabilities/google-workspace/drive-files?query=quarterly&maxResults=3")
  expect(response.status).toBe(409)
  expect(googleCallCount).toBe(0)
  const body: unknown = await response.json()
  expect(expectRecord(body, "Drive authorization response").error).toBe("needs_connection")
  expect(expectMessage(body)).toContain("does not grant Read all Drive files")
  expect(expectMessage(body)).toContain("reconnect Google Workspace")
})

test("drive.file alone cannot execute general Drive read", async () => {
  await seedConnectedAccount([DRIVE_FILE_SCOPE])
  resetFakeGoogle()
  const response = await request("/v1/capabilities/google-workspace/drive-file/file_1")
  expect(response.status).toBe(409)
  expect(googleCallCount).toBe(0)
  expect(expectMessage(await response.json())).toContain("does not grant Read all Drive files")
})

test("Drive read scope matching rejects URL lookalikes", async () => {
  await seedConnectedAccount([`${DRIVE_READ_SCOPE}.lookalike`, `prefix.${DRIVE_FULL_SCOPE}`])
  resetFakeGoogle()
  const response = await request("/v1/capabilities/google-workspace/drive-files?query=quarterly")
  expect(response.status).toBe(409)
  expect(googleCallCount).toBe(0)
  expect(expectMessage(await response.json())).toContain("does not grant Read all Drive files")
})

test("missing or empty recorded scopes fail closed for general Drive search and read", async () => {
  for (const scopes of [null, []] as const) {
    for (const path of [
      "/v1/capabilities/google-workspace/drive-files?query=quarterly",
      "/v1/capabilities/google-workspace/drive-file/user_created_file",
    ]) {
      await seedConnectedAccount(scopes)
      resetFakeGoogle()
      const response = await request(path)
      expect(response.status).toBe(409)
      expect(googleCallCount).toBe(0)
      expect(expectMessage(await response.json())).toContain("could not verify the Google Drive permissions")
    }
  }
})

test("a file created directly in My Drive requires read-all scope for the same file id", async () => {
  await seedConnectedAccount([DRIVE_FILE_SCOPE])
  resetFakeGoogle()
  const denied = await request("/v1/capabilities/google-workspace/drive-file/user_created_file")
  expect(denied.status).toBe(409)
  expect(googleCallCount).toBe(0)
  expect(expectMessage(await denied.json())).toContain("does not grant Read all Drive files")

  for (const scope of [DRIVE_READ_SCOPE, DRIVE_FULL_SCOPE]) {
    await seedConnectedAccount([scope])
    resetFakeGoogle()
    const allowed = await request("/v1/capabilities/google-workspace/drive-file/user_created_file")
    expect(allowed.status).toBe(200)
    expect(googleCallCount).toBe(2)
    const file = expectRecord(expectRecord(await allowed.json(), "user-created Drive response").file, "user-created Drive file")
    expect(file.id).toBe("user_created_file")
    expect(file.content).toBe("Created directly in My Drive")
  }
})

test("Drive 404 remains an ambiguous item error when full read access is recorded", async () => {
  await seedConnectedAccount([DRIVE_FULL_SCOPE])
  resetFakeGoogle()
  const response = await request("/v1/capabilities/google-workspace/drive-file/missing_file")
  expect(response.status).toBe(502)
  expect(googleCallCount).toBe(1)
  const body = expectRecord(await response.json(), "Drive not-found response")
  expect(body.error).toBe("google_api_error")
  const message = expectMessage(body)
  expect(message).toContain("connected account may not be able to see it")
  expect(message).toContain("file ID may be incorrect")
  expect(message).toContain("item may have been deleted")
  expect(message).not.toContain("Read all Drive files")
  expect(message.length).toBeLessThan(300)
})

test("Drive file read rejects folders after metadata without attempting content download", async () => {
  const response = await request("/v1/capabilities/google-workspace/drive-file/folder_1")
  expect(response.status).toBe(400)
  expect(googleCallCount).toBe(1)
  const body = expectRecord(await response.json(), "Drive folder response")
  expect(body.error).toBe("invalid_request")
  const details = Array.isArray(body.details) ? body.details : []
  const detail = expectRecord(details[0], "Drive folder diagnostic")
  expect(detail.message).toContain("folder, not a readable file")
  expect(detail.message).toContain("Folder traversal is not supported")
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
  const metadataUrl = new URL(expectString(googleCallUrls[0], "Drive metadata URL"))
  const contentUrl = new URL(expectString(googleCallUrls[1], "Drive content URL"))
  expect(metadataUrl.searchParams.get("supportsAllDrives")).toBe("true")
  expect(contentUrl.searchParams.get("supportsAllDrives")).toBe("true")
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
  const url = new URL(expectString(googleCallUrls[1], "Google Docs export URL"))
  expect(url.pathname).toBe("/drive/v3/files/doc_1/export")
  expect(url.searchParams.get("mimeType")).toBe("text/plain")
})

test("generic Drive spreadsheet read exports first-tab CSV rather than plain text", async () => {
  const response = await request("/v1/capabilities/google-workspace/drive-file/sheet_1")
  expect(response.status).toBe(200)
  expect(lastAuthorization).toBe("Bearer gws-token")
  expect(googleCallCount).toBe(2)
  const file = expectRecord(expectRecord(await response.json(), "spreadsheet export response").file, "spreadsheet file")
  expect(file.id).toBe("sheet_1")
  expect(file.mimeType).toBe("application/vnd.google-apps.spreadsheet")
  expect(file.encoding).toBe("text")
  expect(file.content).toBe("Task,Status\r\nPlanning,Ready\r\n")
  expect(file.contentBase64).toBeNull()
  expect(file.truncated).toBe(false)
  const url = new URL(expectString(googleCallUrls[1], "spreadsheet export URL"))
  expect(url.pathname).toBe("/drive/v3/files/sheet_1/export")
  expect(url.searchParams.get("mimeType")).toBe("text/csv")
  expect(googleCallUrls.some((value) => new URL(value).pathname.startsWith("/v4/spreadsheets"))).toBe(false)
})

test("drive text retains the existing retrieval limit before MCP serialization", async () => {
  driveDocumentText = "d".repeat(210_000)
  const response = await request("/v1/capabilities/google-workspace/drive-file/doc_1")
  expect(response.status).toBe(200)
  const body = expectRecord(await response.json(), "bounded Drive response")
  const file = expectRecord(body.file, "bounded Drive file")
  expect(expectString(file.content, "bounded Drive content")).toHaveLength(200_000)
  expect(file.truncated).toBe(true)
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
  const uploadUrl = new URL(expectString(googleCallUrls[0], "Drive upload URL"))
  expect(uploadUrl.searchParams.get("supportsAllDrives")).toBe("true")
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
  expect(url.searchParams.get("supportsAllDrives")).toBe("true")
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

test("ordinary Drive share permission failures are not misclassified as missing OAuth scope", async () => {
  await seedConnectedAccount([DRIVE_FILE_SCOPE])
  resetFakeGoogle()
  forceDriveShareForbidden = true
  const response = await request("/v1/capabilities/google-workspace/drive-file-share/file_1", {
    method: "POST",
    body: { type: "user", emailAddress: "raghav@openworklabs.com" },
  })
  expect(response.status).toBe(502)
  const body = expectRecord(await response.json(), "Drive share forbidden response")
  expect(body.error).toBe("google_api_error")
  expect(expectMessage(body)).toContain("target file cannot be shared")
  expect(expectMessage(body)).not.toContain("Read all Drive files")
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

test("existing MCP search and execute path enforces Drive scope and bounds model-visible content", async () => {
  const searchResult = await mcpToolCall("search_capabilities", { query: "drive files", limit: 10 })
  const capabilityName = "native:google-workspace:getCapabilitiesGoogleWorkspaceDriveFiles"
  expect(mcpText(searchResult)).toContain(capabilityName)

  resetFakeGoogle()
  const successfulSearch = await mcpToolCall("execute_capability", {
    name: capabilityName,
    query: { query: "quarterly", maxResults: 3 },
  })
  expect(successfulSearch.isError).not.toBe(true)
  expect(mcpText(successfulSearch)).toContain("Quarterly Plan.txt")
  const providerUrl = new URL(expectString(googleCallUrls[0], "MCP Drive search URL"))
  expect(providerUrl.searchParams.get("supportsAllDrives")).toBe("true")
  expect(providerUrl.searchParams.get("includeItemsFromAllDrives")).toBe("true")

  resetFakeGoogle()
  const rawBinary = binaryDriveBytes.toString("base64")
  const binaryResult = await mcpToolCall("execute_capability", {
    name: "native:google-workspace:getCapabilitiesGoogleWorkspaceDriveFile",
    path: { fileId: "binary_file" },
  })
  const binaryText = mcpText(binaryResult)
  expect(binaryText).toContain(rawBinary)
  expect(binaryText).not.toContain("contentBase64Omitted")
  expect(Buffer.byteLength(binaryText, "utf8")).toBeLessThan(2_000)

  resetFakeGoogle()
  const largeBinaryResult = await mcpToolCall("execute_capability", {
    name: "native:google-workspace:getCapabilitiesGoogleWorkspaceDriveFile",
    path: { fileId: "large_file" },
  })
  const largeBinaryText = mcpText(largeBinaryResult)
  expect(largeBinaryText).toContain('"contentBase64": null')
  expect(largeBinaryText).not.toContain("contentBase64Omitted")
  expect(largeBinaryText).toContain("file_too_large")
  expect(largeDriveContentHitCount).toBe(0)

  resetFakeGoogle()
  driveDocumentText = "d".repeat(25_000)
  const textResult = await mcpToolCall("execute_capability", {
    name: "native:google-workspace:getCapabilitiesGoogleWorkspaceDriveFile",
    path: { fileId: "doc_1" },
  })
  const modelText = mcpText(textResult)
  expect(modelText).toContain("[truncated]")
  expect(modelText).not.toContain("d".repeat(20_001))
  expect(Buffer.byteLength(modelText, "utf8")).toBeLessThan(22_000)

  resetFakeGoogle()
  gmailMessageBody = "g".repeat(25_000)
  const gmailTextResult = await mcpToolCall("execute_capability", {
    name: "native:google-workspace:getCapabilitiesGoogleWorkspaceGmailMessage",
    path: { messageId: "msg_1" },
  })
  const gmailModelText = mcpText(gmailTextResult)
  expect(gmailModelText).toContain("[truncated]")
  expect(gmailModelText).not.toContain("g".repeat(20_001))
  expect(Buffer.byteLength(gmailModelText, "utf8")).toBeLessThan(22_000)

  resetFakeGoogle()
  const attachmentResult = await mcpToolCall("execute_capability", {
    name: "native:google-workspace:getCapabilitiesGoogleWorkspaceGmailAttachment",
    path: { messageId: "msg_1", attachmentId: "att_1" },
  })
  expect(mcpText(attachmentResult)).toContain(attachmentBytes.toString("base64"))

  await seedConnectedAccount([DRIVE_FILE_SCOPE])
  resetFakeGoogle()
  const deniedSearch = await mcpToolCall("execute_capability", {
    name: capabilityName,
    query: { query: "quarterly", maxResults: 3 },
  })
  expect(deniedSearch.isError).toBe(true)
  expect(mcpText(deniedSearch)).toContain("does not grant Read all Drive files")
  expect(googleCallCount).toBe(0)
})

test("legacy accounts without recorded scopes retain existing non-Drive behavior", async () => {
  await seedConnectedAccount(null)
  resetFakeGoogle()
  const gmail = await request("/v1/capabilities/google-workspace/gmail-messages")
  expect(gmail.status).toBe(200)
  expect(googleCallCount).toBe(2)

  await seedConnectedAccount(null)
  resetFakeGoogle()
  const share = await request("/v1/capabilities/google-workspace/drive-file-share/file_1", {
    method: "POST",
    body: { type: "user", emailAddress: "raghav@openworklabs.com" },
  })
  expect(share.status).toBe(200)
  expect(googleCallCount).toBe(1)
})

test("new Google actions fail closed on unknown grants independently of legacy routes", async () => {
  const grants: (string[] | null)[] = [null, [], ["openid"]]
  const actions = [
    { path: "gmail-labels" },
    { path: "gmail-labels", method: "POST", body: { name: "Planning" } },
    { path: "gmail-message/msg_1/modify", method: "POST", body: { removeLabelIds: ["UNREAD"] } },
    { path: "spreadsheets/sheet_1" },
    { path: "spreadsheets/sheet_1/values?range=A1:B2" },
    { path: "spreadsheets/sheet_1/values", method: "PUT", body: { range: "A1", values: [["Planning"]] } },
    { path: "drive-files/file_1" },
    { path: "drive-folders", method: "POST", body: { name: "Planning" } },
    { path: "calendar-events/event_1" },
  ]
  for (const scopes of grants) {
    await seedConnectedAccount(scopes)
    for (const action of actions) {
      resetFakeGoogle()
      const response = await request(`/v1/capabilities/google-workspace/${action.path}`, action)
      expect(response.status).toBe(409)
      expect(expectRecord(await response.json(), "unknown-grant action response").error).toBe("needs_connection")
      expect(googleCallCount).toBe(0)
    }
  }
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

  const descriptions = JSON.stringify(document)
  expect(descriptions).toContain("decode to a workspace file")
  expect(descriptions).toContain("if that action is available in the current client")
  expect(descriptions).not.toContain("passed directly to the Drive upload capability's dataBase64 field")

  const catalog = buildMcpCatalog(document)
  const calendarMatch = searchCapabilities(catalog, "calendar events list", 10)[0]
  expect(calendarMatch?.name).toBe("getCapabilitiesGoogleWorkspaceCalendarEvents")
  expect(calendarMatch?.queryParams).toEqual(["timeMin", "timeMax", "maxResults"])
  expect(searchCapabilities(catalog, "add meet link existing event", 10)[0]?.name).toBe("patchCapabilitiesGoogleWorkspaceCalendarEvent")
  const driveMatch = searchCapabilities(catalog, "drive files", 10)[0]
  expect(driveMatch?.name).toBe("getCapabilitiesGoogleWorkspaceDriveFiles")
  expect(driveMatch?.queryParams).toEqual(["query", "maxResults", "pageToken", "modifiedAfter", "folderId"])
  expect(catalog.some((tool) => tool.name === "postCapabilitiesGoogleWorkspaceDriveFiles")).toBe(false)
  expect(catalog.some((tool) => tool.name.includes("DirectUploads"))).toBe(false)
  expect(searchCapabilities(catalog, "share drive file", 10)[0]?.name).toBe("postCapabilitiesGoogleWorkspaceDriveFileShare")
  const gmailMatch = searchCapabilities(catalog, "gmail search read messages", 10)[0]
  expect(gmailMatch?.name).toBe("getCapabilitiesGoogleWorkspaceGmailMessages")
  expect(gmailMatch?.queryParams).toEqual(["q", "maxResults", "pageToken"])
  expect(searchCapabilities(catalog, "outlook mail messages", 20).find((match) => match.name === "getCapabilitiesMicrosoft365MailMessages")?.queryParams).toEqual(["search", "maxResults"])
  const draftMatch = searchCapabilities(catalog, "gmail draft attachments", 10)[0]
  expect(draftMatch?.name).toBe("postCapabilitiesGoogleWorkspaceGmailDrafts")
  expect(draftMatch?.summary).toContain("optional workspace attachments")
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

test("search_capabilities exposes query parameter constraints as JSON schema instead of leaked validator internals", async () => {
  const gmailSearch = await mcpToolCall("search_capabilities", { query: "gmail search read messages", limit: 10 })
  const gmailStructuredContent = expectRecord(gmailSearch.structuredContent, "Gmail capability search structured content")
  if (!Array.isArray(gmailStructuredContent.matches)) {
    throw new Error("Expected Gmail capability search matches to be an array")
  }
  const gmailMatches = gmailStructuredContent.matches.map((match, index) => expectRecord(match, `Gmail capability search match ${index}`))
  const gmailMatch = expectRecord(
    gmailMatches.find((match) => match.name === "native:google-workspace:getCapabilitiesGoogleWorkspaceGmailMessages"),
    "Gmail messages capability match",
  )
  const gmailQuerySchema = expectRecord(gmailMatch.querySchema, "Gmail messages query schema")
  const gmailProperties = expectRecord(gmailQuerySchema.properties, "Gmail messages query properties")
  const maxResultsSchema = expectRecord(gmailProperties.maxResults, "Gmail maxResults query schema")
  expect(maxResultsSchema).toMatchObject({ type: "integer", minimum: 1, maximum: 25, default: 10 })
  expect(expectString(maxResultsSchema.description, "Gmail maxResults description")).toContain("capped at 25")
  expect("inputSchema" in gmailMatch).toBe(false)
  expect(JSON.stringify(gmailMatch)).not.toContain('"checks":')
  expect(JSON.stringify(gmailMatch)).not.toContain('"def":')
  expect(mcpText(gmailSearch)).not.toContain('"checks":')

  const calendarSearch = await mcpToolCall("search_capabilities", { query: "calendar events list", limit: 10 })
  const calendarStructuredContent = expectRecord(calendarSearch.structuredContent, "calendar capability search structured content")
  if (!Array.isArray(calendarStructuredContent.matches)) {
    throw new Error("Expected calendar capability search matches to be an array")
  }
  const calendarMatches = calendarStructuredContent.matches.map((match, index) => expectRecord(match, `calendar capability search match ${index}`))
  const calendarMatch = expectRecord(
    calendarMatches.find((match) => match.name === "native:google-workspace:getCapabilitiesGoogleWorkspaceCalendarEvents"),
    "calendar events capability match",
  )
  const calendarQuerySchema = expectRecord(calendarMatch.querySchema, "calendar events query schema")
  expect(calendarQuerySchema.required).toEqual(["timeMin", "timeMax"])
  const calendarProperties = expectRecord(calendarQuerySchema.properties, "calendar events query properties")
  const timeMinSchema = expectRecord(calendarProperties.timeMin, "calendar timeMin query schema")
  expect(timeMinSchema.format).toBe("date-time")
  expect(expectString(timeMinSchema.description, "calendar timeMin description")).toContain("+02:00")

  const draftSearch = await mcpToolCall("search_capabilities", { query: "gmail draft attachments", limit: 10 })
  const draftStructuredContent = expectRecord(draftSearch.structuredContent, "Gmail draft capability search structured content")
  if (!Array.isArray(draftStructuredContent.matches)) {
    throw new Error("Expected Gmail draft capability search matches to be an array")
  }
  const draftMatches = draftStructuredContent.matches.map((match, index) => expectRecord(match, `Gmail draft capability search match ${index}`))
  const draftMatch = expectRecord(
    draftMatches.find((match) => match.name === "native:google-workspace:postCapabilitiesGoogleWorkspaceGmailDrafts"),
    "Gmail draft capability match",
  )
  expect(draftMatch).not.toHaveProperty("querySchema")
  expect(draftMatch.summary).toContain("optional workspace attachments")
  const bodySchema = expectRecord(draftMatch.bodySchema, "draft body schema")
  expect(bodySchema.required).not.toContain("attachments")
  const properties = expectRecord(bodySchema.properties, "draft properties")
  const attachments = expectRecord(properties.attachments, "attachment input schema")
  expect(attachments).toMatchObject({ type: "array", minItems: 1, maxItems: 10, items: { type: "string", minLength: 1 } })
  const description = expectString(attachments.description, "attachment description")
  for (const guidance of ["workspace file paths", "4 MiB", "outside model context", "direct execute_capability", "supporting OpenWork host", "Code Mode", "no draft"]) {
    expect(description).toContain(guidance)
  }
  expect(properties).not.toHaveProperty("connectionId")
  expect(attachments).not.toHaveProperty("x-mcp-file")
})
