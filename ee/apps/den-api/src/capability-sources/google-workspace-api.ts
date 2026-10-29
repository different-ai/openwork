import { truncateText } from "./binary-content.js"
import { Parser } from "htmlparser2"
import { sanitizeGmailQuoteHtml, type GmailDraftQuote } from "./gmail.js"

export { truncateText } from "./binary-content.js"

export type GoogleWorkspaceAttachment = {
  attachmentId: string
  filename: string
  mimeType: string
  size: number | null
}

export type GoogleWorkspaceAttachmentData = {
  size: number
  dataBase64: string
}

export type GoogleWorkspaceGmailMessage = {
  id: string
  threadId: string
  from: string
  to: string
  bcc: string
  subject: string
  date: string
  snippet: string
  body: string
  attachments: GoogleWorkspaceAttachment[]
}

export type GoogleWorkspaceCalendarEvent = {
  id: string
  summary: string
  description: string
  location: string
  start: string
  end: string
  status: string
  htmlLink: string
  attendees: string[]
  meetLink: string | null
}

export type GoogleWorkspaceDriveFile = {
  id: string
  name: string
  mimeType: string
  modifiedTime: string
  webViewLink: string
  size: string | null
}

export type GoogleWorkspaceDriveUploadMetadata = {
  name: string
  parents?: string[]
}

export type GoogleWorkspaceDrivePermission = {
  id: string
  type: string
  role: string
}

type GmailBodyState = {
  plain: string | null
  html: string | null
  htmlSource?: string
  attachments: GoogleWorkspaceAttachment[]
}

const GMAIL_QUOTE_BODY_LIMIT = 10_000
const GMAIL_HTML_INPUT_BYTE_LIMIT = 1_000_000
const GMAIL_MESSAGE_BODY_LIMIT = 100_000
const HTML_BLOCK_ELEMENTS = new Set(["div", "p", "blockquote", "section", "article", "header", "footer", "address", "pre", "ul", "ol", "li", "table", "tr", "h1", "h2", "h3", "h4", "h5", "h6"])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function readRecord(record: Record<string, unknown>, key: string): Record<string, unknown> | null {
  const value = record[key]
  return isRecord(value) ? value : null
}

function readArray(record: Record<string, unknown>, key: string): unknown[] {
  const value = record[key]
  return Array.isArray(value) ? value : []
}

function readString(record: Record<string, unknown>, key: string): string {
  const value = record[key]
  return typeof value === "string" ? value : ""
}

function readNumber(record: Record<string, unknown>, key: string): number | null {
  const value = record[key]
  return typeof value === "number" && Number.isFinite(value) ? value : null
}

function decodeBase64Url(value: string, byteLimit?: number): string {
  try {
    const encoded = byteLimit === undefined ? value : value.slice(0, Math.floor(byteLimit / 3) * 4)
    return Buffer.from(encoded, "base64url").toString("utf8")
  } catch {
    return ""
  }
}

function withoutDeclaredHtmlEntities(value: string): string {
  const lower = value.toLowerCase()
  const declaration = lower.indexOf("<!entity")
  if (declaration === -1) return value
  const end = lower.indexOf("]>", declaration)
  return end === -1 ? "" : value.slice(end + 2)
}

function htmlToPlainText(value: string, preserveBlocks = false): string {
  let text = ""
  let omittedDepth = 0
  const parser = new Parser({
    onopentag(name) {
      if (omittedDepth > 0) {
        omittedDepth += 1
      } else if (name === "script" || name === "style") {
        text += " "
        omittedDepth = 1
      } else {
        text += name === "br" || (preserveBlocks && HTML_BLOCK_ELEMENTS.has(name)) ? "\n" : " "
      }
    },
    ontext(content) {
      if (omittedDepth === 0) text += content
    },
    onclosetag(name) {
      if (omittedDepth > 0) {
        omittedDepth -= 1
        if (omittedDepth === 0) text += " "
      } else {
        text += name === "p" || (preserveBlocks && HTML_BLOCK_ELEMENTS.has(name)) ? "\n" : " "
      }
    },
  }, { decodeEntities: true })
  parser.end(withoutDeclaredHtmlEntities(value))
  return text
    .replaceAll("\u00a0", " ")
    .replace(/[ \t\f\v]+/g, " ")
    .replace(/\n\s+/g, "\n")
    .trim()
}

function collectGmailPart(part: Record<string, unknown>, state: GmailBodyState) {
  const mimeType = readString(part, "mimeType")
  const filename = readString(part, "filename")
  const body = readRecord(part, "body")
  if (body) {
    const attachmentId = readString(body, "attachmentId")
    if (filename && attachmentId) {
      state.attachments.push({
        attachmentId,
        filename,
        mimeType,
        size: readNumber(body, "size"),
      })
    }

    const data = readString(body, "data")
    if (data && mimeType === "text/plain" && state.plain === null) {
      state.plain = decodeBase64Url(data)
    }
    if (data && mimeType === "text/html" && state.html === null) {
      state.htmlSource = decodeBase64Url(data, GMAIL_HTML_INPUT_BYTE_LIMIT)
      state.html = htmlToPlainText(state.htmlSource)
    }
  }

  for (const child of readArray(part, "parts")) {
    if (isRecord(child)) {
      collectGmailPart(child, state)
    }
  }
}

function readGmailHeaders(payload: Record<string, unknown>) {
  const headers = new Map<string, string>()
  for (const header of readArray(payload, "headers")) {
    if (!isRecord(header)) continue
    const name = readString(header, "name").toLowerCase()
    const value = readString(header, "value")
    if (name && value) {
      headers.set(name, value)
    }
  }
  return headers
}

function lastNonDraftGmailMessage(json: unknown): unknown {
  const root = isRecord(json) ? json : {}
  return readArray(root, "messages").slice().reverse().find((message) => isRecord(message) && !readArray(message, "labelIds").includes("DRAFT"))
}

export function extractGmailThreadReplyContext(json: unknown): { lastMessageId: string; references: string } | null {
  const lastMessage = lastNonDraftGmailMessage(json)
  if (!isRecord(lastMessage)) return null

  const payload = readRecord(lastMessage, "payload")
  if (!payload) return null

  const headers = readGmailHeaders(payload)
  const lastMessageId = headers.get("message-id")?.trim() ?? ""
  if (!lastMessageId) return null

  const references = `${headers.get("references")?.trim() ?? ""} ${lastMessageId}`.trim()
  return { lastMessageId, references }
}

function formatGmailQuoteDate(value: string, timeZone?: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  // RFC 5322 dates carry their own offset. Never default to the server's zone.
  // Intl accepts fixed offsets as well as IANA zones on the shipping Node runtime.
  const offset = value.match(/([+-]\d{2})(\d{2})(?:\s*\([^)]*\))?\s*$/)
  const obsoleteZone = value.match(/\b(UT|GMT|[ECMP][SD]T)\s*$/i)?.[1]?.toUpperCase()
  const namedOffsets: Record<string, string> = { UT: "+00:00", GMT: "+00:00", EST: "-05:00", EDT: "-04:00", CST: "-06:00", CDT: "-05:00", MST: "-07:00", MDT: "-06:00", PST: "-08:00", PDT: "-07:00" }
  const zone = timeZone ?? (offset ? `${offset[1]}:${offset[2]}` : namedOffsets[obsoleteZone ?? ""])
  if (!zone) return value
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: zone, weekday: "short", month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit", hour12: true,
  })
  const parts = new Map(formatter.formatToParts(date).map((part) => [part.type, part.value]))
  return `${parts.get("weekday")}, ${parts.get("month")} ${parts.get("day")}, ${parts.get("year")} at ${parts.get("hour")}:${parts.get("minute")} ${parts.get("dayPeriod")}`
}

function escapeQuoteHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")
}

export function gmailBodyHasQuotedHistory(body: string): boolean {
  return /^>\s?/m.test(body) && /^.*wrote:\s*$/m.test(body)
}

export function buildGmailQuote(input: { from: string; date: string; body: string; html?: string; timeZone?: string }): GmailDraftQuote {
  const mailbox = input.from.match(/^\s*(.*?)\s*<([^<>\s]+@[^<>\s]+)>\s*$/)
  const name = mailbox?.[1]?.replace(/^"(.*)"$/, "$1")
  const email = mailbox?.[2] ?? (/^[^<>\s]+@[^<>\s]+$/.test(input.from) ? input.from : undefined)
  const sender = email ? `${name ? `${name} ` : ""}<${email}>` : input.from
  const senderHtml = email ? `${name ? `${escapeQuoteHtml(name)} ` : ""}&lt;<a href="mailto:${escapeQuoteHtml(email)}">${escapeQuoteHtml(email)}</a>&gt;` : escapeQuoteHtml(sender)
  const date = input.date ? formatGmailQuoteDate(input.date, input.timeZone) : ""
  const prefix = date ? `On ${date} ` : ""
  const attribution = sender ? `${prefix}${sender} wrote:` : "Original message:"
  const attributionHtml = sender ? `${escapeQuoteHtml(prefix)}${senderHtml} wrote:` : "Original message:"
  const truncated = input.body.length > GMAIL_QUOTE_BODY_LIMIT
  const body = input.body.slice(0, GMAIL_QUOTE_BODY_LIMIT).replace(/\r\n?/g, "\n")
  // Sanitize before cutting, then parse the cut fragment again to close any open
  // elements. An oversized original must not swallow the rest of the draft.
  const safeHtml = input.html ? sanitizeGmailQuoteHtml(input.html) || undefined : undefined
  const html = safeHtml === undefined ? undefined : sanitizeGmailQuoteHtml(safeHtml.slice(0, GMAIL_QUOTE_BODY_LIMIT)) + (safeHtml.length > GMAIL_QUOTE_BODY_LIMIT ? "<div>[message trimmed]</div>" : "")
  return { attribution, attributionHtml, body: truncated ? `${body}\n[message trimmed]` : body, html }
}

export function extractGmailThreadQuoteInput(json: unknown): { from: string; date: string; body: string; html?: string } | null {
  const lastMessage = lastNonDraftGmailMessage(json)
  if (!isRecord(lastMessage)) return null

  const payload = readRecord(lastMessage, "payload")
  if (!payload) return null

  const headers = readGmailHeaders(payload)
  const state: GmailBodyState = { plain: null, html: null, attachments: [] }
  collectGmailPart(payload, state)
  const html = state.htmlSource ? sanitizeGmailQuoteHtml(state.htmlSource) : undefined
  const body = state.plain || (html ? htmlToPlainText(html, true) : "")
  if (!body && !html) return null

  return {
    from: headers.get("from") ?? "",
    date: headers.get("date") ?? "",
    body,
    html,
  }
}

export function buildDriveSearchQuery(text: string): string {
  const escaped = text.replace(/\\/g, "\\\\").replace(/'/g, "\\'")
  return `trashed = false and (name contains '${escaped}' or fullText contains '${escaped}')`
}

export function buildDriveMultipartUpload(input: { metadata: GoogleWorkspaceDriveUploadMetadata; content: Buffer; mimeType: string; boundary: string }): Buffer {
  const metadataPart = Buffer.from(`--${input.boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(input.metadata)}\r\n`, "utf8")
  const contentHeader = Buffer.from(`--${input.boundary}\r\nContent-Type: ${input.mimeType}\r\n\r\n`, "utf8")
  const footer = Buffer.from(`\r\n--${input.boundary}--\r\n`, "utf8")
  const body = Buffer.alloc(metadataPart.byteLength + contentHeader.byteLength + input.content.byteLength + footer.byteLength)
  let offset = 0
  for (const chunk of [metadataPart, contentHeader, input.content, footer]) {
    for (let index = 0; index < chunk.byteLength; index += 1) {
      const byte = chunk[index]
      if (byte !== undefined) {
        body[offset + index] = byte
      }
    }
    offset += chunk.byteLength
  }
  return body
}

export function extractGmailMessage(payloadJson: unknown): GoogleWorkspaceGmailMessage {
  const message = isRecord(payloadJson) ? payloadJson : {}
  const payload = readRecord(message, "payload") ?? {}
  const headers = readGmailHeaders(payload)
  const state: GmailBodyState = { plain: null, html: null, attachments: [] }
  collectGmailPart(payload, state)
  const snippet = readString(message, "snippet")
  const body = truncateText(state.plain ?? state.html ?? snippet, GMAIL_MESSAGE_BODY_LIMIT).text

  return {
    id: readString(message, "id"),
    threadId: readString(message, "threadId"),
    from: headers.get("from") ?? "",
    to: headers.get("to") ?? "",
    bcc: headers.get("bcc") ?? "",
    subject: headers.get("subject") ?? "",
    date: headers.get("date") ?? "",
    snippet,
    body,
    attachments: state.attachments,
  }
}

/**
 * Gmail's attachments.get returns base64url data. Normalize to standard
 * base64 so callers can decode the bytes locally with any base64 decoder.
 */
export function extractGmailAttachmentData(json: unknown): GoogleWorkspaceAttachmentData | null {
  const root = isRecord(json) ? json : {}
  const data = readString(root, "data")
  if (!data) return null
  const bytes = Buffer.from(data, "base64url")
  return {
    size: readNumber(root, "size") ?? bytes.byteLength,
    dataBase64: bytes.toString("base64"),
  }
}

export function extractGmailMessageIds(json: unknown, limit: number): string[] {
  const root = isRecord(json) ? json : {}
  const ids: string[] = []
  for (const item of readArray(root, "messages")) {
    if (!isRecord(item)) continue
    const id = readString(item, "id")
    if (!id) continue
    ids.push(id)
    if (ids.length >= limit) break
  }
  return ids
}

function calendarEventTime(event: Record<string, unknown>, key: string): string {
  const time = readRecord(event, key)
  if (!time) return ""
  const dateTime = readString(time, "dateTime")
  if (dateTime) return dateTime
  return readString(time, "date")
}

function calendarEventMeetLink(event: Record<string, unknown>): string | null {
  const hangoutLink = readString(event, "hangoutLink")
  if (hangoutLink) return hangoutLink

  const conferenceData = readRecord(event, "conferenceData")
  if (!conferenceData) return null

  for (const entryPoint of readArray(conferenceData, "entryPoints")) {
    if (!isRecord(entryPoint)) continue
    if (readString(entryPoint, "entryPointType") !== "video") continue
    const uri = readString(entryPoint, "uri")
    if (uri) return uri
  }
  return null
}

export function extractCalendarEvents(json: unknown): GoogleWorkspaceCalendarEvent[] {
  const root = isRecord(json) ? json : {}
  const events: GoogleWorkspaceCalendarEvent[] = []
  for (const item of readArray(root, "items")) {
    if (!isRecord(item)) continue
    const attendees: string[] = []
    for (const attendee of readArray(item, "attendees")) {
      if (!isRecord(attendee)) continue
      const email = readString(attendee, "email")
      if (email) attendees.push(email)
    }
    events.push({
      id: readString(item, "id"),
      summary: readString(item, "summary"),
      description: readString(item, "description"),
      location: readString(item, "location"),
      start: calendarEventTime(item, "start"),
      end: calendarEventTime(item, "end"),
      status: readString(item, "status"),
      htmlLink: readString(item, "htmlLink"),
      attendees,
      meetLink: calendarEventMeetLink(item),
    })
  }
  return events
}

export function extractDriveFiles(json: unknown): GoogleWorkspaceDriveFile[] {
  const root = isRecord(json) ? json : {}
  const files: GoogleWorkspaceDriveFile[] = []
  for (const item of readArray(root, "files")) {
    if (!isRecord(item)) continue
    const size = readString(item, "size")
    files.push({
      id: readString(item, "id"),
      name: readString(item, "name"),
      mimeType: readString(item, "mimeType"),
      modifiedTime: readString(item, "modifiedTime"),
      webViewLink: readString(item, "webViewLink"),
      size: size || null,
    })
  }
  return files
}

export function extractDrivePermission(json: unknown): GoogleWorkspaceDrivePermission {
  const root = isRecord(json) ? json : {}
  return {
    id: readString(root, "id"),
    type: readString(root, "type"),
    role: readString(root, "role"),
  }
}
