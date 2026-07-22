import type { Hono } from "hono"
import { randomUUID } from "node:crypto"
import { describeRoute } from "hono-openapi"
import { z } from "zod"
import type { DenTypeId } from "@openwork-ee/utils/typeid"
import { env } from "../../env.js"
import { jsonValidator, orgMemberRoute, paramValidator, queryValidator } from "../../middleware/index.js"
import { invalidRequestSchema, jsonResponse, unauthorizedSchema } from "../../openapi.js"
import { buildGmailDraftRaw, readGmailDraftIds } from "../../capability-sources/gmail.js"
import type { GmailDraftAttachment } from "../../capability-sources/gmail.js"
import { getValidAccessToken } from "../../capability-sources/generic-oauth.js"
import {
  buildDriveMultipartUpload,
  buildDriveSearchQuery,
  buildGmailQuoteBlock,
  extractCalendarEvents,
  extractDriveFiles,
  extractDrivePermission,
  extractGmailAttachmentData,
  extractGmailMessage,
  extractGmailMessageIds,
  extractGmailThreadQuoteInput,
  extractGmailThreadReplyContext,
  gmailBodyHasQuotedHistory,
  truncateText,
} from "../../capability-sources/google-workspace-api.js"
import type { ConnectedAccountRow } from "../../capability-sources/oauth-credentials.js"
import { getNativeOAuthProvider } from "../../capability-sources/provider-registry.js"
import type { OrgRouteVariables } from "./shared.js"

const GMAIL_READ_SCOPE = "https://www.googleapis.com/auth/gmail.readonly"
const CALENDAR_READ_SCOPE = "https://www.googleapis.com/auth/calendar.readonly"
const CALENDAR_EVENTS_SCOPE = "https://www.googleapis.com/auth/calendar.events"
const DRIVE_FILE_SCOPE = "https://www.googleapis.com/auth/drive.file"
const DRIVE_READ_SCOPE = "https://www.googleapis.com/auth/drive.readonly"
const DRIVE_FULL_SCOPE = "https://www.googleapis.com/auth/drive"
const GOOGLE_WORKSPACE_API_TIMEOUT_MS = 30_000
const MAX_GMAIL_ATTACHMENT_BYTES = 10 * 1024 * 1024
const MAX_GMAIL_ATTACHMENTS_TOTAL_BYTES = 20 * 1024 * 1024
const MAX_GMAIL_ATTACHMENT_BASE64_LENGTH = Math.ceil(MAX_GMAIL_ATTACHMENT_BYTES / 3) * 4
const GMAIL_REPLY_SUBJECT_RE = /^\s*(re|fwd?)\s*:/i

const CONNECT_GOOGLE_ACCOUNT_MESSAGE = "Connect your Google account first: open Settings > Connect and use Connect your account on the Google Workspace row, or connect from the OpenWork Cloud dashboard."

const gmailDraftAttachmentSchema = z.object({
  filename: z.string().trim().min(1).max(255).refine((value) => !/[\r\n]/.test(value), "Filename must not contain line breaks.").describe("Filename to show in Gmail."),
  mimeType: z.string().trim().regex(/^[!#$%&'*+.^_`|~0-9A-Za-z-]+\/[!#$%&'*+.^_`|~0-9A-Za-z-]+$/).describe("Attachment MIME type."),
  dataBase64: z.string().min(1).max(MAX_GMAIL_ATTACHMENT_BASE64_LENGTH).regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/).describe("File bytes encoded as standard base64. Read the file from the active workspace and base64-encode it. Maximum decoded size: 10 MiB per file and 20 MiB total."),
}).strict()

const createDraftBodySchema = z.object({
  to: z.string().trim().min(3).max(320).describe("Recipient email address."),
  cc: z.string().trim().min(3).max(1_000).optional().describe("Optional comma-separated Cc email addresses."),
  bcc: z.string().trim().min(3).max(1_000).optional().describe("Optional comma-separated Bcc email addresses."),
  subject: z.string().trim().min(1).max(500).describe("Draft subject line. For replies or forwards, include threadId; subjects starting with Re: or Fwd: are rejected without threadId so the draft stays on the existing conversation."),
  body: z.string().min(1).max(50_000).describe("Plain-text draft body. Write plain prose with no markdown syntax, separate paragraphs with blank lines, and do not hard-wrap prose. For threaded drafts, the server appends the quoted conversation automatically; do not include quoted history."),
  threadId: z.string().trim().min(1).max(512).optional().describe("Gmail thread id to reply on. Required for replies and forwards; get it from the gmail-messages capability. When set, the draft is attached to that thread as a reply — keep the thread's subject (e.g. 'Re: …')."),
  attachments: z.array(gmailDraftAttachmentSchema).min(1).max(10).optional().describe("Optional files from the active workspace to attach to this draft."),
}).strict().superRefine((input, context) => {
  const totalBytes = (input.attachments ?? []).reduce((total, attachment) => total + Buffer.byteLength(attachment.dataBase64, "base64"), 0)
  if (totalBytes > MAX_GMAIL_ATTACHMENTS_TOTAL_BYTES) {
    context.addIssue({
      code: "custom",
      path: ["attachments"],
      message: "Attachments must be 20 MiB or less in total.",
    })
  }
})

const createDraftResponseSchema = z.object({
  ok: z.literal(true),
  draftId: z.string(),
  messageId: z.string().nullable(),
  draftUrl: z.string().nullable().describe("Gmail URL for the ready-to-send draft. Always share draftUrl with the user so they can open the draft in Gmail for review and send."),
  threadUrl: z.string().nullable().describe("Gmail URL for the conversation thread when this draft is a threaded reply."),
  to: z.string(),
  subject: z.string(),
  threadId: z.string().nullable(),
  quotedHistoryIncluded: z.boolean().describe("True when quoted conversation history was included by the server or already present in the request body."),
  attachments: z.array(z.object({
    filename: z.string(),
    mimeType: z.string(),
    size: z.number().int().nonnegative(),
  })).optional(),
}).meta({ ref: "GoogleWorkspaceDraftResponse" })

const needsConnectionSchema = z.object({
  error: z.literal("needs_connection"),
  message: z.string(),
}).meta({ ref: "GoogleWorkspaceNeedsConnectionError" })

const missingThreadIdSchema = z.object({
  error: z.literal("missing_thread_id"),
  message: z.string(),
}).meta({ ref: "GoogleWorkspaceMissingThreadIdError" })

const upstreamErrorSchema = z.object({
  error: z.literal("google_api_error"),
  message: z.string(),
}).meta({ ref: "GoogleWorkspaceUpstreamError" })

function gmailDraftUrl(messageId: string | null): string | null {
  return messageId ? `https://mail.google.com/mail/u/0/#drafts?compose=${encodeURIComponent(messageId)}` : null
}

function gmailThreadUrl(threadId: string | undefined): string | null {
  return threadId ? `https://mail.google.com/mail/u/0/#all/${encodeURIComponent(threadId)}` : null
}

const gmailMessagesQuerySchema = z.object({
  q: z.string().trim().min(1).max(1_000).optional().describe("Optional Gmail search query, using Gmail's search syntax."),
  maxResults: z.coerce.number().int().min(1).max(25).default(10).describe("Maximum messages to return, capped at 25."),
}).meta({ ref: "GoogleWorkspaceGmailMessagesQuery" })

const gmailMessageParamSchema = z.object({
  messageId: z.string().trim().min(1).max(512).describe("Gmail message id."),
}).meta({ ref: "GoogleWorkspaceGmailMessageParams" })

const gmailAttachmentSchema = z.object({
  attachmentId: z.string(),
  filename: z.string(),
  mimeType: z.string(),
  size: z.number().nullable(),
}).meta({ ref: "GoogleWorkspaceGmailAttachment" })

const gmailMessageSummarySchema = z.object({
  id: z.string(),
  threadId: z.string(),
  from: z.string(),
  to: z.string(),
  subject: z.string(),
  date: z.string(),
  snippet: z.string(),
}).meta({ ref: "GoogleWorkspaceGmailMessageSummary" })

const gmailMessageSchema = gmailMessageSummarySchema.extend({
  body: z.string(),
  attachments: z.array(gmailAttachmentSchema),
}).meta({ ref: "GoogleWorkspaceGmailMessage" })

const gmailMessagesResponseSchema = z.object({
  ok: z.literal(true),
  messages: z.array(gmailMessageSummarySchema),
}).meta({ ref: "GoogleWorkspaceGmailMessagesResponse" })

const gmailMessageResponseSchema = z.object({
  ok: z.literal(true),
  message: gmailMessageSchema,
}).meta({ ref: "GoogleWorkspaceGmailMessageResponse" })

const gmailAttachmentParamSchema = z.object({
  messageId: z.string().trim().min(1).max(512).describe("Gmail message id that contains the attachment."),
  attachmentId: z.string().trim().min(1).max(2_048).describe("Attachment id from the gmail-message capability's attachments metadata."),
}).meta({ ref: "GoogleWorkspaceGmailAttachmentParams" })

const gmailAttachmentResponseSchema = z.object({
  ok: z.literal(true),
  messageId: z.string(),
  attachmentId: z.string(),
  size: z.number().describe("Attachment size in bytes."),
  dataBase64: z.string().describe("Standard base64-encoded attachment bytes; decode locally to reconstruct the file."),
}).meta({ ref: "GoogleWorkspaceGmailAttachmentResponse" })

const calendarEventsQuerySchema = z.object({
  timeMin: z.string().datetime().describe("Inclusive lower bound for event start time."),
  timeMax: z.string().datetime().describe("Exclusive upper bound for event start time."),
  maxResults: z.coerce.number().int().min(1).max(100).default(25).describe("Maximum events to return, capped at 100."),
}).meta({ ref: "GoogleWorkspaceCalendarEventsQuery" })

const calendarEventParamSchema = z.object({
  eventId: z.string().trim().min(1).max(512).describe("Google Calendar event id."),
}).meta({ ref: "GoogleWorkspaceCalendarEventParams" })

const calendarEventSchema = z.object({
  id: z.string(),
  summary: z.string(),
  description: z.string(),
  location: z.string(),
  start: z.string(),
  end: z.string(),
  status: z.string(),
  htmlLink: z.string(),
  attendees: z.array(z.string()),
  meetLink: z.string().nullable(),
}).meta({ ref: "GoogleWorkspaceCalendarEvent" })

const calendarEventsResponseSchema = z.object({
  ok: z.literal(true),
  events: z.array(calendarEventSchema),
}).meta({ ref: "GoogleWorkspaceCalendarEventsResponse" })

const createCalendarEventBodySchema = z.object({
  summary: z.string().trim().min(1).max(1_000).describe("Event title."),
  description: z.string().max(20_000).optional().describe("Optional event description."),
  location: z.string().max(1_000).optional().describe("Optional event location."),
  start: z.string().datetime().describe("Event start date-time."),
  end: z.string().datetime().describe("Event end date-time."),
  timeZone: z.string().trim().min(1).max(128).optional().describe("Optional IANA time zone for start and end."),
  attendees: z.array(z.string().email()).max(100).optional().describe("Optional attendee email addresses."),
  createMeetLink: z.boolean().optional().describe("Set true to create a Google Meet conferencing link for this event; the response returns meetLink when Google creates it."),
}).meta({ ref: "GoogleWorkspaceCreateCalendarEventBody" })

const createCalendarEventResponseSchema = z.object({
  ok: z.literal(true),
  eventId: z.string(),
  htmlLink: z.string(),
  summary: z.string(),
  start: z.string(),
  end: z.string(),
  meetLink: z.string().nullable(),
}).meta({ ref: "GoogleWorkspaceCreateCalendarEventResponse" })

const updateCalendarEventBodySchema = z.object({
  createMeetLink: z.literal(true).describe("Set true to add a Google Meet conferencing link to this existing event."),
}).meta({ ref: "GoogleWorkspaceUpdateCalendarEventBody" })

const updateCalendarEventResponseSchema = z.object({
  ok: z.literal(true),
  eventId: z.string(),
  htmlLink: z.string(),
  summary: z.string(),
  start: z.string(),
  end: z.string(),
  meetLink: z.string().nullable(),
}).meta({ ref: "GoogleWorkspaceUpdateCalendarEventResponse" })

const driveFilesQuerySchema = z.object({
  query: z.string().trim().min(1).max(500).describe("Text to search in Drive file names and full text."),
  maxResults: z.coerce.number().int().min(1).max(25).default(10).describe("Maximum files to return, capped at 25."),
}).meta({ ref: "GoogleWorkspaceDriveFilesQuery" })

const uploadDriveFileBodySchema = z.object({
  filename: z.string().trim().min(1).max(255).refine((value) => !/[\r\n]/.test(value), "Filename must not contain line breaks.").describe("Filename to create in Google Drive."),
  mimeType: z.string().trim().regex(/^[!#$%&'*+.^_`|~0-9A-Za-z-]+\/[!#$%&'*+.^_`|~0-9A-Za-z-]+$/).describe("File MIME type."),
  dataBase64: z.string().min(1).max(MAX_GMAIL_ATTACHMENT_BASE64_LENGTH).regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/).describe("File bytes as standard base64. The gmail-attachment capability returns dataBase64 in this exact encoding — pass it through directly to save an email attachment to Drive. Maximum decoded size: 10 MiB."),
  folderId: z.string().trim().min(1).max(512).optional().describe("Optional Google Drive parent folder id."),
}).strict().superRefine((input, context) => {
  if (Buffer.byteLength(input.dataBase64, "base64") > MAX_GMAIL_ATTACHMENT_BYTES) {
    context.addIssue({
      code: "custom",
      path: ["dataBase64"],
      message: "File must be 10 MiB or less.",
    })
  }
}).meta({ ref: "GoogleWorkspaceUploadDriveFileBody" })

const driveFileParamSchema = z.object({
  fileId: z.string().trim().min(1).max(512).describe("Google Drive file id."),
}).meta({ ref: "GoogleWorkspaceDriveFileParams" })

const shareDriveFileBodySchema = z.object({
  type: z.enum(["user", "domain"]).describe("Use type=user to share with one person, or type=domain to share with the entire organization."),
  emailAddress: z.string().trim().email().max(320).optional().describe("Required when type=user; pass the person's email address, for example raghav@openworklabs.com."),
  domain: z.string().trim().min(1).max(255).optional().describe("Required when type=domain; pass the organization's Google Workspace domain, for example openworklabs.com."),
  role: z.enum(["reader", "commenter", "writer"]).default("reader").describe("Drive permission role to grant."),
  sendNotificationEmail: z.boolean().default(true).describe("Whether Google should email the recipient about the new access."),
}).strict().superRefine((input, context) => {
  if (input.type === "user" && !input.emailAddress) {
    context.addIssue({
      code: "custom",
      path: ["emailAddress"],
      message: "emailAddress is required when type is user.",
    })
  }
  if (input.type === "domain" && !input.domain) {
    context.addIssue({
      code: "custom",
      path: ["domain"],
      message: "domain is required when type is domain.",
    })
  }
}).meta({ ref: "GoogleWorkspaceShareDriveFileBody" })

const driveFileSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  mimeType: z.string(),
  modifiedTime: z.string(),
  webViewLink: z.string(),
  size: z.string().nullable(),
}).meta({ ref: "GoogleWorkspaceDriveFileSummary" })

const driveFilesResponseSchema = z.object({
  ok: z.literal(true),
  files: z.array(driveFileSummarySchema),
}).meta({ ref: "GoogleWorkspaceDriveFilesResponse" })

const uploadDriveFileResponseSchema = z.object({
  ok: z.literal(true),
  file: driveFileSummarySchema,
}).meta({ ref: "GoogleWorkspaceUploadDriveFileResponse" })

const driveFileResponseSchema = z.object({
  ok: z.literal(true),
  file: driveFileSummarySchema.extend({
    content: z.string(),
    truncated: z.boolean(),
  }),
}).meta({ ref: "GoogleWorkspaceDriveFileResponse" })

const shareDriveFileResponseSchema = z.object({
  ok: z.literal(true),
  fileId: z.string(),
  permissionId: z.string(),
  type: z.string(),
  role: z.string(),
}).meta({ ref: "GoogleWorkspaceShareDriveFileResponse" })

type GoogleWorkspaceAccessToken =
  | { kind: "ok"; accessToken: string; account: ConnectedAccountRow }
  | { kind: "needs_connection"; message: string }
  | { kind: "google_api_error"; message: string }

type CalendarConferenceData = {
  createRequest: {
    requestId: string
    conferenceSolutionKey: { type: "hangoutsMeet" }
  }
}

type CalendarEventCreatePayload = {
  summary: string
  description?: string
  location?: string
  start: { dateTime: string; timeZone?: string }
  end: { dateTime: string; timeZone?: string }
  attendees?: { email: string }[]
  conferenceData?: CalendarConferenceData
}

function gmailApiBase(): string {
  return (env.googleApiBaseUrl ?? "https://gmail.googleapis.com").replace(/\/+$/, "")
}

function calendarApiBase(): string {
  // Calendar and Drive normally share www.googleapis.com; one env knob keeps Google API tests simple.
  return (env.googleApiBaseUrl ?? "https://www.googleapis.com").replace(/\/+$/, "")
}

function driveApiBase(): string {
  // Calendar and Drive normally share www.googleapis.com; one env knob keeps Google API tests simple.
  return (env.googleApiBaseUrl ?? "https://www.googleapis.com").replace(/\/+$/, "")
}

export function missingScope(account: ConnectedAccountRow, anyOf: string[]): boolean {
  const scopes = account.scopes
  if (!Array.isArray(scopes) || scopes.length === 0) {
    return false
  }
  return !anyOf.some((scope) => scopes.includes(scope))
}

function missingPermissionMessage(label: string): string {
  return `Your connected Google account is missing the ${label} permission. An admin can enable it on the Google Workspace connector in OpenWork Cloud -> Connectors; then reconnect your account in Settings -> Extensions.`
}

async function googleWorkspaceToken(input: {
  organizationId: DenTypeId<"organization">
  orgMembershipId: DenTypeId<"member">
}): Promise<GoogleWorkspaceAccessToken> {
  const provider = getNativeOAuthProvider("google-workspace")
  if (!provider) {
    return { kind: "google_api_error", message: "google-workspace provider is not registered." }
  }

  const token = await getValidAccessToken({
    provider,
    organizationId: input.organizationId,
    orgMembershipId: input.orgMembershipId,
  })
  if ("error" in token) {
    return { kind: "needs_connection", message: CONNECT_GOOGLE_ACCOUNT_MESSAGE }
  }

  return { kind: "ok", accessToken: token.accessToken, account: token.account }
}

async function googleApiError(operation: string, response: Response) {
  const text = await response.text()
  return { error: "google_api_error", message: `${operation} failed: ${response.status} ${text.slice(0, 300)}` }
}

async function googleWorkspaceApiFetch(input: Parameters<typeof fetch>[0], init?: RequestInit): Promise<Response> {
  return fetch(input, {
    ...init,
    signal: AbortSignal.timeout(GOOGLE_WORKSPACE_API_TIMEOUT_MS),
  })
}

async function readJson(response: Response): Promise<unknown> {
  const body: unknown = await response.json()
  return body
}

function buildCalendarEventPayload(input: z.infer<typeof createCalendarEventBodySchema>): CalendarEventCreatePayload {
  const start: CalendarEventCreatePayload["start"] = { dateTime: input.start }
  const end: CalendarEventCreatePayload["end"] = { dateTime: input.end }
  if (input.timeZone) {
    start.timeZone = input.timeZone
    end.timeZone = input.timeZone
  }

  const payload: CalendarEventCreatePayload = { summary: input.summary, start, end }
  if (input.description) payload.description = input.description
  if (input.location) payload.location = input.location
  if (input.attendees?.length) {
    payload.attendees = input.attendees.map((email) => ({ email }))
  }
  return payload
}

function buildCalendarConferenceData(): CalendarConferenceData {
  return {
    createRequest: {
      requestId: `openwork-${randomUUID()}`,
      conferenceSolutionKey: { type: "hangoutsMeet" },
    },
  }
}

/**
 * Native Google Workspace capabilities, executed by Den with the calling
 * member Den-brokered credential (getValidAccessToken). Tagged
 * "Capability Sources" so search_capabilities/execute_capability discover
 * them — the agent path needs no MCP server and no extra wiring.
 */
export function registerGoogleWorkspaceRoutes<T extends { Variables: OrgRouteVariables }>(app: Hono<T>) {
  app.get(
    "/v1/capabilities/google-workspace/gmail-messages",
    describeRoute({
      tags: ["Capability Sources"],
      summary: "List or search Gmail messages as the calling member",
      description: "Reads and searches inbox mail in the calling member's Gmail mailbox, using the Google account they connected through the org Google Workspace connection. Returns needs_connection when the member has not connected their Google account yet or the connection lacks Gmail read permission.",
      responses: {
        200: jsonResponse("Gmail messages returned.", gmailMessagesResponseSchema),
        401: jsonResponse("The caller must be signed in.", unauthorizedSchema),
        409: jsonResponse("The calling member has not connected their Google account or is missing permission.", needsConnectionSchema),
        502: jsonResponse("Google rejected the request.", upstreamErrorSchema),
      },
    }),
    orgMemberRoute(),
    queryValidator(gmailMessagesQuerySchema),
    async (c) => {
      const payload = c.get("organizationContext")
      const token = await googleWorkspaceToken({
        organizationId: payload.organization.id,
        orgMembershipId: payload.currentMember.id,
      })
      if (token.kind === "google_api_error") {
        return c.json({ error: "google_api_error", message: token.message }, 502)
      }
      if (token.kind === "needs_connection") {
        return c.json({ error: "needs_connection", message: token.message }, 409)
      }
      if (missingScope(token.account, [GMAIL_READ_SCOPE])) {
        return c.json({ error: "needs_connection", message: missingPermissionMessage("Gmail read") }, 409)
      }

      const query = c.req.valid("query")
      const listUrl = new URL(`${gmailApiBase()}/gmail/v1/users/me/messages`)
      if (query.q) listUrl.searchParams.set("q", query.q)
      listUrl.searchParams.set("maxResults", String(query.maxResults))

      const listResponse = await googleWorkspaceApiFetch(listUrl, {
        headers: { authorization: `Bearer ${token.accessToken}` },
      })
      if (!listResponse.ok) {
        return c.json(await googleApiError("Gmail messages list", listResponse), 502)
      }

      const ids = extractGmailMessageIds(await readJson(listResponse), 25)
      const messages: z.infer<typeof gmailMessageSummarySchema>[] = []
      for (const id of ids) {
        const messageUrl = new URL(`${gmailApiBase()}/gmail/v1/users/me/messages/${encodeURIComponent(id)}`)
        messageUrl.searchParams.set("format", "metadata")
        messageUrl.searchParams.append("metadataHeaders", "From")
        messageUrl.searchParams.append("metadataHeaders", "To")
        messageUrl.searchParams.append("metadataHeaders", "Subject")
        messageUrl.searchParams.append("metadataHeaders", "Date")
        const messageResponse = await googleWorkspaceApiFetch(messageUrl, {
          headers: { authorization: `Bearer ${token.accessToken}` },
        })
        if (!messageResponse.ok) {
          return c.json(await googleApiError("Gmail message metadata", messageResponse), 502)
        }
        const message = extractGmailMessage(await readJson(messageResponse))
        messages.push({
          id: message.id,
          threadId: message.threadId,
          from: message.from,
          to: message.to,
          subject: message.subject,
          date: message.date,
          snippet: message.snippet,
        })
      }

      return c.json({ ok: true, messages })
    },
  )

  // Singular by-id route segments keep structuralShorten from colliding with the plural list tool names.
  app.get(
    "/v1/capabilities/google-workspace/gmail-message/:messageId",
    describeRoute({
      tags: ["Capability Sources"],
      summary: "Read a Gmail message with its plain-text body as the calling member",
      description: "Reads one Gmail message, including decoded plain-text body content and attachment metadata, using the calling member's connected Google Workspace account. To download an attachment's bytes, pass its attachmentId to the gmail-attachment capability.",
      responses: {
        200: jsonResponse("Gmail message returned.", gmailMessageResponseSchema),
        401: jsonResponse("The caller must be signed in.", unauthorizedSchema),
        409: jsonResponse("The calling member has not connected their Google account or is missing permission.", needsConnectionSchema),
        502: jsonResponse("Google rejected the request.", upstreamErrorSchema),
      },
    }),
    orgMemberRoute(),
    paramValidator(gmailMessageParamSchema),
    async (c) => {
      const payload = c.get("organizationContext")
      const token = await googleWorkspaceToken({
        organizationId: payload.organization.id,
        orgMembershipId: payload.currentMember.id,
      })
      if (token.kind === "google_api_error") {
        return c.json({ error: "google_api_error", message: token.message }, 502)
      }
      if (token.kind === "needs_connection") {
        return c.json({ error: "needs_connection", message: token.message }, 409)
      }
      if (missingScope(token.account, [GMAIL_READ_SCOPE])) {
        return c.json({ error: "needs_connection", message: missingPermissionMessage("Gmail read") }, 409)
      }

      const { messageId } = c.req.valid("param")
      const messageUrl = new URL(`${gmailApiBase()}/gmail/v1/users/me/messages/${encodeURIComponent(messageId)}`)
      messageUrl.searchParams.set("format", "full")
      const response = await googleWorkspaceApiFetch(messageUrl, {
        headers: { authorization: `Bearer ${token.accessToken}` },
      })
      if (!response.ok) {
        return c.json(await googleApiError("Gmail message read", response), 502)
      }

      return c.json({ ok: true, message: extractGmailMessage(await readJson(response)) })
    },
  )

  app.get(
    "/v1/capabilities/google-workspace/gmail-attachment/:messageId/:attachmentId",
    describeRoute({
      tags: ["Capability Sources"],
      summary: "Download a Gmail attachment's bytes as the calling member",
      description: "Downloads one Gmail attachment (file) as base64-encoded bytes, using the messageId and the attachmentId from the gmail-message capability's attachments metadata. Decode dataBase64 locally to reconstruct the file, e.g. a PDF or spreadsheet, then extract its contents.",
      responses: {
        200: jsonResponse("Gmail attachment returned.", gmailAttachmentResponseSchema),
        401: jsonResponse("The caller must be signed in.", unauthorizedSchema),
        409: jsonResponse("The calling member has not connected their Google account or is missing permission.", needsConnectionSchema),
        502: jsonResponse("Google rejected the request.", upstreamErrorSchema),
      },
    }),
    orgMemberRoute(),
    paramValidator(gmailAttachmentParamSchema),
    async (c) => {
      const payload = c.get("organizationContext")
      const token = await googleWorkspaceToken({
        organizationId: payload.organization.id,
        orgMembershipId: payload.currentMember.id,
      })
      if (token.kind === "google_api_error") {
        return c.json({ error: "google_api_error", message: token.message }, 502)
      }
      if (token.kind === "needs_connection") {
        return c.json({ error: "needs_connection", message: token.message }, 409)
      }
      if (missingScope(token.account, [GMAIL_READ_SCOPE])) {
        return c.json({ error: "needs_connection", message: missingPermissionMessage("Gmail read") }, 409)
      }

      const { messageId, attachmentId } = c.req.valid("param")
      const url = new URL(`${gmailApiBase()}/gmail/v1/users/me/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(attachmentId)}`)
      const response = await googleWorkspaceApiFetch(url, {
        headers: { authorization: `Bearer ${token.accessToken}` },
      })
      if (!response.ok) {
        return c.json(await googleApiError("Gmail attachment download", response), 502)
      }

      const attachment = extractGmailAttachmentData(await readJson(response))
      if (!attachment) {
        return c.json({ error: "google_api_error", message: "Gmail attachment download returned no data." }, 502)
      }

      return c.json({ ok: true, messageId, attachmentId, size: attachment.size, dataBase64: attachment.dataBase64 })
    },
  )

  app.get(
    "/v1/capabilities/google-workspace/calendar-events",
    describeRoute({
      tags: ["Capability Sources"],
      summary: "List Google Calendar events in a time range as the calling member",
      description: "Lists primary-calendar events for the calling member in a requested ISO time range, using their connected Google Workspace account.",
      responses: {
        200: jsonResponse("Google Calendar events returned.", calendarEventsResponseSchema),
        401: jsonResponse("The caller must be signed in.", unauthorizedSchema),
        409: jsonResponse("The calling member has not connected their Google account or is missing permission.", needsConnectionSchema),
        502: jsonResponse("Google rejected the request.", upstreamErrorSchema),
      },
    }),
    orgMemberRoute(),
    queryValidator(calendarEventsQuerySchema),
    async (c) => {
      const payload = c.get("organizationContext")
      const token = await googleWorkspaceToken({
        organizationId: payload.organization.id,
        orgMembershipId: payload.currentMember.id,
      })
      if (token.kind === "google_api_error") {
        return c.json({ error: "google_api_error", message: token.message }, 502)
      }
      if (token.kind === "needs_connection") {
        return c.json({ error: "needs_connection", message: token.message }, 409)
      }
      if (missingScope(token.account, [CALENDAR_READ_SCOPE, CALENDAR_EVENTS_SCOPE])) {
        return c.json({ error: "needs_connection", message: missingPermissionMessage("Google Calendar read") }, 409)
      }

      const query = c.req.valid("query")
      const url = new URL(`${calendarApiBase()}/calendar/v3/calendars/primary/events`)
      url.searchParams.set("timeMin", query.timeMin)
      url.searchParams.set("timeMax", query.timeMax)
      url.searchParams.set("singleEvents", "true")
      url.searchParams.set("orderBy", "startTime")
      url.searchParams.set("maxResults", String(query.maxResults))

      const response = await googleWorkspaceApiFetch(url, {
        headers: { authorization: `Bearer ${token.accessToken}` },
      })
      if (!response.ok) {
        return c.json(await googleApiError("Google Calendar events list", response), 502)
      }

      return c.json({ ok: true, events: extractCalendarEvents(await readJson(response)) })
    },
  )

  app.post(
    "/v1/capabilities/google-workspace/calendar-events",
    describeRoute({
      tags: ["Capability Sources"],
      summary: "Create a Google Calendar event as the calling member",
      description: "Creates an event on the calling member's primary Google Calendar, using their connected Google Workspace account. Set createMeetLink to true to request a Google Meet conferencing link and return meetLink.",
      responses: {
        200: jsonResponse("Google Calendar event created.", createCalendarEventResponseSchema),
        401: jsonResponse("The caller must be signed in.", unauthorizedSchema),
        409: jsonResponse("The calling member has not connected their Google account or is missing permission.", needsConnectionSchema),
        502: jsonResponse("Google rejected the request.", upstreamErrorSchema),
      },
    }),
    orgMemberRoute(),
    jsonValidator(createCalendarEventBodySchema),
    async (c) => {
      const payload = c.get("organizationContext")
      const token = await googleWorkspaceToken({
        organizationId: payload.organization.id,
        orgMembershipId: payload.currentMember.id,
      })
      if (token.kind === "google_api_error") {
        return c.json({ error: "google_api_error", message: token.message }, 502)
      }
      if (token.kind === "needs_connection") {
        return c.json({ error: "needs_connection", message: token.message }, 409)
      }
      if (missingScope(token.account, [CALENDAR_EVENTS_SCOPE])) {
        return c.json({ error: "needs_connection", message: missingPermissionMessage("Google Calendar write") }, 409)
      }

      const input = c.req.valid("json")
      const url = new URL(`${calendarApiBase()}/calendar/v3/calendars/primary/events`)
      const eventPayload = buildCalendarEventPayload(input)
      if (input.createMeetLink) {
        url.searchParams.set("conferenceDataVersion", "1")
        eventPayload.conferenceData = buildCalendarConferenceData()
      }

      const response = await googleWorkspaceApiFetch(url, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token.accessToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(eventPayload),
      })
      if (!response.ok) {
        return c.json(await googleApiError("Google Calendar event create", response), 502)
      }

      const event = extractCalendarEvents({ items: [await readJson(response)] })[0]
      if (!event?.id) {
        return c.json({ error: "google_api_error", message: "Google Calendar returned no event id." }, 502)
      }

      return c.json({
        ok: true,
        eventId: event.id,
        htmlLink: event.htmlLink,
        summary: event.summary,
        start: event.start,
        end: event.end,
        meetLink: event.meetLink,
      })
    },
  )

  app.patch(
    "/v1/capabilities/google-workspace/calendar-event/:eventId",
    describeRoute({
      tags: ["Capability Sources"],
      summary: "Add a Google Meet link to a Calendar event",
      description: "Updates one primary-calendar event by id to request Google Meet conferencing, using the calling member's connected Google Workspace account. Use this for an existing event that needs a Meet link without creating a duplicate.",
      responses: {
        200: jsonResponse("Google Calendar event updated.", updateCalendarEventResponseSchema),
        401: jsonResponse("The caller must be signed in.", unauthorizedSchema),
        409: jsonResponse("The calling member has not connected their Google account or is missing permission.", needsConnectionSchema),
        502: jsonResponse("Google rejected the request.", upstreamErrorSchema),
      },
    }),
    orgMemberRoute(),
    paramValidator(calendarEventParamSchema),
    jsonValidator(updateCalendarEventBodySchema),
    async (c) => {
      const payload = c.get("organizationContext")
      const token = await googleWorkspaceToken({
        organizationId: payload.organization.id,
        orgMembershipId: payload.currentMember.id,
      })
      if (token.kind === "google_api_error") {
        return c.json({ error: "google_api_error", message: token.message }, 502)
      }
      if (token.kind === "needs_connection") {
        return c.json({ error: "needs_connection", message: token.message }, 409)
      }
      if (missingScope(token.account, [CALENDAR_EVENTS_SCOPE])) {
        return c.json({ error: "needs_connection", message: missingPermissionMessage("Google Calendar write") }, 409)
      }

      const { eventId } = c.req.valid("param")
      const url = new URL(`${calendarApiBase()}/calendar/v3/calendars/primary/events/${encodeURIComponent(eventId)}`)
      url.searchParams.set("conferenceDataVersion", "1")
      const response = await googleWorkspaceApiFetch(url, {
        method: "PATCH",
        headers: {
          authorization: `Bearer ${token.accessToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ conferenceData: buildCalendarConferenceData() }),
      })
      if (!response.ok) {
        return c.json(await googleApiError("Google Calendar event update", response), 502)
      }

      const event = extractCalendarEvents({ items: [await readJson(response)] })[0]
      if (!event?.id) {
        return c.json({ error: "google_api_error", message: "Google Calendar returned no event id." }, 502)
      }

      return c.json({
        ok: true,
        eventId: event.id,
        htmlLink: event.htmlLink,
        summary: event.summary,
        start: event.start,
        end: event.end,
        meetLink: event.meetLink,
      })
    },
  )

  app.get(
    "/v1/capabilities/google-workspace/drive-files",
    describeRoute({
      tags: ["Capability Sources"],
      summary: "Search Google Drive files as the calling member",
      description: "Searches the calling member's Google Drive files by name and full text, using their connected Google Workspace account.",
      responses: {
        200: jsonResponse("Google Drive files returned.", driveFilesResponseSchema),
        401: jsonResponse("The caller must be signed in.", unauthorizedSchema),
        409: jsonResponse("The calling member has not connected their Google account or is missing permission.", needsConnectionSchema),
        502: jsonResponse("Google rejected the request.", upstreamErrorSchema),
      },
    }),
    orgMemberRoute(),
    queryValidator(driveFilesQuerySchema),
    async (c) => {
      const payload = c.get("organizationContext")
      const token = await googleWorkspaceToken({
        organizationId: payload.organization.id,
        orgMembershipId: payload.currentMember.id,
      })
      if (token.kind === "google_api_error") {
        return c.json({ error: "google_api_error", message: token.message }, 502)
      }
      if (token.kind === "needs_connection") {
        return c.json({ error: "needs_connection", message: token.message }, 409)
      }
      if (missingScope(token.account, [DRIVE_READ_SCOPE, DRIVE_FULL_SCOPE, DRIVE_FILE_SCOPE])) {
        return c.json({ error: "needs_connection", message: missingPermissionMessage("Google Drive read") }, 409)
      }

      const query = c.req.valid("query")
      const url = new URL(`${driveApiBase()}/drive/v3/files`)
      url.searchParams.set("q", buildDriveSearchQuery(query.query))
      url.searchParams.set("pageSize", String(query.maxResults))
      url.searchParams.set("fields", "files(id,name,mimeType,modifiedTime,webViewLink,size)")

      const response = await googleWorkspaceApiFetch(url, {
        headers: { authorization: `Bearer ${token.accessToken}` },
      })
      if (!response.ok) {
        return c.json(await googleApiError("Google Drive files search", response), 502)
      }

      return c.json({ ok: true, files: extractDriveFiles(await readJson(response)) })
    },
  )

  app.post(
    "/v1/capabilities/google-workspace/drive-files",
    describeRoute({
      tags: ["Capability Sources"],
      summary: "Upload file bytes to Google Drive as the calling member",
      description: "Creates a file in the calling member's Google Drive using standard base64 bytes. The gmail-attachment capability returns dataBase64 in this exact encoding — pass it through directly to save an email attachment to Drive. The response file.webViewLink is the user-facing link — share it with the user.",
      responses: {
        200: jsonResponse("Google Drive file uploaded. The file.webViewLink is the user-facing link — share it with the user.", uploadDriveFileResponseSchema),
        400: jsonResponse("The upload request was invalid.", invalidRequestSchema),
        401: jsonResponse("The caller must be signed in.", unauthorizedSchema),
        409: jsonResponse("The calling member has not connected their Google account or is missing permission.", needsConnectionSchema),
        502: jsonResponse("Google rejected the request.", upstreamErrorSchema),
      },
    }),
    orgMemberRoute(),
    jsonValidator(uploadDriveFileBodySchema),
    async (c) => {
      const payload = c.get("organizationContext")
      const token = await googleWorkspaceToken({
        organizationId: payload.organization.id,
        orgMembershipId: payload.currentMember.id,
      })
      if (token.kind === "google_api_error") {
        return c.json({ error: "google_api_error", message: token.message }, 502)
      }
      if (token.kind === "needs_connection") {
        return c.json({ error: "needs_connection", message: token.message }, 409)
      }
      if (missingScope(token.account, [DRIVE_FILE_SCOPE, DRIVE_FULL_SCOPE])) {
        return c.json({ error: "needs_connection", message: missingPermissionMessage("Google Drive write") }, 409)
      }

      const input = c.req.valid("json")
      const metadata: { name: string; parents?: string[] } = { name: input.filename }
      if (input.folderId) {
        metadata.parents = [input.folderId]
      }
      const boundary = `openwork-${randomUUID()}`
      const url = new URL(`${driveApiBase()}/upload/drive/v3/files`)
      url.searchParams.set("uploadType", "multipart")
      url.searchParams.set("fields", "id,name,mimeType,modifiedTime,webViewLink,size")
      const uploadBody = buildDriveMultipartUpload({
        metadata,
        content: Buffer.from(input.dataBase64, "base64"),
        mimeType: input.mimeType,
        boundary,
      })
      const uploadBodyBytes = new Uint8Array(uploadBody.byteLength)
      uploadBodyBytes.set(uploadBody)
      const response = await googleWorkspaceApiFetch(url, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token.accessToken}`,
          "content-type": `multipart/related; boundary=${boundary}`,
        },
        body: uploadBodyBytes,
      })
      if (!response.ok) {
        return c.json(await googleApiError("Google Drive file upload", response), 502)
      }

      const file = extractDriveFiles({ files: [await readJson(response)] })[0]
      if (!file?.id) {
        return c.json({ error: "google_api_error", message: "Google Drive returned no file id." }, 502)
      }

      return c.json({ ok: true, file })
    },
  )

  app.get(
    "/v1/capabilities/google-workspace/drive-file/:fileId",
    describeRoute({
      tags: ["Capability Sources"],
      summary: "Read a Google Drive file's text content as the calling member",
      description: "Reads text from one Google Drive file, exporting Google Docs editors files as plain text and downloading other files as UTF-8 text with truncation.",
      responses: {
        200: jsonResponse("Google Drive file returned.", driveFileResponseSchema),
        401: jsonResponse("The caller must be signed in.", unauthorizedSchema),
        409: jsonResponse("The calling member has not connected their Google account or is missing permission.", needsConnectionSchema),
        502: jsonResponse("Google rejected the request.", upstreamErrorSchema),
      },
    }),
    orgMemberRoute(),
    paramValidator(driveFileParamSchema),
    async (c) => {
      const payload = c.get("organizationContext")
      const token = await googleWorkspaceToken({
        organizationId: payload.organization.id,
        orgMembershipId: payload.currentMember.id,
      })
      if (token.kind === "google_api_error") {
        return c.json({ error: "google_api_error", message: token.message }, 502)
      }
      if (token.kind === "needs_connection") {
        return c.json({ error: "needs_connection", message: token.message }, 409)
      }
      if (missingScope(token.account, [DRIVE_READ_SCOPE, DRIVE_FULL_SCOPE, DRIVE_FILE_SCOPE])) {
        return c.json({ error: "needs_connection", message: missingPermissionMessage("Google Drive read") }, 409)
      }

      const { fileId } = c.req.valid("param")
      const metadataUrl = new URL(`${driveApiBase()}/drive/v3/files/${encodeURIComponent(fileId)}`)
      metadataUrl.searchParams.set("fields", "id,name,mimeType,modifiedTime,webViewLink,size")
      const metadataResponse = await googleWorkspaceApiFetch(metadataUrl, {
        headers: { authorization: `Bearer ${token.accessToken}` },
      })
      if (!metadataResponse.ok) {
        return c.json(await googleApiError("Google Drive file metadata", metadataResponse), 502)
      }

      const file = extractDriveFiles({ files: [await readJson(metadataResponse)] })[0]
      if (!file?.id) {
        return c.json({ error: "google_api_error", message: "Google Drive returned no file id." }, 502)
      }

      const contentUrl = file.mimeType.startsWith("application/vnd.google-apps")
        ? new URL(`${driveApiBase()}/drive/v3/files/${encodeURIComponent(fileId)}/export`)
        : new URL(`${driveApiBase()}/drive/v3/files/${encodeURIComponent(fileId)}`)
      if (file.mimeType.startsWith("application/vnd.google-apps")) {
        contentUrl.searchParams.set("mimeType", "text/plain")
      } else {
        contentUrl.searchParams.set("alt", "media")
      }

      const contentResponse = await googleWorkspaceApiFetch(contentUrl, {
        headers: { authorization: `Bearer ${token.accessToken}` },
      })
      if (!contentResponse.ok) {
        return c.json(await googleApiError("Google Drive file content", contentResponse), 502)
      }

      const content = truncateText(await contentResponse.text(), 200_000)
      return c.json({
        ok: true,
        file: {
          ...file,
          content: content.text,
          truncated: content.truncated,
        },
      })
    },
  )

  app.post(
    "/v1/capabilities/google-workspace/drive-file-share/:fileId",
    describeRoute({
      tags: ["Capability Sources"],
      summary: "Share a Google Drive file with a person or the organization",
      description: "Creates a Drive permission for one file using the calling member's Google Workspace account. To share with one person pass type=user plus emailAddress; to share with the entire organization pass type=domain plus the org's Google Workspace domain (e.g. openworklabs.com). Sharing files not created through OpenWork needs the Full Drive access feature enabled by an admin.",
      responses: {
        200: jsonResponse("Google Drive file shared.", shareDriveFileResponseSchema),
        400: jsonResponse("The share request was invalid.", invalidRequestSchema),
        401: jsonResponse("The caller must be signed in.", unauthorizedSchema),
        409: jsonResponse("The calling member has not connected their Google account or is missing permission.", needsConnectionSchema),
        502: jsonResponse("Google rejected the request.", upstreamErrorSchema),
      },
    }),
    orgMemberRoute(),
    paramValidator(driveFileParamSchema),
    jsonValidator(shareDriveFileBodySchema),
    async (c) => {
      const payload = c.get("organizationContext")
      const token = await googleWorkspaceToken({
        organizationId: payload.organization.id,
        orgMembershipId: payload.currentMember.id,
      })
      if (token.kind === "google_api_error") {
        return c.json({ error: "google_api_error", message: token.message }, 502)
      }
      if (token.kind === "needs_connection") {
        return c.json({ error: "needs_connection", message: token.message }, 409)
      }
      if (missingScope(token.account, [DRIVE_FILE_SCOPE, DRIVE_FULL_SCOPE])) {
        return c.json({ error: "needs_connection", message: missingPermissionMessage("Google Drive write") }, 409)
      }

      const { fileId } = c.req.valid("param")
      const input = c.req.valid("json")
      const permissionPayload = input.type === "user" && input.emailAddress
        ? { type: input.type, role: input.role, emailAddress: input.emailAddress }
        : input.type === "domain" && input.domain
          ? { type: input.type, role: input.role, domain: input.domain }
          : null
      if (!permissionPayload) {
        return c.json({ error: "invalid_request", details: "emailAddress is required for user shares and domain is required for domain shares." }, 400)
      }

      const url = new URL(`${driveApiBase()}/drive/v3/files/${encodeURIComponent(fileId)}/permissions`)
      url.searchParams.set("sendNotificationEmail", String(input.sendNotificationEmail))
      url.searchParams.set("fields", "id,type,role")
      const response = await googleWorkspaceApiFetch(url, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token.accessToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(permissionPayload),
      })
      if (!response.ok) {
        return c.json(await googleApiError("Google Drive file share", response), 502)
      }

      const permission = extractDrivePermission(await readJson(response))
      if (!permission.id) {
        return c.json({ error: "google_api_error", message: "Google Drive returned no permission id." }, 502)
      }

      return c.json({ ok: true, fileId, permissionId: permission.id, type: permission.type, role: permission.role })
    },
  )

  app.post(
    "/v1/capabilities/google-workspace/gmail-drafts",
    describeRoute({
      tags: ["Capability Sources"],
      summary: "Create a Gmail draft or threaded reply draft; attach workspace files with body.attachments: [{ filename, mimeType, dataBase64 }], where dataBase64 is each attachment's file bytes encoded as standard base64",
      description: "Creates a plain-text Gmail draft in the calling member own mailbox, with optional Cc/Bcc recipients and files read from the active workspace. Set threadId to attach the draft to an existing Gmail thread as a reply using the thread's matching subject; threadId is required for replies and forwards. For threaded drafts, OpenWork appends the quoted conversation automatically. Always share the returned draftUrl with the user because it opens the ready-to-send draft in Gmail for review and send. Returns needs_connection when the member has not connected their Google account yet or when a threaded reply needs Gmail read permission.",
      responses: {
        200: jsonResponse("Draft created.", createDraftResponseSchema),
        400: jsonResponse("The draft request was invalid.", z.union([invalidRequestSchema, missingThreadIdSchema])),
        401: jsonResponse("The caller must be signed in.", unauthorizedSchema),
        409: jsonResponse("The calling member has not connected their Google account or is missing permission.", needsConnectionSchema),
        502: jsonResponse("Google rejected the request.", upstreamErrorSchema),
      },
    }),
    orgMemberRoute(),
    jsonValidator(createDraftBodySchema),
    async (c) => {
      const { to, cc, bcc, subject, body, threadId, attachments: attachmentInputs } = c.req.valid("json")
      if (!threadId && GMAIL_REPLY_SUBJECT_RE.test(subject)) {
        return c.json({
          error: "missing_thread_id",
          message: "Subject looks like a reply but threadId is missing. Fetch the thread with the gmail-messages capability and pass threadId so the draft stays on the conversation. Only omit threadId for brand-new emails.",
        }, 400)
      }

      const payload = c.get("organizationContext")
      const token = await googleWorkspaceToken({
        organizationId: payload.organization.id,
        orgMembershipId: payload.currentMember.id,
      })
      if (token.kind === "google_api_error") {
        return c.json({ error: "google_api_error", message: token.message }, 502)
      }
      if (token.kind === "needs_connection") {
        return c.json({ error: "needs_connection", message: token.message }, 409)
      }

      const attachments: GmailDraftAttachment[] = (attachmentInputs ?? []).map((attachment) => ({
        filename: attachment.filename,
        mimeType: attachment.mimeType,
        content: Buffer.from(attachment.dataBase64, "base64"),
      }))
      const headers: { name: string; value: string }[] = []
      let draftBody = body
      let quotedHistoryIncluded = false
      if (threadId) {
        if (missingScope(token.account, [GMAIL_READ_SCOPE])) {
          return c.json({ error: "needs_connection", message: missingPermissionMessage("Gmail read") }, 409)
        }

        const threadUrl = new URL(`${gmailApiBase()}/gmail/v1/users/me/threads/${encodeURIComponent(threadId)}`)
        threadUrl.searchParams.set("format", "full")
        const threadResponse = await googleWorkspaceApiFetch(threadUrl, {
          headers: { authorization: `Bearer ${token.accessToken}` },
        })
        if (!threadResponse.ok) {
          return c.json(await googleApiError("Gmail thread read", threadResponse), 502)
        }

        const thread = await readJson(threadResponse)
        const replyContext = extractGmailThreadReplyContext(thread)
        if (!replyContext) {
          return c.json({ error: "google_api_error", message: "Gmail thread has no Message-ID metadata; cannot build a threaded reply draft." }, 502)
        }
        headers.push(
          { name: "In-Reply-To", value: replyContext.lastMessageId },
          { name: "References", value: replyContext.references },
        )

        if (gmailBodyHasQuotedHistory(body)) {
          quotedHistoryIncluded = true
        } else {
          const quote = extractGmailThreadQuoteInput(thread)
          if (quote) {
            draftBody = `${body}\n\n${buildGmailQuoteBlock(quote)}`
            quotedHistoryIncluded = true
          }
        }
      }

      const message: { raw: string; threadId?: string } = { raw: buildGmailDraftRaw({ to, cc, bcc, subject, body: draftBody, headers, attachments }) }
      if (threadId) {
        message.threadId = threadId
      }
      const response = await googleWorkspaceApiFetch(`${gmailApiBase()}/gmail/v1/users/me/drafts`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token.accessToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ message }),
      })
      const text = await response.text()
      if (!response.ok) {
        return c.json({ error: "google_api_error", message: `Gmail draft create failed: ${response.status} ${text.slice(0, 300)}` }, 502)
      }

      const { draftId, messageId } = readGmailDraftIds(text)
      if (!draftId) {
        return c.json({ error: "google_api_error", message: "Gmail returned no draft id." }, 502)
      }

      const result = {
        ok: true,
        draftId,
        messageId,
        draftUrl: gmailDraftUrl(messageId),
        threadUrl: gmailThreadUrl(threadId),
        to,
        subject,
        threadId: threadId ?? null,
        quotedHistoryIncluded,
      }
      if (attachments.length === 0) {
        return c.json(result)
      }
      return c.json({
        ...result,
        attachments: attachments.map((attachment) => ({
          filename: attachment.filename,
          mimeType: attachment.mimeType,
          size: attachment.content.byteLength,
        })),
      })
    },
  )
}
