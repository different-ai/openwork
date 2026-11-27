import { decodeFileContent, truncateText } from "./binary-content.js"

export const DEFAULT_GRAPH_BASE_URL = "https://graph.microsoft.com/v1.0"
const DEFAULT_TIMEOUT_MS = 30_000
const DEFAULT_MAX_DOWNLOAD_BYTES = 10 * 1024 * 1024
const DEFAULT_MAX_JSON_RESPONSE_BYTES = 5_000_000
const DEFAULT_MAX_CONTENT_CHARACTERS = 200_000
export const MICROSOFT_MAIL_ATTACHMENT_MAX_BYTES = 3_000_000

export type Microsoft365BodyContentType = "text" | "html"
export type Microsoft365OnlineMeetingProvider = "teamsForBusiness" | "skypeForBusiness" | "skypeForConsumer"
type OnlineMeetingInput = { isOnlineMeeting?: boolean; onlineMeetingProvider?: Microsoft365OnlineMeetingProvider }

function graphOnlineMeeting(input: OnlineMeetingInput) {
  if (input.isOnlineMeeting === undefined) return {}
  return input.isOnlineMeeting
    ? { isOnlineMeeting: true, onlineMeetingProvider: input.onlineMeetingProvider ?? "teamsForBusiness" }
    : { isOnlineMeeting: false }
}

function graphItemBody(content: string, contentType: Microsoft365BodyContentType | undefined) {
  return { contentType: contentType === "html" ? "HTML" : "Text", content }
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")
}

export function htmlReplyBody(reply: string, quoted: string, quotedContentType: string): string {
  const block = `<div>${reply}</div>`
  if (!quoted) return block
  if (quotedContentType.toLowerCase() !== "html") return `${block}<br>${escapeHtml(quoted).replace(/\r?\n/g, "<br>")}`
  const bodyTag = /<body\b[^>]*>/i.exec(quoted)
  if (!bodyTag) return `${block}${quoted}`
  const at = bodyTag.index + bodyTag[0].length
  return `${quoted.slice(0, at)}${block}${quoted.slice(at)}`
}

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
  isDraft: boolean
  isRead: boolean
  categories: string[]
  parentFolderId: string
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

export type Microsoft365DriveRef = {
  driveId?: string
  itemId: string
}

export type Microsoft365DriveItem = {
  id: string
  driveId: string
  parentId: string
  siteId: string
  name: string
  size: number | null
  modifiedTime: string
  webUrl: string
  mimeType: string
  kind: "file" | "folder" | "unknown"
  eTag: string
}

export type Microsoft365Site = {
  id: string
  name: string
  webUrl: string
  description: string
}

export type Microsoft365Drive = {
  id: string
  name: string
  webUrl: string
  driveType: string
}

export type Microsoft365MailAttachment = {
  id: string
  name: string
  contentType: string
  size: number | null
  isInline: boolean
  kind: "file" | "item" | "reference" | "unknown"
}

export type Microsoft365MailAttachmentWithContent = Microsoft365MailAttachment & {
  contentBase64: string | null
  contentUnavailableReason: "not_a_file" | "file_too_large" | null
}

export type Microsoft365UploadSession = {
  uploadUrl: string
  expirationDateTime: string
}

export type Microsoft365DriveItemWithContent = Microsoft365DriveItem & {
  content: string | null
  contentBase64: string | null
  encoding: "text" | "base64" | "none"
  contentType: string | null
  truncated: boolean
  contentUnavailableReason: "folder" | "file_too_large" | null
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

type MutationStatus = 200 | 201 | 202 | 204

type MicrosoftGraphPageLink = { list: string; url: string }

export type MicrosoftGraphPageTokens = {
  seal(page: MicrosoftGraphPageLink): string
  open(token: string): MicrosoftGraphPageLink | null
}

type MicrosoftGraphPage<T> = { items: T[]; nextPageToken: string | null; hasMore: boolean }

type MicrosoftGraphClientOptions = {
  accessToken: string
  baseUrl?: string
  fetch?: typeof fetch
  timeoutMs?: number
  maxDownloadBytes?: number
  maxJsonResponseBytes?: number
  maxContentCharacters?: number
  signal?: AbortSignal
  ownDriveOnly?: boolean
  pageTokens?: MicrosoftGraphPageTokens
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

async function readBytesWithByteLimit(response: Response, maxBytes: number): Promise<{ bytes: Uint8Array; limitExceeded: boolean }> {
  if (!response.body) return { bytes: new Uint8Array(), limitExceeded: false }

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
  return { bytes, limitExceeded }
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
    isDraft: readBoolean(message, "isDraft"),
    isRead: readBoolean(message, "isRead"),
    categories: readArray(message, "categories").filter((value): value is string => typeof value === "string"),
    parentFolderId: readString(message, "parentFolderId"),
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

const CALENDAR_EVENT_SELECT = "id,subject,bodyPreview,start,end,isAllDay,location,organizer,attendees,webLink,onlineMeeting,onlineMeetingUrl"
const MAIL_ATTACHMENT_SELECT = "id,name,contentType,size,isInline"

function mailAttachmentKind(type: string): Microsoft365MailAttachment["kind"] {
  if (type === "#microsoft.graph.fileAttachment") return "file"
  if (type === "#microsoft.graph.itemAttachment") return "item"
  if (type === "#microsoft.graph.referenceAttachment") return "reference"
  return "unknown"
}

function extractMailAttachment(value: unknown): Microsoft365MailAttachment {
  const attachment = isRecord(value) ? value : {}
  return {
    id: readString(attachment, "id"),
    name: readString(attachment, "name"),
    contentType: readString(attachment, "contentType"),
    size: readNumber(attachment, "size"),
    isInline: readBoolean(attachment, "isInline"),
    kind: mailAttachmentKind(readString(attachment, "@odata.type")),
  }
}

export function extractMicrosoftMailAttachments(json: unknown): Microsoft365MailAttachment[] {
  return isRecord(json) ? readArray(json, "value").map(extractMailAttachment).filter((attachment) => attachment.id) : []
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

function extractDriveItem(value: unknown, fallbackId = ""): Microsoft365DriveItem {
  const item = isRecord(value) ? value : {}
  const target = readRecord(item, "remoteItem") ?? item
  const parent = readRecord(target, "parentReference") ?? {}
  const file = readRecord(target, "file") ?? readRecord(item, "file")
  const folder = readRecord(target, "folder") ?? readRecord(item, "folder")
  return {
    id: readString(target, "id") || readString(item, "id") || fallbackId,
    driveId: readString(parent, "driveId"),
    parentId: readString(parent, "id"),
    siteId: readString(parent, "siteId"),
    name: readString(item, "name") || readString(target, "name"),
    size: readNumber(target, "size") ?? readNumber(item, "size"),
    modifiedTime: readString(target, "lastModifiedDateTime") || readString(item, "lastModifiedDateTime"),
    webUrl: readString(target, "webUrl") || readString(item, "webUrl"),
    mimeType: file ? readString(file, "mimeType") : "",
    kind: file ? "file" : folder ? "folder" : "unknown",
    eTag: readString(target, "eTag") || readString(item, "eTag"),
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

export function extractMicrosoftSearchHits(json: unknown, from: number): { files: Microsoft365DriveItem[]; nextFrom: number | null; hasMore: boolean } {
  const root = isRecord(json) ? json : {}
  const response = readArray(root, "value").find(isRecord) ?? {}
  const container = readArray(response, "hitsContainers").find(isRecord) ?? {}
  const hits = readArray(container, "hits").filter(isRecord)
  const files: Microsoft365DriveItem[] = []
  for (const hit of hits) {
    const item = extractDriveItem(hit.resource, readString(hit, "hitId"))
    if (item.id) files.push(item)
  }
  const hasMore = readBoolean(container, "moreResultsAvailable")
  return { files, nextFrom: hasMore && hits.length ? from + hits.length : null, hasMore }
}

export function extractMicrosoftSites(json: unknown): Microsoft365Site[] {
  const root = isRecord(json) ? json : {}
  return readArray(root, "value").filter(isRecord).map((site) => ({
    id: readString(site, "id"),
    name: readString(site, "displayName") || readString(site, "name"),
    webUrl: readString(site, "webUrl"),
    description: readString(site, "description"),
  })).filter((site) => Boolean(site.id))
}

export function extractMicrosoftDrives(json: unknown): Microsoft365Drive[] {
  const root = isRecord(json) ? json : {}
  return readArray(root, "value").filter(isRecord).map((drive) => ({
    id: readString(drive, "id"),
    name: readString(drive, "name"),
    webUrl: readString(drive, "webUrl"),
    driveType: readString(drive, "driveType"),
  })).filter((drive) => Boolean(drive.id))
}

const DRIVE_ITEM_SELECT = "id,name,size,lastModifiedDateTime,webUrl,file,folder,parentReference,eTag,remoteItem"
const UPLOAD_HOST_SUFFIXES = [".sharepoint.com", ".sharepoint.us", ".sharepoint-mil.us", ".sharepoint.cn", ".sharepoint.de"]

function driveItemPath(ref: Microsoft365DriveRef, suffix = ""): string {
  const item = ref.driveId
    ? `drives/${encodeURIComponent(ref.driveId)}/items/${encodeURIComponent(ref.itemId)}`
    : `me/drive/items/${encodeURIComponent(ref.itemId)}`
  return `${item}${suffix}`
}

function driveRootPath(driveId?: string): string {
  return driveId ? `drives/${encodeURIComponent(driveId)}/root` : "me/drive/root"
}

export function encodeSharingUrl(value: string): string {
  return `u!${Buffer.from(value, "utf8").toString("base64url")}`
}

export function isMicrosoftUploadSessionUrl(value: string, graphBaseUrl = DEFAULT_GRAPH_BASE_URL): boolean {
  try {
    const url = new URL(value)
    if (url.username || url.password || url.hash) return false
    if (url.protocol === "https:" && UPLOAD_HOST_SUFFIXES.some((suffix) => url.hostname.endsWith(suffix))) return true
    const base = new URL(graphBaseUrl)
    return base.origin !== new URL(DEFAULT_GRAPH_BASE_URL).origin && url.origin === base.origin
  } catch {
    return false
  }
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
  const address = readString(user, "id")
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

function escapeGraphSearch(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')
}

export function escapeOneDriveSearchPath(value: string): string {
  return encodeURIComponent(value.replace(/'/g, "''"))
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

export class MicrosoftGraphPageTokenError extends Error {
  constructor() {
    super("This page token is not valid any more. Start the list again.")
    this.name = "MicrosoftGraphPageTokenError"
  }
}

export class MicrosoftGraphScopeError extends Error {
  constructor() {
    super("Files outside your own OneDrive need the Microsoft 365 permission to read all files the member can access (or full file access to save them). An admin can enable it on the Microsoft 365 connector in OpenWork Cloud -> Connectors; then reconnect your account.")
    this.name = "MicrosoftGraphScopeError"
  }
}

export class MicrosoftGraphMutationOutcomeUnknownError extends MicrosoftGraphRequestError {
  constructor(operation: string) {
    super(operation, 502, "The mutation outcome is unknown. Verify the current state before trying again; do not automatically retry.")
    this.name = "MicrosoftGraphMutationOutcomeUnknownError"
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
  private readonly signal?: AbortSignal
  private readonly ownDriveOnly: boolean
  private readonly pageTokens?: MicrosoftGraphPageTokens
  private ownDriveId?: Promise<string>

  constructor(options: MicrosoftGraphClientOptions) {
    this.accessToken = options.accessToken
    this.baseUrl = (options.baseUrl ?? DEFAULT_GRAPH_BASE_URL).replace(/\/+$/, "")
    this.fetchImpl = options.fetch ?? fetch
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
    this.maxDownloadBytes = options.maxDownloadBytes ?? DEFAULT_MAX_DOWNLOAD_BYTES
    this.maxJsonResponseBytes = options.maxJsonResponseBytes ?? DEFAULT_MAX_JSON_RESPONSE_BYTES
    this.maxContentCharacters = options.maxContentCharacters ?? DEFAULT_MAX_CONTENT_CHARACTERS
    this.signal = options.signal
    this.ownDriveOnly = options.ownDriveOnly ?? false
    this.pageTokens = options.pageTokens
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
      signal: AbortSignal.any([
        AbortSignal.timeout(this.timeoutMs),
        ...(this.signal ? [this.signal] : []),
        ...(init?.signal ? [init.signal] : []),
      ]),
    })
    if (!response.ok) {
      const responseBody = await readBytesWithByteLimit(response, this.maxJsonResponseBytes)
      const suffix = responseBody.limitExceeded ? " [response truncated]" : ""
      throw new MicrosoftGraphRequestError(operation, response.status, `${new TextDecoder().decode(responseBody.bytes)}${suffix}`)
    }
    return response
  }

  private async requestJson(operation: string, url: URL, init?: RequestInit): Promise<unknown> {
    const response = await this.request(operation, url, init)
    const responseBody = await readBytesWithByteLimit(response, this.maxJsonResponseBytes)
    if (responseBody.limitExceeded) {
      throw new MicrosoftGraphRequestError(operation, 502, `Microsoft Graph response exceeded ${this.maxJsonResponseBytes} bytes.`)
    }
    try {
      const body: unknown = JSON.parse(new TextDecoder().decode(responseBody.bytes))
      return body
    } catch {
      throw new MicrosoftGraphRequestError(operation, 502, "Microsoft Graph returned invalid JSON.")
    }
  }

  private async requestPage<T>(
    operation: string,
    list: string,
    firstPage: URL,
    pageToken: string | undefined,
    extract: (json: unknown) => T[],
    options?: { headers?: (url: URL) => HeadersInit | undefined; beforeRequest?: (url: URL) => Promise<void> },
  ): Promise<MicrosoftGraphPage<T>> {
    const base = this.url("")
    const pageUrl = (link: string) => {
      const url = URL.parse(link)
      return url && url.origin === base.origin && url.pathname.startsWith(base.pathname) && !url.username && !url.password ? url : null
    }
    let url = firstPage
    if (pageToken !== undefined) {
      const page = this.pageTokens?.open(pageToken)
      const continuation = page?.list === list ? pageUrl(page.url) : null
      if (!continuation) throw new MicrosoftGraphPageTokenError()
      url = continuation
    }
    await options?.beforeRequest?.(url)
    const json = await this.requestJson(operation, url, { headers: options?.headers?.(url), redirect: "error" })
    const hasMore = isRecord(json) && Object.hasOwn(json, "@odata.nextLink")
    const nextLink = isRecord(json) ? readString(json, "@odata.nextLink") : ""
    const nextPageToken = this.pageTokens && pageUrl(nextLink) ? this.pageTokens.seal({ list, url: nextLink }) : null
    return { items: extract(json), nextPageToken, hasMore }
  }

  private async requestMutation(
    operation: string,
    path: string,
    method: "POST" | "PUT" | "PATCH" | "DELETE",
    expectedStatus: MutationStatus | readonly MutationStatus[],
    body?: unknown,
  ): Promise<unknown> {
    const expectedStatuses: readonly number[] = typeof expectedStatus === "number" ? [expectedStatus] : expectedStatus
    try {
      const response = await this.request(operation, this.url(path), {
        method,
        redirect: "error",
        headers: body === undefined ? undefined : { "content-type": typeof body === "string" ? "text/plain; charset=utf-8" : "application/json" },
        body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
      })
      if (!expectedStatuses.includes(response.status)) {
        await response.body?.cancel()
        throw new MicrosoftGraphMutationOutcomeUnknownError(operation)
      }
      if (response.status === 202 || response.status === 204) {
        await response.body?.cancel()
        return null
      }
      const responseBody = await readBytesWithByteLimit(response, this.maxJsonResponseBytes)
      if (responseBody.limitExceeded) throw new MicrosoftGraphMutationOutcomeUnknownError(operation)
      const value: unknown = JSON.parse(new TextDecoder().decode(responseBody.bytes))
      if (!isRecord(value) || !readString(value, "id")) throw new MicrosoftGraphMutationOutcomeUnknownError(operation)
      return value
    } catch (error) {
      if (error instanceof MicrosoftGraphRequestError && error.status >= 400 && error.status < 500) throw error
      throw new MicrosoftGraphMutationOutcomeUnknownError(operation)
    }
  }

  async listMailMessages(input: { search?: string; maxResults: number; pageToken?: string }): Promise<MicrosoftGraphPage<Microsoft365MailMessageSummary>> {
    const url = this.url("me/messages")
    url.searchParams.set("$top", String(input.maxResults))
    url.searchParams.set("$select", "id,conversationId,subject,receivedDateTime,bodyPreview,from,toRecipients,webLink,hasAttachments")
    if (input.search) {
      url.searchParams.set("$search", `"${escapeGraphSearch(input.search)}"`)
    } else {
      url.searchParams.set("$orderby", "receivedDateTime desc")
    }
    return this.requestPage("Microsoft 365 mail list", "mail-messages", url, input.pageToken, extractMicrosoftMailMessages, {
      headers: (pageUrl) => pageUrl.searchParams.has("$search") ? { ConsistencyLevel: "eventual" } : undefined,
    })
  }

  async getMailMessage(messageId: string): Promise<Microsoft365MailMessage> {
    const url = this.url(`me/messages/${encodeURIComponent(messageId)}`)
    url.searchParams.set("$select", "id,conversationId,subject,receivedDateTime,bodyPreview,body,from,toRecipients,ccRecipients,webLink,hasAttachments,isDraft,isRead,categories,parentFolderId")
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
    bodyContentType?: Microsoft365BodyContentType
  }): Promise<Microsoft365MailMessage> {
    const recipient = (address: string) => ({ emailAddress: { address } })
    return extractMicrosoftMailMessage(await this.requestMutation("Microsoft 365 mail draft create", "me/messages", "POST", 201, {
      subject: input.subject,
      body: graphItemBody(input.body, input.bodyContentType),
      toRecipients: input.to.map(recipient),
      ccRecipients: (input.cc ?? []).map(recipient),
      bccRecipients: (input.bcc ?? []).map(recipient),
    }))
  }

  async listCalendarEvents(input: { start: string; end: string; maxResults: number; pageToken?: string }): Promise<MicrosoftGraphPage<Microsoft365CalendarEvent>> {
    const url = this.url("me/calendarView")
    url.searchParams.set("startDateTime", input.start)
    url.searchParams.set("endDateTime", input.end)
    url.searchParams.set("$top", String(input.maxResults))
    url.searchParams.set("$orderby", "start/dateTime")
    url.searchParams.set("$select", CALENDAR_EVENT_SELECT)
    return this.requestPage("Microsoft 365 calendar list", "calendar-events", url, input.pageToken, extractMicrosoftCalendarEvents)
  }

  async sendMailDraft(messageId: string): Promise<{ draftId: string; status: "accepted" }> {
    await this.requestMutation("Microsoft 365 mail draft send", `me/messages/${encodeURIComponent(messageId)}/send`, "POST", 202)
    return { draftId: messageId, status: "accepted" }
  }

  async createMailReplyDraft(messageId: string, comment: string, bodyContentType: Microsoft365BodyContentType = "text"): Promise<Microsoft365MailMessage> {
    const path = `me/messages/${encodeURIComponent(messageId)}/createReply`
    if (bodyContentType === "text") {
      const draft = extractMicrosoftMailMessage(await this.requestMutation("Microsoft 365 mail reply draft create", path, "POST", 201, { comment }))
      if (!draft.isDraft) throw new MicrosoftGraphMutationOutcomeUnknownError("Microsoft 365 mail reply draft create")
      return draft
    }
    const created = await this.requestMutation("Microsoft 365 mail reply draft create", path, "POST", 201, {})
    const draft = extractMicrosoftMailMessage(created)
    if (!draft.isDraft) throw new MicrosoftGraphMutationOutcomeUnknownError("Microsoft 365 mail reply draft create")
    try {
      const quoted = (isRecord(created) ? readRecord(created, "body") : null) ?? {}
      return extractMicrosoftMailMessage(await this.requestMutation(
        "Microsoft 365 mail reply draft body update", `me/messages/${encodeURIComponent(draft.id)}`, "PATCH", 200,
        { body: { contentType: "HTML", content: htmlReplyBody(comment, readString(quoted, "content"), readString(quoted, "contentType")) } },
      ))
    } catch (error) {
      await this.deleteMailDraft(draft.id).catch(() => undefined)
      throw error
    }
  }

  async listMailAttachments(messageId: string): Promise<Microsoft365MailAttachment[]> {
    const url = this.url(`me/messages/${encodeURIComponent(messageId)}/attachments`)
    url.searchParams.set("$select", MAIL_ATTACHMENT_SELECT)
    return extractMicrosoftMailAttachments(await this.requestJson("Microsoft 365 mail attachment list", url))
  }

  async getMailAttachment(messageId: string, attachmentId: string): Promise<Microsoft365MailAttachmentWithContent> {
    const path = `me/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(attachmentId)}`
    const url = this.url(path)
    url.searchParams.set("$select", MAIL_ATTACHMENT_SELECT)
    const attachment = extractMailAttachment(await this.requestJson("Microsoft 365 mail attachment read", url))
    if (attachment.kind !== "file") return { ...attachment, contentBase64: null, contentUnavailableReason: "not_a_file" }
    if (attachment.size !== null && attachment.size > this.maxDownloadBytes) return { ...attachment, contentBase64: null, contentUnavailableReason: "file_too_large" }
    const downloaded = await readBytesWithByteLimit(await this.request("Microsoft 365 mail attachment download", this.url(`${path}/$value`)), this.maxDownloadBytes)
    if (downloaded.limitExceeded) return { ...attachment, contentBase64: null, contentUnavailableReason: "file_too_large" }
    return { ...attachment, contentBase64: Buffer.from(downloaded.bytes).toString("base64"), contentUnavailableReason: null }
  }

  async addMailAttachment(messageId: string, file: { name: string; contentType: string; content: Uint8Array }): Promise<Microsoft365MailAttachment> {
    return extractMailAttachment(await this.requestMutation(
      "Microsoft 365 mail attachment add", `me/messages/${encodeURIComponent(messageId)}/attachments`, "POST", 201, {
        "@odata.type": "#microsoft.graph.fileAttachment",
        name: file.name,
        contentType: file.contentType,
        contentBytes: Buffer.from(file.content).toString("base64"),
      },
    ))
  }

  async deleteMailDraft(messageId: string): Promise<void> {
    await this.requestMutation("Microsoft 365 mail draft delete", `me/messages/${encodeURIComponent(messageId)}`, "DELETE", 204)
  }

  async updateMailMessage(messageId: string, input: { isRead?: boolean; categories?: string[] }): Promise<Microsoft365MailMessage> {
    return extractMicrosoftMailMessage(await this.requestMutation(
      "Microsoft 365 mail message update", `me/messages/${encodeURIComponent(messageId)}`, "PATCH", 200,
      { isRead: input.isRead, categories: input.categories },
    ))
  }

  async moveMailMessage(messageId: string, destinationId: "archive" | "deleteditems" | "inbox"): Promise<Microsoft365MailMessage> {
    return extractMicrosoftMailMessage(await this.requestMutation(
      "Microsoft 365 mail message move", `me/messages/${encodeURIComponent(messageId)}/move`, "POST", 201, { destinationId },
    ))
  }

  async updateCalendarEvent(eventId: string, input: {
    subject?: string
    body?: string
    bodyContentType?: Microsoft365BodyContentType
    start?: string
    end?: string
    location?: string
  } & OnlineMeetingInput): Promise<Microsoft365CalendarEvent> {
    return this.withJoinUrl(input, extractMicrosoftCalendarEvent(await this.requestMutation(
      "Microsoft 365 calendar event update", `me/events/${encodeURIComponent(eventId)}`, "PATCH", 200, {
        subject: input.subject,
        body: input.body === undefined ? undefined : graphItemBody(input.body, input.bodyContentType),
        start: input.start === undefined ? undefined : { dateTime: input.start, timeZone: "UTC" },
        end: input.end === undefined ? undefined : { dateTime: input.end, timeZone: "UTC" },
        location: input.location === undefined ? undefined : { displayName: input.location },
        ...graphOnlineMeeting(input),
      },
    )))
  }

  private async withJoinUrl(input: OnlineMeetingInput, event: Microsoft365CalendarEvent): Promise<Microsoft365CalendarEvent> {
    if (input.isOnlineMeeting !== true || event.onlineMeetingUrl || !event.id) return event
    try {
      const url = this.url(`me/events/${encodeURIComponent(event.id)}`)
      url.searchParams.set("$select", CALENDAR_EVENT_SELECT)
      const reread = extractMicrosoftCalendarEvent(await this.requestJson("Microsoft 365 calendar event read", url))
      return reread.id === event.id ? reread : event
    } catch {
      return event
    }
  }

  async cancelCalendarEvent(eventId: string, comment?: string): Promise<{ eventId: string; status: "accepted" }> {
    await this.requestMutation("Microsoft 365 calendar event cancel", `me/events/${encodeURIComponent(eventId)}/cancel`, "POST", 202, { comment })
    return { eventId, status: "accepted" }
  }

  async deleteCalendarEvent(eventId: string): Promise<{ eventId: string; status: "deleted" }> {
    await this.requestMutation("Microsoft 365 calendar event delete", `me/events/${encodeURIComponent(eventId)}`, "DELETE", 204)
    return { eventId, status: "deleted" }
  }

  async createCalendarEvent(input: {
    subject: string
    body?: string
    bodyContentType?: Microsoft365BodyContentType
    start: string
    end: string
    timeZone: string
    location?: string
    attendees?: string[]
  } & OnlineMeetingInput): Promise<Microsoft365CalendarEvent> {
    return this.withJoinUrl(input, extractMicrosoftCalendarEvent(await this.requestMutation("Microsoft 365 calendar event create", "me/events", "POST", 201, {
      subject: input.subject,
      body: graphItemBody(input.body ?? "", input.bodyContentType),
      start: { dateTime: input.start, timeZone: input.timeZone },
      end: { dateTime: input.end, timeZone: input.timeZone },
      location: { displayName: input.location ?? "" },
      attendees: (input.attendees ?? []).map((address) => ({
        emailAddress: { address },
        type: "required",
      })),
      ...graphOnlineMeeting(input),
    })))
  }

  private async assertReachable(driveId: string | undefined) {
    if (!this.ownDriveOnly || !driveId) return
    if (!this.ownDriveId) {
      const url = this.url("me/drive")
      url.searchParams.set("$select", "id")
      this.ownDriveId = this.requestJson("Microsoft 365 OneDrive lookup", url).then((json) => (isRecord(json) ? readString(json, "id") : ""))
      this.ownDriveId.catch(() => { this.ownDriveId = undefined })
    }
    if ((await this.ownDriveId) !== driveId) throw new MicrosoftGraphScopeError()
  }

  private async assertDrivePageReachable(page: URL, driveId: string | undefined) {
    await this.assertReachable(driveId)
    if (!this.ownDriveOnly) return
    const path = page.pathname.slice(this.url("").pathname.length)
    if (path.startsWith("me/drive/")) return
    const otherDrive = /^drives\/([^/]+)\//.exec(path)?.[1]
    if (!otherDrive) throw new MicrosoftGraphPageTokenError()
    await this.assertReachable(decodeURIComponent(otherDrive))
  }

  async searchDriveItems(input: { query: string; maxResults: number; pageToken?: string }): Promise<MicrosoftGraphPage<Microsoft365DriveItem>> {
    const escapedQuery = escapeOneDriveSearchPath(input.query)
    const url = this.url(`me/drive/root/search(q='${escapedQuery}')`)
    url.searchParams.set("$top", String(input.maxResults))
    url.searchParams.set("$select", DRIVE_ITEM_SELECT)
    return this.requestPage("Microsoft 365 OneDrive search", "onedrive-search", url, input.pageToken, extractMicrosoftDriveItems)
  }

  async searchFiles(input: { query: string; maxResults: number; from: number }): Promise<{ files: Microsoft365DriveItem[]; nextFrom: number | null; hasMore: boolean }> {
    if (this.ownDriveOnly) throw new MicrosoftGraphScopeError()
    const json = await this.requestJson("Microsoft 365 file search", this.url("search/query"), {
      method: "POST",
      redirect: "error",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ requests: [{ entityTypes: ["driveItem"], query: { queryString: input.query }, from: input.from, size: input.maxResults }] }),
    })
    return extractMicrosoftSearchHits(json, input.from)
  }

  async listDriveChildren(input: { driveId?: string; folderId?: string; maxResults: number; pageToken?: string }): Promise<MicrosoftGraphPage<Microsoft365DriveItem>> {
    const path = input.folderId ? driveItemPath({ driveId: input.driveId, itemId: input.folderId }, "/children") : `${driveRootPath(input.driveId)}/children`
    const url = this.url(path)
    url.searchParams.set("$top", String(input.maxResults))
    url.searchParams.set("$select", DRIVE_ITEM_SELECT)
    return this.requestPage("Microsoft 365 folder list", "drive-children", url, input.pageToken, extractMicrosoftDriveItems, {
      beforeRequest: (pageUrl) => this.assertDrivePageReachable(pageUrl, input.driveId),
    })
  }

  async resolveSharingLink(link: string): Promise<Microsoft365DriveItem> {
    if (this.ownDriveOnly) throw new MicrosoftGraphScopeError()
    const url = this.url(`shares/${encodeSharingUrl(link)}/driveItem`)
    url.searchParams.set("$select", DRIVE_ITEM_SELECT)
    return extractMicrosoftDriveItem(await this.requestJson("Microsoft 365 link lookup", url))
  }

  async searchSites(input: { query: string; maxResults: number; pageToken?: string }): Promise<MicrosoftGraphPage<Microsoft365Site>> {
    const url = this.url("sites")
    url.searchParams.set("search", input.query)
    url.searchParams.set("$top", String(input.maxResults))
    url.searchParams.set("$select", "id,displayName,name,webUrl,description")
    return this.requestPage("Microsoft 365 SharePoint site search", "sites", url, input.pageToken, extractMicrosoftSites)
  }

  async listSiteDrives(siteId: string): Promise<Microsoft365Drive[]> {
    const url = this.url(`sites/${encodeURIComponent(siteId).replace(/%2C/gi, ",")}/drives`)
    url.searchParams.set("$select", "id,name,webUrl,driveType")
    return extractMicrosoftDrives(await this.requestJson("Microsoft 365 SharePoint library list", url))
  }

  async getDriveItem(ref: Microsoft365DriveRef): Promise<Microsoft365DriveItem> {
    await this.assertReachable(ref.driveId)
    const url = this.url(driveItemPath(ref))
    url.searchParams.set("$select", DRIVE_ITEM_SELECT)
    return extractMicrosoftDriveItem(await this.requestJson("Microsoft 365 OneDrive item metadata", url))
  }

  async downloadDriveContent(ref: Microsoft365DriveRef, input: { range?: string; format?: "pdf" } = {}): Promise<Response> {
    await this.assertReachable(ref.driveId)
    const url = this.url(driveItemPath(ref, "/content"))
    if (input.format) url.searchParams.set("format", input.format)
    return this.request("Microsoft 365 file download", url, input.range ? { headers: { range: input.range } } : undefined)
  }

  async createDriveUploadSession(input:
    | { replace: Microsoft365DriveRef; eTag: string }
    | { parent: Microsoft365DriveRef; name: string; conflictBehavior: "fail" | "rename" },
  ): Promise<Microsoft365UploadSession> {
    const replacing = "replace" in input
    await this.assertReachable(replacing ? input.replace.driveId : input.parent.driveId)
    const path = replacing
      ? driveItemPath(input.replace, "/createUploadSession")
      : driveItemPath(input.parent, `:/${encodeURIComponent(input.name)}:/createUploadSession`)
    const operation = "Microsoft 365 upload session create"
    const json = await this.requestJson(operation, this.url(path), {
      method: "POST",
      redirect: "error",
      headers: { "content-type": "application/json", ...(replacing ? { "if-match": input.eTag } : {}) },
      body: JSON.stringify({ item: { "@microsoft.graph.conflictBehavior": replacing ? "replace" : input.conflictBehavior } }),
    })
    const session = isRecord(json) ? json : {}
    const uploadUrl = readString(session, "uploadUrl")
    if (!isMicrosoftUploadSessionUrl(uploadUrl, this.baseUrl)) {
      throw new MicrosoftGraphRequestError(operation, 502, "Microsoft returned an invalid upload session. No file bytes were sent; do not retry automatically.")
    }
    return { uploadUrl, expirationDateTime: readString(session, "expirationDateTime") }
  }

  async getDriveItemWithContent(ref: Microsoft365DriveRef): Promise<Microsoft365DriveItemWithContent> {
    const item = await this.getDriveItem(ref)
    if (item.kind === "folder") {
      return { ...item, content: null, contentBase64: null, encoding: "none", contentType: null, truncated: false, contentUnavailableReason: "folder" }
    }
    if (item.size !== null && item.size > this.maxDownloadBytes) {
      return { ...item, content: null, contentBase64: null, encoding: "none", contentType: item.mimeType || null, truncated: false, contentUnavailableReason: "file_too_large" }
    }

    const target = !ref.driveId && item.id === ref.itemId ? ref : { driveId: item.driveId || ref.driveId, itemId: item.id }
    await this.assertReachable(target.driveId)
    const contentUrl = this.url(driveItemPath(target, "/content"))
    const response = await this.request("Microsoft 365 OneDrive item content", contentUrl)
    const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim() || item.mimeType || null
    const contentLength = Number(response.headers.get("content-length"))
    if (Number.isFinite(contentLength) && contentLength > this.maxDownloadBytes) {
      return { ...item, content: null, contentBase64: null, encoding: "none", contentType, truncated: false, contentUnavailableReason: "file_too_large" }
    }

    const downloaded = await readBytesWithByteLimit(response, this.maxDownloadBytes)
    if (downloaded.limitExceeded) {
      return { ...item, content: null, contentBase64: null, encoding: "none", contentType, truncated: false, contentUnavailableReason: "file_too_large" }
    }
    const content = decodeFileContent(downloaded.bytes, {
      maxTextCharacters: this.maxContentCharacters,
      maxBinaryBytes: this.maxDownloadBytes,
    })
    if (content.kind === "too_large") {
      return { ...item, content: null, contentBase64: null, encoding: "none", contentType, truncated: false, contentUnavailableReason: "file_too_large" }
    }
    if (content.kind === "binary") {
      return {
        ...item,
        content: null,
        contentBase64: content.contentBase64,
        encoding: "base64",
        contentType,
        truncated: false,
        contentUnavailableReason: null,
      }
    }
    return {
      ...item,
      content: content.content,
      contentBase64: null,
      encoding: "text",
      contentType,
      truncated: content.truncated,
      contentUnavailableReason: null,
    }
  }

  async putDriveTextFile(input: { driveId?: string; path: string; content: string }): Promise<Microsoft365DriveItem> {
    await this.assertReachable(input.driveId)
    const encodedPath = encodeOneDrivePath(input.path)
    return extractMicrosoftDriveItem(await this.requestMutation(
      "Microsoft 365 OneDrive file write", `${driveRootPath(input.driveId)}:/${encodedPath}:/content`, "PUT", [200, 201], input.content,
    ))
  }

  async updateDriveItem(ref: Microsoft365DriveRef, input: { name?: string; parentId?: string }): Promise<Microsoft365DriveItem> {
    await this.assertReachable(ref.driveId)
    return extractMicrosoftDriveItem(await this.requestMutation(
      "Microsoft 365 OneDrive item rename or move", driveItemPath(ref), "PATCH", 200, {
        name: input.name,
        parentReference: input.parentId === undefined ? undefined : { id: input.parentId },
      },
    ))
  }

  async createDriveFolder(input: { driveId?: string; parentId: string; name: string }): Promise<Microsoft365DriveItem> {
    await this.assertReachable(input.driveId)
    return extractMicrosoftDriveItem(await this.requestMutation(
      "Microsoft 365 OneDrive folder create", driveItemPath({ driveId: input.driveId, itemId: input.parentId }, "/children"), "POST", 201,
      { name: input.name, folder: {}, "@microsoft.graph.conflictBehavior": "fail" },
    ))
  }

  async listTeamsChats(maxResults: number, pageToken?: string): Promise<MicrosoftGraphPage<Microsoft365TeamsChat>> {
    const url = this.url("me/chats")
    url.searchParams.set("$top", String(maxResults))
    url.searchParams.set("$select", "id,topic,chatType,webUrl,lastUpdatedDateTime")
    return this.requestPage("Microsoft 365 Teams chat list", "teams-chats", url, pageToken, extractMicrosoftTeamsChats)
  }

  async listTeamsMessages(chatId: string, maxResults: number, pageToken?: string): Promise<MicrosoftGraphPage<Microsoft365TeamsMessage>> {
    const url = this.url(`chats/${encodeURIComponent(chatId)}/messages`)
    url.searchParams.set("$top", String(maxResults))
    return this.requestPage("Microsoft 365 Teams message list", "teams-messages", url, pageToken, extractMicrosoftTeamsMessages)
  }

  async sendTeamsMessage(chatId: string, content: string): Promise<Microsoft365TeamsMessage> {
    return extractMicrosoftTeamsMessage(await this.requestMutation(
      "Microsoft 365 Teams message send", `chats/${encodeURIComponent(chatId)}/messages`, "POST", 201, { body: { contentType: "text", content } },
    ))
  }
}
