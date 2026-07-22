const DEFAULT_GRAPH_BASE_URL = "https://graph.microsoft.com/v1.0"
const DEFAULT_TIMEOUT_MS = 30_000
const DEFAULT_MAX_DOWNLOAD_BYTES = 5_000_000
const DEFAULT_MAX_JSON_RESPONSE_BYTES = 5_000_000
const DEFAULT_MAX_CONTENT_CHARACTERS = 200_000

export type Microsoft365EmailAddress = {
  name: string
  address: string
}

export type Microsoft365MailMessageSummary = {
  id: string
  conversationId: string
  subject: string
  receivedDateTime: string
  preview: string
  from: Microsoft365EmailAddress | null
  to: Microsoft365EmailAddress[]
  webLink: string
  hasAttachments: boolean
}

export type Microsoft365MailMessage = Microsoft365MailMessageSummary & {
  cc: Microsoft365EmailAddress[]
  body: string
  bodyContentType: string
  bodyTruncated: boolean
}

export type Microsoft365CalendarEvent = {
  id: string
  subject: string
  preview: string
  start: string
  startTimeZone: string
  end: string
  endTimeZone: string
  isAllDay: boolean
  location: string
  organizer: Microsoft365EmailAddress | null
  attendees: Microsoft365EmailAddress[]
  webLink: string
  onlineMeetingUrl: string | null
}

export type Microsoft365DriveItem = {
  id: string
  name: string
  size: number | null
  modifiedTime: string
  webUrl: string
  mimeType: string
  kind: "file" | "folder" | "unknown"
}

export type Microsoft365DriveItemWithContent = Microsoft365DriveItem & {
  content: string | null
  contentType: string | null
  truncated: boolean
  contentUnavailableReason: "folder" | "file_too_large" | "unsupported_content_type" | null
}

export type Microsoft365TeamsChat = {
  id: string
  topic: string
  chatType: string
  webUrl: string
  lastUpdatedDateTime: string
}

export type Microsoft365TeamsMessage = {
  id: string
  createdDateTime: string
  content: string
  from: Microsoft365EmailAddress | null
  webUrl: string
}

type MicrosoftGraphClientOptions = {
  accessToken: string
  baseUrl?: string
  fetch?: typeof fetch
  timeoutMs?: number
  maxDownloadBytes?: number
  maxJsonResponseBytes?: number
  maxContentCharacters?: number
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

function readBoolean(record: Record<string, unknown>, key: string): boolean {
  return record[key] === true
}

function readNumber(record: Record<string, unknown>, key: string): number | null {
  const value = record[key]
  return typeof value === "number" && Number.isFinite(value) ? value : null
}

function readEmailAddress(value: unknown): Microsoft365EmailAddress | null {
  if (!isRecord(value)) return null
  const emailAddress = readRecord(value, "emailAddress")
  if (!emailAddress) return null
  const address = readString(emailAddress, "address")
  if (!address) return null
  return { name: readString(emailAddress, "name"), address }
}

function readEmailAddresses(record: Record<string, unknown>, key: string): Microsoft365EmailAddress[] {
  const addresses: Microsoft365EmailAddress[] = []
  for (const value of readArray(record, key)) {
    const address = readEmailAddress(value)
    if (address) addresses.push(address)
  }
  return addresses
}

function truncateText(text: string, maxCharacters: number): { text: string; truncated: boolean } {
  if (text.length <= maxCharacters) {
    return { text, truncated: false }
  }
  return { text: text.slice(0, maxCharacters), truncated: true }
}

async function readTextWithByteLimit(response: Response, maxBytes: number): Promise<{ text: string; limitExceeded: boolean }> {
  if (!response.body) return { text: "", limitExceeded: false }

  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let totalBytes = 0
  let limitExceeded = false
  while (true) {
    const result = await reader.read()
    if (result.done) break
    const remainingBytes = maxBytes - totalBytes
    if (result.value.byteLength > remainingBytes) {
      if (remainingBytes > 0) chunks.push(result.value.slice(0, remainingBytes))
      totalBytes += Math.max(remainingBytes, 0)
      limitExceeded = true
      await reader.cancel()
      break
    }
    chunks.push(result.value)
    totalBytes += result.value.byteLength
  }

  const bytes = new Uint8Array(totalBytes)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return { text: new TextDecoder().decode(bytes), limitExceeded }
}

function extractMailMessage(value: unknown): Microsoft365MailMessage {
  const message = isRecord(value) ? value : {}
  const body = readRecord(message, "body") ?? {}
  const content = truncateText(readString(body, "content"), DEFAULT_MAX_CONTENT_CHARACTERS)
  return {
    id: readString(message, "id"),
    conversationId: readString(message, "conversationId"),
    subject: readString(message, "subject"),
    receivedDateTime: readString(message, "receivedDateTime"),
    preview: readString(message, "bodyPreview"),
    from: readEmailAddress(message.from),
    to: readEmailAddresses(message, "toRecipients"),
    cc: readEmailAddresses(message, "ccRecipients"),
    webLink: readString(message, "webLink"),
    hasAttachments: readBoolean(message, "hasAttachments"),
    body: content.text,
    bodyContentType: readString(body, "contentType"),
    bodyTruncated: content.truncated,
  }
}

export function extractMicrosoftMailMessages(json: unknown): Microsoft365MailMessageSummary[] {
  const root = isRecord(json) ? json : {}
  const messages: Microsoft365MailMessageSummary[] = []
  for (const value of readArray(root, "value")) {
    const message = extractMailMessage(value)
    if (!message.id) continue
    messages.push({
      id: message.id,
      conversationId: message.conversationId,
      subject: message.subject,
      receivedDateTime: message.receivedDateTime,
      preview: message.preview,
      from: message.from,
      to: message.to,
      webLink: message.webLink,
      hasAttachments: message.hasAttachments,
    })
  }
  return messages
}

export function extractMicrosoftMailMessage(json: unknown): Microsoft365MailMessage {
  return extractMailMessage(json)
}

function readEventTime(event: Record<string, unknown>, key: string): { dateTime: string; timeZone: string } {
  const value = readRecord(event, key) ?? {}
  return {
    dateTime: readString(value, "dateTime"),
    timeZone: readString(value, "timeZone"),
  }
}

function readOnlineMeetingUrl(event: Record<string, unknown>): string | null {
  const meeting = readRecord(event, "onlineMeeting")
  const joinUrl = meeting ? readString(meeting, "joinUrl") : ""
  return joinUrl || readString(event, "onlineMeetingUrl") || null
}

export function extractMicrosoftCalendarEvent(json: unknown): Microsoft365CalendarEvent {
  const event = isRecord(json) ? json : {}
  const start = readEventTime(event, "start")
  const end = readEventTime(event, "end")
  const location = readRecord(event, "location")
  return {
    id: readString(event, "id"),
    subject: readString(event, "subject"),
    preview: readString(event, "bodyPreview"),
    start: start.dateTime,
    startTimeZone: start.timeZone,
    end: end.dateTime,
    endTimeZone: end.timeZone,
    isAllDay: readBoolean(event, "isAllDay"),
    location: location ? readString(location, "displayName") : "",
    organizer: readEmailAddress(event.organizer),
    attendees: readEmailAddresses(event, "attendees"),
    webLink: readString(event, "webLink"),
    onlineMeetingUrl: readOnlineMeetingUrl(event),
  }
}

export function extractMicrosoftCalendarEvents(json: unknown): Microsoft365CalendarEvent[] {
  const root = isRecord(json) ? json : {}
  return readArray(root, "value")
    .map(extractMicrosoftCalendarEvent)
    .filter((event) => Boolean(event.id))
}

function extractDriveItem(value: unknown): Microsoft365DriveItem {
  const item = isRecord(value) ? value : {}
  const file = readRecord(item, "file")
  const folder = readRecord(item, "folder")
  return {
    id: readString(item, "id"),
    name: readString(item, "name"),
    size: readNumber(item, "size"),
    modifiedTime: readString(item, "lastModifiedDateTime"),
    webUrl: readString(item, "webUrl"),
    mimeType: file ? readString(file, "mimeType") : "",
    kind: file ? "file" : folder ? "folder" : "unknown",
  }
}

export function extractMicrosoftDriveItems(json: unknown): Microsoft365DriveItem[] {
  const root = isRecord(json) ? json : {}
  const items: Microsoft365DriveItem[] = []
  for (const value of readArray(root, "value")) {
    const item = extractDriveItem(value)
    if (item.id) items.push(item)
  }
  return items
}

export function extractMicrosoftDriveItem(json: unknown): Microsoft365DriveItem {
  return extractDriveItem(json)
}

function extractTeamsChat(value: unknown): Microsoft365TeamsChat {
  const chat = isRecord(value) ? value : {}
  return {
    id: readString(chat, "id"),
    topic: readString(chat, "topic"),
    chatType: readString(chat, "chatType"),
    webUrl: readString(chat, "webUrl"),
    lastUpdatedDateTime: readString(chat, "lastUpdatedDateTime"),
  }
}

export function extractMicrosoftTeamsChats(json: unknown): Microsoft365TeamsChat[] {
  const root = isRecord(json) ? json : {}
  return readArray(root, "value")
    .map(extractTeamsChat)
    .filter((chat) => Boolean(chat.id))
}

function readChatMessageSender(message: Record<string, unknown>): Microsoft365EmailAddress | null {
  const from = readRecord(message, "from")
  const user = from ? readRecord(from, "user") : null
  if (!user) return null
  const address = readString(user, "userIdentityType") || readString(user, "id")
  if (!address) return null
  return { name: readString(user, "displayName"), address }
}

export function extractMicrosoftTeamsMessage(json: unknown): Microsoft365TeamsMessage {
  const message = isRecord(json) ? json : {}
  const body = readRecord(message, "body")
  return {
    id: readString(message, "id"),
    createdDateTime: readString(message, "createdDateTime"),
    content: body ? readString(body, "content") : "",
    from: readChatMessageSender(message),
    webUrl: readString(message, "webUrl"),
  }
}

export function extractMicrosoftTeamsMessages(json: unknown): Microsoft365TeamsMessage[] {
  const root = isRecord(json) ? json : {}
  return readArray(root, "value")
    .map(extractMicrosoftTeamsMessage)
    .filter((message) => Boolean(message.id))
}

function isTextContentType(contentType: string): boolean {
  const normalized = contentType.split(";", 1)[0]?.trim().toLowerCase() ?? ""
  return normalized.startsWith("text/")
    || normalized === "application/json"
    || normalized === "application/xml"
    || normalized === "application/yaml"
    || normalized === "application/x-yaml"
    || normalized === "application/javascript"
}

function escapeGraphSearch(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')
}

export function escapeOneDriveSearchPath(value: string): string {
  return value.replace(/'/g, "''")
}

export function encodeOneDrivePath(value: string): string {
  return value.split("/")
    .filter((segment) => segment.length > 0)
    .map((segment) => encodeURIComponent(segment))
    .join("/")
}

export class MicrosoftGraphRequestError extends Error {
  readonly status: number
  readonly responseBody: string

  constructor(operation: string, status: number, responseBody: string) {
    super(`${operation} failed: ${status} ${responseBody.slice(0, 300)}`)
    this.name = "MicrosoftGraphRequestError"
    this.status = status
    this.responseBody = responseBody
  }
}

export class MicrosoftGraphClient {
  private readonly accessToken: string
  private readonly baseUrl: string
  private readonly fetchImpl: typeof fetch
  private readonly timeoutMs: number
  private readonly maxDownloadBytes: number
  private readonly maxJsonResponseBytes: number
  private readonly maxContentCharacters: number

  constructor(options: MicrosoftGraphClientOptions) {
    this.accessToken = options.accessToken
    this.baseUrl = (options.baseUrl ?? DEFAULT_GRAPH_BASE_URL).replace(/\/+$/, "")
    this.fetchImpl = options.fetch ?? fetch
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
    this.maxDownloadBytes = options.maxDownloadBytes ?? DEFAULT_MAX_DOWNLOAD_BYTES
    this.maxJsonResponseBytes = options.maxJsonResponseBytes ?? DEFAULT_MAX_JSON_RESPONSE_BYTES
    this.maxContentCharacters = options.maxContentCharacters ?? DEFAULT_MAX_CONTENT_CHARACTERS
  }

  private url(path: string): URL {
    return new URL(`${this.baseUrl}/${path.replace(/^\/+/, "")}`)
  }

  private async request(operation: string, url: URL, init?: RequestInit): Promise<Response> {
    const headers = new Headers(init?.headers)
    headers.set("authorization", `Bearer ${this.accessToken}`)
    const response = await this.fetchImpl(url, {
      ...init,
      headers,
      signal: init?.signal ?? AbortSignal.timeout(this.timeoutMs),
    })
    if (!response.ok) {
      const responseBody = await readTextWithByteLimit(response, this.maxJsonResponseBytes)
      const suffix = responseBody.limitExceeded ? " [response truncated]" : ""
      throw new MicrosoftGraphRequestError(operation, response.status, `${responseBody.text}${suffix}`)
    }
    return response
  }

  private async requestJson(operation: string, url: URL, init?: RequestInit): Promise<unknown> {
    const response = await this.request(operation, url, init)
    const responseBody = await readTextWithByteLimit(response, this.maxJsonResponseBytes)
    if (responseBody.limitExceeded) {
      throw new MicrosoftGraphRequestError(operation, 502, `Microsoft Graph response exceeded ${this.maxJsonResponseBytes} bytes.`)
    }
    try {
      const body: unknown = JSON.parse(responseBody.text)
      return body
    } catch {
      throw new MicrosoftGraphRequestError(operation, 502, "Microsoft Graph returned invalid JSON.")
    }
  }

  async listMailMessages(input: { search?: string; maxResults: number }): Promise<Microsoft365MailMessageSummary[]> {
    const url = this.url("me/messages")
    url.searchParams.set("$top", String(input.maxResults))
    url.searchParams.set("$select", "id,conversationId,subject,receivedDateTime,bodyPreview,from,toRecipients,webLink,hasAttachments")
    if (input.search) {
      url.searchParams.set("$search", `"${escapeGraphSearch(input.search)}"`)
    } else {
      url.searchParams.set("$orderby", "receivedDateTime desc")
    }
    const headers = input.search ? { ConsistencyLevel: "eventual" } : undefined
    return extractMicrosoftMailMessages(await this.requestJson("Microsoft 365 mail list", url, { headers }))
  }

  async getMailMessage(messageId: string): Promise<Microsoft365MailMessage> {
    const url = this.url(`me/messages/${encodeURIComponent(messageId)}`)
    url.searchParams.set("$select", "id,conversationId,subject,receivedDateTime,bodyPreview,body,from,toRecipients,ccRecipients,webLink,hasAttachments")
    const headers = { Prefer: 'outlook.body-content-type="text"' }
    const message = extractMicrosoftMailMessage(await this.requestJson("Microsoft 365 mail read", url, { headers }))
    const body = truncateText(message.body, this.maxContentCharacters)
    return { ...message, body: body.text, bodyTruncated: message.bodyTruncated || body.truncated }
  }

  async createMailDraft(input: {
    to: string[]
    cc?: string[]
    bcc?: string[]
    subject: string
    body: string
  }): Promise<Microsoft365MailMessage> {
    const recipient = (address: string) => ({ emailAddress: { address } })
    const url = this.url("me/messages")
    return extractMicrosoftMailMessage(await this.requestJson("Microsoft 365 mail draft create", url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        subject: input.subject,
        body: { contentType: "Text", content: input.body },
        toRecipients: input.to.map(recipient),
        ccRecipients: (input.cc ?? []).map(recipient),
        bccRecipients: (input.bcc ?? []).map(recipient),
      }),
    }))
  }

  async listCalendarEvents(input: { start: string; end: string; maxResults: number }): Promise<Microsoft365CalendarEvent[]> {
    const url = this.url("me/calendarView")
    url.searchParams.set("startDateTime", input.start)
    url.searchParams.set("endDateTime", input.end)
    url.searchParams.set("$top", String(input.maxResults))
    url.searchParams.set("$orderby", "start/dateTime")
    url.searchParams.set("$select", "id,subject,bodyPreview,start,end,isAllDay,location,organizer,attendees,webLink,onlineMeeting,onlineMeetingUrl")
    return extractMicrosoftCalendarEvents(await this.requestJson("Microsoft 365 calendar list", url))
  }

  async createCalendarEvent(input: {
    subject: string
    body?: string
    start: string
    end: string
    timeZone: string
    location?: string
    attendees?: string[]
  }): Promise<Microsoft365CalendarEvent> {
    const url = this.url("me/events")
    return extractMicrosoftCalendarEvent(await this.requestJson("Microsoft 365 calendar event create", url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        subject: input.subject,
        body: { contentType: "Text", content: input.body ?? "" },
        start: { dateTime: input.start, timeZone: input.timeZone },
        end: { dateTime: input.end, timeZone: input.timeZone },
        location: { displayName: input.location ?? "" },
        attendees: (input.attendees ?? []).map((address) => ({
          emailAddress: { address },
          type: "required",
        })),
      }),
    }))
  }

  async searchDriveItems(input: { query: string; maxResults: number }): Promise<Microsoft365DriveItem[]> {
    const escapedQuery = escapeOneDriveSearchPath(input.query)
    const url = this.url(`me/drive/root/search(q='${escapedQuery}')`)
    url.searchParams.set("$top", String(input.maxResults))
    url.searchParams.set("$select", "id,name,size,lastModifiedDateTime,webUrl,file,folder")
    return extractMicrosoftDriveItems(await this.requestJson("Microsoft 365 OneDrive search", url))
  }

  async getDriveItem(itemId: string): Promise<Microsoft365DriveItem> {
    const url = this.url(`me/drive/items/${encodeURIComponent(itemId)}`)
    url.searchParams.set("$select", "id,name,size,lastModifiedDateTime,webUrl,file,folder")
    return extractMicrosoftDriveItem(await this.requestJson("Microsoft 365 OneDrive item metadata", url))
  }

  async getDriveItemWithContent(itemId: string): Promise<Microsoft365DriveItemWithContent> {
    const item = await this.getDriveItem(itemId)
    if (item.kind === "folder") {
      return { ...item, content: null, contentType: null, truncated: false, contentUnavailableReason: "folder" }
    }
    if (item.size !== null && item.size > this.maxDownloadBytes) {
      return { ...item, content: null, contentType: item.mimeType || null, truncated: false, contentUnavailableReason: "file_too_large" }
    }
    if (item.mimeType && !isTextContentType(item.mimeType)) {
      return { ...item, content: null, contentType: item.mimeType, truncated: false, contentUnavailableReason: "unsupported_content_type" }
    }

    const contentUrl = this.url(`me/drive/items/${encodeURIComponent(itemId)}/content`)
    const response = await this.request("Microsoft 365 OneDrive item content", contentUrl)
    const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim() || item.mimeType || null
    const contentLength = Number(response.headers.get("content-length"))
    if (Number.isFinite(contentLength) && contentLength > this.maxDownloadBytes) {
      return { ...item, content: null, contentType, truncated: false, contentUnavailableReason: "file_too_large" }
    }
    if (contentType && !isTextContentType(contentType)) {
      return { ...item, content: null, contentType, truncated: false, contentUnavailableReason: "unsupported_content_type" }
    }

    const downloaded = await readTextWithByteLimit(response, this.maxDownloadBytes)
    if (downloaded.limitExceeded) {
      return { ...item, content: null, contentType, truncated: false, contentUnavailableReason: "file_too_large" }
    }
    const content = truncateText(downloaded.text, this.maxContentCharacters)
    return {
      ...item,
      content: content.text,
      contentType,
      truncated: content.truncated,
      contentUnavailableReason: null,
    }
  }

  async putDriveTextFile(input: { path: string; content: string }): Promise<Microsoft365DriveItem> {
    const encodedPath = encodeOneDrivePath(input.path)
    const url = this.url(`me/drive/root:/${encodedPath}:/content`)
    return extractMicrosoftDriveItem(await this.requestJson("Microsoft 365 OneDrive file write", url, {
      method: "PUT",
      headers: { "content-type": "text/plain; charset=utf-8" },
      body: input.content,
    }))
  }

  async listTeamsChats(maxResults: number): Promise<Microsoft365TeamsChat[]> {
    const url = this.url("me/chats")
    url.searchParams.set("$top", String(maxResults))
    url.searchParams.set("$select", "id,topic,chatType,webUrl,lastUpdatedDateTime")
    return extractMicrosoftTeamsChats(await this.requestJson("Microsoft 365 Teams chat list", url))
  }

  async listTeamsMessages(chatId: string, maxResults: number): Promise<Microsoft365TeamsMessage[]> {
    const url = this.url(`chats/${encodeURIComponent(chatId)}/messages`)
    url.searchParams.set("$top", String(maxResults))
    return extractMicrosoftTeamsMessages(await this.requestJson("Microsoft 365 Teams message list", url))
  }

  async sendTeamsMessage(chatId: string, content: string): Promise<Microsoft365TeamsMessage> {
    const url = this.url(`chats/${encodeURIComponent(chatId)}/messages`)
    return extractMicrosoftTeamsMessage(await this.requestJson("Microsoft 365 Teams message send", url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ body: { contentType: "text", content } }),
    }))
  }
}
