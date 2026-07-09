export type GoogleWorkspaceAttachment = {
  attachmentId: string
  filename: string
  mimeType: string
  size: number | null
}

export type GoogleWorkspaceGmailMessage = {
  id: string
  threadId: string
  from: string
  to: string
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

type GmailBodyState = {
  plain: string | null
  html: string | null
  attachments: GoogleWorkspaceAttachment[]
}

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

function decodeBase64Url(value: string): string {
  try {
    return Buffer.from(value, "base64url").toString("utf8")
  } catch {
    return ""
  }
}

function stripHtml(value: string): string {
  return value
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'")
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
      state.html = stripHtml(decodeBase64Url(data))
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

export function truncateText(text: string, maxCharacters: number): { text: string; truncated: boolean } {
  if (text.length <= maxCharacters) {
    return { text, truncated: false }
  }
  return { text: text.slice(0, maxCharacters), truncated: true }
}

export function buildDriveSearchQuery(text: string): string {
  const escaped = text.replace(/\\/g, "\\\\").replace(/'/g, "\\'")
  return `trashed = false and (name contains '${escaped}' or fullText contains '${escaped}')`
}

export function extractGmailMessage(payloadJson: unknown): GoogleWorkspaceGmailMessage {
  const message = isRecord(payloadJson) ? payloadJson : {}
  const payload = readRecord(message, "payload") ?? {}
  const headers = readGmailHeaders(payload)
  const state: GmailBodyState = { plain: null, html: null, attachments: [] }
  collectGmailPart(payload, state)
  const snippet = readString(message, "snippet")
  const body = truncateText(state.plain ?? state.html ?? snippet, 100_000).text

  return {
    id: readString(message, "id"),
    threadId: readString(message, "threadId"),
    from: headers.get("from") ?? "",
    to: headers.get("to") ?? "",
    subject: headers.get("subject") ?? "",
    date: headers.get("date") ?? "",
    snippet,
    body,
    attachments: state.attachments,
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
