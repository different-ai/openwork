import { Hono, type Context } from "hono"
import { bodyLimit } from "hono/body-limit"
import { describeRoute } from "hono-openapi"
import { z } from "zod"
import { env } from "../../env.js"
import { orgMemberRoute } from "../../middleware/route-access.js"
import { jsonValidator, paramValidator, queryValidator } from "../../middleware/validation.js"
import { invalidRequestSchema, jsonResponse, unauthorizedSchema } from "../../openapi.js"
import { readGoogleActionJson, requestGoogleAction, type GoogleWorkspaceActionDependencies } from "./google-workspace-actions.js"
import type { OrgRouteVariables } from "./shared.js"

const scope = "https://www.googleapis.com/auth/"
const calendarWriteScopes = ["calendar", "calendar.events", "calendar.events.owned", "calendar.app.created"].map((name) => scope + name)
const calendarReadScopes = [...calendarWriteScopes, scope + "calendar.readonly", scope + "calendar.events.readonly", scope + "calendar.events.owned.readonly", scope + "calendar.events.public.readonly"]
const driveWriteScopes = [scope + "drive.file", scope + "drive"]
const driveReadScopes = [...driveWriteScopes, scope + "drive.readonly", scope + "drive.metadata.readonly", scope + "drive.metadata"]
const sheetsWriteScopes = [...driveWriteScopes, scope + "spreadsheets"]
const sheetsReadScopes = [...sheetsWriteScopes, scope + "spreadsheets.readonly", scope + "drive.readonly"]
const base = "/v1/capabilities/google-workspace"
const idSchema = z.string().min(1).max(512).regex(/^[A-Za-z0-9_-]+$/)
const eventParams = z.object({ eventId: idSchema })
const spreadsheetParams = z.object({ spreadsheetId: idSchema })
const fileParams = z.object({ fileId: idSchema })
const calendarQuery = z.object({ calendarId: z.string().min(1).max(512).regex(/^[^\s\x00-\x1f]+$/).default("primary") }).strict()
const sendUpdatesSchema = z.enum(["none", "all", "externalOnly"]).default("none")
  .describe("Notification policy. all/externalOnly requires confirmNotifications=true after explicit user approval. Google may still send some service emails with none.")
const timeZoneSchema = z.string().min(1).max(128).refine((value) => {
  try { new Intl.DateTimeFormat("en", { timeZone: value }); return true } catch { return false }
}, "Use a valid IANA time zone.")
const eventTimeSchema = z.union([
  z.object({ dateTime: z.string().datetime({ offset: true }), timeZone: timeZoneSchema.optional() }).strict(),
  z.object({ date: z.string().date() }).strict(),
])
const eventPatchSchema = z.object({
  summary: z.string().trim().min(1).max(1_000).optional(),
  description: z.string().max(20_000).optional(),
  location: z.string().max(1_000).optional(),
  start: eventTimeSchema.optional().describe("Rescheduling requires both start and end, of the same type. All-day end dates are exclusive."),
  end: eventTimeSchema.optional(),
  attendees: z.array(z.object({ email: z.string().email().max(320), optional: z.boolean().optional() }).strict()).max(100).optional()
    .describe("Replaces the entire attendee list; [] removes all attendees. Read the event first to preserve existing guests."),
  sendUpdates: sendUpdatesSchema,
  confirmNotifications: z.boolean().optional(),
}).strict().superRefine((input, ctx) => {
  const { sendUpdates, confirmNotifications, ...patch } = input
  if (!Object.values(patch).some((value) => value !== undefined)) ctx.addIssue({ code: "custom", message: "Provide at least one event field to update." })
  if (sendUpdates !== "none" && confirmNotifications !== true) ctx.addIssue({ code: "custom", path: ["confirmNotifications"], message: "Explicit user approval to notify guests is required." })
  if (input.start || input.end) {
    const { start, end } = input
    if (!start || !end || ("date" in start) !== ("date" in end)) {
      ctx.addIssue({ code: "custom", path: ["end"], message: "Provide both start and end as dateTime values or both as all-day dates." })
    } else {
      const startMs = Date.parse("date" in start ? start.date : start.dateTime)
      const endMs = Date.parse("date" in end ? end.date : end.dateTime)
      if (endMs <= startMs) ctx.addIssue({ code: "custom", path: ["end"], message: "End must be later than start; all-day end dates are exclusive." })
    }
  }
})
const cancelQuery = calendarQuery.extend({
  sendUpdates: sendUpdatesSchema,
  confirmCancellation: z.literal("true").describe("Required explicit user confirmation to delete/cancel this event. A recurring master ID cancels the whole series; use an instance ID for one occurrence."),
  confirmNotifications: z.enum(["true", "false"]).optional(),
}).superRefine((input, ctx) => {
  if (input.sendUpdates !== "none" && input.confirmNotifications !== "true") ctx.addIssue({ code: "custom", path: ["confirmNotifications"], message: "Explicit user approval to notify guests is required." })
})
const eventResponseTimeSchema = z.union([
  z.object({ dateTime: z.string().datetime({ offset: true }), timeZone: z.string().optional() }),
  z.object({ date: z.string().date(), timeZone: z.string().optional() }),
])
const eventSchema = z.object({
  id: idSchema,
  status: z.enum(["confirmed", "tentative", "cancelled"]),
  summary: z.string().optional(), description: z.string().optional(), location: z.string().optional(),
  start: eventResponseTimeSchema.optional(), end: eventResponseTimeSchema.optional(),
  htmlLink: z.string().optional(), etag: z.string().optional(),
  recurringEventId: z.string().optional(),
  attendeesOmitted: z.boolean().optional(),
  attendees: z.array(z.object({ email: z.string().optional(), displayName: z.string().optional(), responseStatus: z.string().optional(), optional: z.boolean().optional() })).max(100).optional(),
})
const eventReceiptSchema = z.object({ ok: z.literal(true), calendarId: z.string(), event: eventSchema, sendUpdates: sendUpdatesSchema.optional() })
const cancelReceiptSchema = z.object({ ok: z.literal(true), calendarId: z.string(), eventId: z.string(), cancelled: z.literal(true), sendUpdates: sendUpdatesSchema })

// Restrict to finite A1 rectangles, never whole columns/rows, named ranges, or arbitrary queries.
function rangeDimensions(value: string) {
  const match = /^(?:(?:'([^'\r\n]|'')+'|[A-Za-z_][A-Za-z0-9_ ]*)!)?\$?([A-Za-z]{1,3})\$?([1-9][0-9]{0,6})(?::\$?([A-Za-z]{1,3})\$?([1-9][0-9]{0,6}))?$/.exec(value)
  if (!match) return null
  const column = (letters: string) => [...letters.toUpperCase()].reduce((n, letter) => n * 26 + letter.charCodeAt(0) - 64, 0)
  const firstColumn = column(match[2])
  const lastColumn = match[4] ? column(match[4]) : firstColumn
  const firstRow = Number(match[3])
  const lastRow = match[5] ? Number(match[5]) : firstRow
  const rows = lastRow - firstRow + 1
  const columns = lastColumn - firstColumn + 1
  if (lastColumn > 18_278 || lastRow > 1_000_000 || rows < 1 || rows > 500 || columns < 1 || columns > 100 || rows * columns > 5_000) return null
  return { rows, columns }
}
const rangeSchema = z.string().min(1).max(256).refine((value) => rangeDimensions(value) !== null,
  "Use a bounded A1 cell/rectangle (optionally sheet-qualified), at most 500 rows, 100 columns, and 5,000 cells; no named ranges or whole rows/columns.")
const cellSchema = z.union([z.string().max(50_000), z.number().finite(), z.boolean()])
const valuesSchema = z.array(z.array(cellSchema).min(1).max(100)).min(1).max(500)
  .refine((rows) => rows.reduce((count, row) => count + row.length, 0) <= 5_000, "At most 5,000 cells per request.")
const valuesReadQuery = z.object({ range: rangeSchema, valueRenderOption: z.enum(["FORMATTED_VALUE", "UNFORMATTED_VALUE", "FORMULA"]).default("FORMATTED_VALUE") }).strict()
const valuesWriteSchema = z.object({
  range: rangeSchema,
  values: valuesSchema.describe("Rows of literal strings, numbers, and booleans. Empty strings clear cells; missing trailing cells stay unchanged."),
  valueInputOption: z.enum(["RAW", "USER_ENTERED"]).default("RAW")
    .describe("RAW stores strings literally, including =formulas. USER_ENTERED parses formulas/dates and can execute formulas or fetch external data; requires explicit approval via confirmUserEntered."),
  confirmUserEntered: z.boolean().optional(),
}).strict().superRefine((input, ctx) => {
  if (input.valueInputOption === "USER_ENTERED" && input.confirmUserEntered !== true) ctx.addIssue({ code: "custom", path: ["confirmUserEntered"], message: "Explicit user approval of Google parsing/formula execution is required." })
  const bounds = rangeDimensions(input.range)
  if (bounds && (input.values.length > bounds.rows || input.values.some((row) => row.length > bounds.columns))) ctx.addIssue({ code: "custom", path: ["values"], message: "Values must fit inside the supplied bounded range." })
})
const sheetPropertiesSchema = z.object({
  sheetId: z.number().int(), title: z.string(), index: z.number().int().optional(),
  gridProperties: z.object({ rowCount: z.number().int().optional(), columnCount: z.number().int().optional() }).optional(),
})
const spreadsheetSchema = z.object({
  spreadsheetId: idSchema, spreadsheetUrl: z.string().url(),
  properties: z.object({ title: z.string(), locale: z.string().optional(), timeZone: z.string().optional() }),
  sheets: z.array(z.object({ properties: sheetPropertiesSchema })).max(200),
})
const spreadsheetReceiptSchema = z.object({ ok: z.literal(true), spreadsheet: spreadsheetSchema })
const createSpreadsheetSchema = z.object({
  title: z.string().trim().min(1).max(255),
  sheetTitle: z.string().trim().min(1).max(100).regex(/^[^:\\/?*\[\]]+$/).default("Sheet1"),
  rowCount: z.number().int().min(1).max(10_000).default(1_000),
  columnCount: z.number().int().min(1).max(100).default(26),
}).strict()
const readValuesSchema = z.object({ range: z.string().min(1), majorDimension: z.literal("ROWS").default("ROWS"), values: z.array(z.array(cellSchema).max(100)).max(500).optional() })
const readValuesReceiptSchema = z.object({ ok: z.literal(true), spreadsheetId: z.string(), range: z.string(), majorDimension: z.literal("ROWS"), values: z.array(z.array(cellSchema)), valueRenderOption: valuesReadQuery.shape.valueRenderOption })
const updateValuesSchema = z.object({ spreadsheetId: idSchema, updatedRange: z.string().min(1), updatedRows: z.number().int().nonnegative().max(500), updatedColumns: z.number().int().nonnegative().max(100), updatedCells: z.number().int().nonnegative().max(5_000) })
const writeValuesReceiptSchema = z.object({ ok: z.literal(true), spreadsheetId: z.string(), updatedRange: z.string(), updatedRows: z.number(), updatedColumns: z.number(), updatedCells: z.number(), valueInputOption: valuesWriteSchema.shape.valueInputOption })
const appendValuesSchema = z.object({ spreadsheetId: idSchema, tableRange: z.string().default(""), updates: updateValuesSchema })
const appendValuesReceiptSchema = writeValuesReceiptSchema.extend({ tableRange: z.string() })
const spreadsheetFields = "spreadsheetId,spreadsheetUrl,properties(title,locale,timeZone),sheets(properties(sheetId,title,index,gridProperties(rowCount,columnCount)))"

const folderSchema = z.object({ name: z.string().trim().min(1).max(255), parentId: idSchema.optional() }).strict()
const filePatchSchema = z.object({
  name: z.string().trim().min(1).max(255).optional(),
  addParentId: idSchema.optional().describe("Move destination folder ID. Also supply removeParentId from current file metadata; folder changes use Google addParents/removeParents query parameters."),
  removeParentId: idSchema.optional(),
  trashed: z.boolean().optional().describe("true moves to trash; false restores. Never permanently deletes."),
  confirmTrash: z.boolean().optional().describe("Required explicit user approval when trashed=true; trashing a folder affects its children."),
}).strict().superRefine((input, ctx) => {
  if (input.name === undefined && input.trashed === undefined && input.addParentId === undefined) ctx.addIssue({ code: "custom", message: "Provide a name, move, or trash/restore change." })
  if (Boolean(input.addParentId) !== Boolean(input.removeParentId) || (input.addParentId && input.addParentId === input.removeParentId)) ctx.addIssue({ code: "custom", path: ["addParentId"], message: "A move requires different destination and previous parent IDs." })
  if (input.trashed === true && input.confirmTrash !== true) ctx.addIssue({ code: "custom", path: ["confirmTrash"], message: "Explicit user approval to trash the file/folder is required." })
})
const fileSchema = z.object({ id: idSchema, name: z.string(), mimeType: z.string(), trashed: z.boolean(), parents: z.array(z.string()).optional(), webViewLink: z.string().optional() })
const fileReceiptSchema = z.object({ ok: z.literal(true), file: fileSchema })
const folderMimeType = "application/vnd.google-apps.folder"
const fileFields = "id,name,mimeType,trashed,parents,webViewLink"
const upstreamErrorSchema = z.object({ error: z.literal("google_api_error"), message: z.string() })

function routeDescription(operationId: string, summary: string, response: z.ZodType) {
  return describeRoute({ operationId, tags: ["Capability Sources"], summary, description: "Uses the calling member's selected Google account. Perform mutations only when explicitly requested; selecting or discovering a connector does not authorize a write. Do not automatically retry an uncertain mutation.", responses: {
    200: jsonResponse("Google-confirmed result.", response),
    400: jsonResponse("Invalid bounded request or missing confirmation.", invalidRequestSchema),
    401: jsonResponse("Sign in first.", unauthorizedSchema),
    409: jsonResponse("Connect with the required provider permission.", z.object({ error: z.literal("needs_connection"), message: z.string() })),
    413: jsonResponse("Request exceeds 1 MiB.", z.object({ error: z.literal("invalid_request"), message: z.string() })),
    502: jsonResponse("Google did not confirm the operation; do not blindly retry mutations.", upstreamErrorSchema),
  } })
}
function boundedBody() {
  return bodyLimit({ maxSize: 1024 * 1024, onError: (c) => c.json({ error: "invalid_request", message: "Request exceeds 1 MiB." }, 413) })
}
function unconfirmed(c: Context, mutation: boolean) {
  return c.json({ error: "google_api_error", message: mutation
    ? "Google did not return a valid confirmation. The operation may have completed; check the service before retrying."
    : "Google did not return the requested data in a valid response." }, 502)
}
async function confirmedBody<S extends z.ZodType>(response: Response, schema: S): Promise<z.output<S> | null> {
  if (response.status !== 200 && response.status !== 201) return null
  try {
    const body = await readGoogleActionJson(response)
    const result = schema.safeParse(body)
    return result.success ? result.data : null
  } catch { return null }
}
function calendarUrl(calendarId: string, eventId: string) {
  return new URL(`${googleBase("https://www.googleapis.com")}/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`)
}
function googleBase(fallback: string) { return (env.googleApiBaseUrl ?? fallback).replace(/\/+$/, "") }
function confirmsEventTime(requested: z.infer<typeof eventTimeSchema> | undefined, actual: z.infer<typeof eventTimeSchema> | undefined) {
  if (!requested) return true
  if (!actual) return false
  return "date" in requested
    ? "date" in actual && requested.date === actual.date
    : "dateTime" in actual && Date.parse(requested.dateTime) === Date.parse(actual.dateTime)
}

export function registerGoogleProductivityManagementRoutes<T extends { Variables: OrgRouteVariables }>(routeApp: Hono<T>, deps: GoogleWorkspaceActionDependencies) {
  const app = new Hono<{ Variables: OrgRouteVariables }>()
  app.get(`${base}/calendar-events/:eventId`, routeDescription("getGoogleCalendarEvent", "Read an individual Google Calendar event on a selected calendar", eventReceiptSchema), orgMemberRoute(), paramValidator(eventParams), queryValidator(calendarQuery), async (c) => {
    const { eventId } = c.req.valid("param")
    const { calendarId } = c.req.valid("query")
    const url = calendarUrl(calendarId, eventId)
    url.searchParams.set("maxAttendees", "100")
    const result = await requestGoogleAction(c, deps, calendarReadScopes, url)
    if (!result.ok) return result.reply
    const event = await confirmedBody(result.response, eventSchema)
    if (!event || event.id !== eventId) return unconfirmed(c, false)
    return c.json({ ok: true, calendarId, event })
  })

  app.patch(`${base}/calendar-events/:eventId`, routeDescription("updateGoogleCalendarEvent", "Update or reschedule a Google Calendar event; explicitly approve guest notifications", eventReceiptSchema), orgMemberRoute(), boundedBody(), paramValidator(eventParams), queryValidator(calendarQuery), jsonValidator(eventPatchSchema), async (c) => {
    const { eventId } = c.req.valid("param")
    const { calendarId } = c.req.valid("query")
    const { sendUpdates, confirmNotifications: _confirmation, ...patch } = c.req.valid("json")
    const url = calendarUrl(calendarId, eventId)
    url.searchParams.set("sendUpdates", sendUpdates)
    url.searchParams.set("maxAttendees", "100")
    const result = await requestGoogleAction(c, deps, calendarWriteScopes, url, { method: "PATCH", body: JSON.stringify(patch) })
    if (!result.ok) return result.reply
    const event = await confirmedBody(result.response, eventSchema)
    if (!event || event.id !== eventId || event.status === "cancelled"
      || (patch.summary !== undefined && event.summary !== patch.summary)
      || (patch.description !== undefined && (event.description ?? "") !== patch.description)
      || (patch.location !== undefined && (event.location ?? "") !== patch.location)
      || !confirmsEventTime(patch.start, event.start) || !confirmsEventTime(patch.end, event.end)
      || (patch.attendees && (event.attendeesOmitted || patch.attendees.length !== (event.attendees?.length ?? 0)
        || patch.attendees.some((guest) => !event.attendees?.some((actual) => actual.email?.toLowerCase() === guest.email.toLowerCase()
          && (guest.optional === undefined || Boolean(actual.optional) === guest.optional)))))) return unconfirmed(c, true)
    return c.json({ ok: true, calendarId, event, sendUpdates })
  })

  app.delete(`${base}/calendar-events/:eventId`, routeDescription("deleteGoogleCalendarEvent", "Delete/cancel a Google Calendar event after explicit confirmation", cancelReceiptSchema), orgMemberRoute(), paramValidator(eventParams), queryValidator(cancelQuery), async (c) => {
    const { eventId } = c.req.valid("param")
    const { calendarId, sendUpdates } = c.req.valid("query")
    const url = calendarUrl(calendarId, eventId)
    url.searchParams.set("sendUpdates", sendUpdates)
    const result = await requestGoogleAction(c, deps, calendarWriteScopes, url, { method: "DELETE" })
    if (!result.ok) return result.reply
    // Calendar events.delete returns 204 with no resource body, unlike the other mutations.
    if (result.response.status !== 204) return unconfirmed(c, true)
    return c.json({ ok: true, calendarId, eventId, cancelled: true, sendUpdates })
  })

  app.get(`${base}/spreadsheets/:spreadsheetId`, routeDescription("getGoogleSpreadsheet", "Read Google Sheets spreadsheet metadata and sheet names without grid data", spreadsheetReceiptSchema), orgMemberRoute(), paramValidator(spreadsheetParams), queryValidator(z.object({}).strict()), async (c) => {
    const { spreadsheetId } = c.req.valid("param")
    const url = new URL(`${googleBase("https://sheets.googleapis.com")}/v4/spreadsheets/${spreadsheetId}`)
    url.searchParams.set("fields", spreadsheetFields)
    url.searchParams.set("includeGridData", "false")
    const result = await requestGoogleAction(c, deps, sheetsReadScopes, url)
    if (!result.ok) return result.reply
    const spreadsheet = await confirmedBody(result.response, spreadsheetSchema)
    if (!spreadsheet || spreadsheet.spreadsheetId !== spreadsheetId) return unconfirmed(c, false)
    return c.json({ ok: true, spreadsheet })
  })

  app.post(`${base}/spreadsheets`, routeDescription("createGoogleSpreadsheet", "Create a real Google Sheets spreadsheet with one bounded initial sheet", spreadsheetReceiptSchema), orgMemberRoute(), boundedBody(), queryValidator(z.object({}).strict()), jsonValidator(createSpreadsheetSchema), async (c) => {
    const { title, sheetTitle, rowCount, columnCount } = c.req.valid("json")
    const url = new URL(`${googleBase("https://sheets.googleapis.com")}/v4/spreadsheets`)
    url.searchParams.set("fields", spreadsheetFields)
    const result = await requestGoogleAction(c, deps, sheetsWriteScopes, url, { method: "POST", body: JSON.stringify({ properties: { title }, sheets: [{ properties: { title: sheetTitle, gridProperties: { rowCount, columnCount } } }] }) })
    if (!result.ok) return result.reply
    const spreadsheet = await confirmedBody(result.response, spreadsheetSchema)
    if (!spreadsheet) return unconfirmed(c, true)
    return c.json({ ok: true, spreadsheet })
  })

  app.get(`${base}/spreadsheets/:spreadsheetId/values`, routeDescription("getGoogleSheetsValues", "Read a bounded rectangle of Google Sheets cells", readValuesReceiptSchema), orgMemberRoute(), paramValidator(spreadsheetParams), queryValidator(valuesReadQuery), async (c) => {
    const { spreadsheetId } = c.req.valid("param")
    const { range, valueRenderOption } = c.req.valid("query")
    const url = new URL(`${googleBase("https://sheets.googleapis.com")}/v4/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(range)}`)
    url.searchParams.set("majorDimension", "ROWS")
    url.searchParams.set("valueRenderOption", valueRenderOption)
    const result = await requestGoogleAction(c, deps, sheetsReadScopes, url)
    if (!result.ok) return result.reply
    const data = await confirmedBody(result.response, readValuesSchema)
    const bounds = rangeDimensions(range)
    if (!data || !bounds || (data.values && (data.values.length > bounds.rows || data.values.some((row) => row.length > bounds.columns)))) return unconfirmed(c, false)
    return c.json({ ok: true, spreadsheetId, range: data.range, majorDimension: data.majorDimension, values: data.values ?? [], valueRenderOption })
  })

  app.put(`${base}/spreadsheets/:spreadsheetId/values`, routeDescription("updateGoogleSheetsValues", "Write Google Sheets cells, RAW by default; USER_ENTERED requires explicit approval", writeValuesReceiptSchema), orgMemberRoute(), boundedBody(), paramValidator(spreadsheetParams), queryValidator(z.object({}).strict()), jsonValidator(valuesWriteSchema), async (c) => {
    const { spreadsheetId } = c.req.valid("param")
    const { range, values, valueInputOption } = c.req.valid("json")
    const url = new URL(`${googleBase("https://sheets.googleapis.com")}/v4/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(range)}`)
    url.searchParams.set("valueInputOption", valueInputOption)
    const result = await requestGoogleAction(c, deps, sheetsWriteScopes, url, { method: "PUT", body: JSON.stringify({ range, majorDimension: "ROWS", values }) })
    if (!result.ok) return result.reply
    const data = await confirmedBody(result.response, updateValuesSchema)
    if (!data || data.spreadsheetId !== spreadsheetId || data.updatedCells !== values.reduce((count, row) => count + row.length, 0)
      || data.updatedRows !== values.length || data.updatedColumns !== Math.max(...values.map((row) => row.length))) return unconfirmed(c, true)
    return c.json({ ok: true, ...data, valueInputOption })
  })

  app.post(`${base}/spreadsheets/:spreadsheetId/values/append`, routeDescription("appendGoogleSheetsValues", "Append rows after a Google Sheets table found in a bounded range; inserts rows, RAW by default", appendValuesReceiptSchema), orgMemberRoute(), boundedBody(), paramValidator(spreadsheetParams), queryValidator(z.object({}).strict()), jsonValidator(valuesWriteSchema), async (c) => {
    const { spreadsheetId } = c.req.valid("param")
    const { range, values, valueInputOption } = c.req.valid("json")
    const url = new URL(`${googleBase("https://sheets.googleapis.com")}/v4/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(range)}:append`)
    url.searchParams.set("valueInputOption", valueInputOption)
    url.searchParams.set("insertDataOption", "INSERT_ROWS")
    const result = await requestGoogleAction(c, deps, sheetsWriteScopes, url, { method: "POST", body: JSON.stringify({ range, majorDimension: "ROWS", values }) })
    if (!result.ok) return result.reply
    const data = await confirmedBody(result.response, appendValuesSchema)
    if (!data || data.spreadsheetId !== spreadsheetId || data.updates.spreadsheetId !== spreadsheetId
      || data.updates.updatedCells !== values.reduce((count, row) => count + row.length, 0)
      || data.updates.updatedRows !== values.length || data.updates.updatedColumns !== Math.max(...values.map((row) => row.length))) return unconfirmed(c, true)
    return c.json({ ok: true, ...data.updates, tableRange: data.tableRange, valueInputOption })
  })

  app.post(`${base}/drive-folders`, routeDescription("createGoogleDriveFolder", "Create a Google Drive folder, optionally in a selected parent", fileReceiptSchema), orgMemberRoute(), boundedBody(), queryValidator(z.object({}).strict()), jsonValidator(folderSchema), async (c) => {
    const { name, parentId } = c.req.valid("json")
    const url = new URL(`${googleBase("https://www.googleapis.com")}/drive/v3/files`)
    url.searchParams.set("fields", fileFields)
    url.searchParams.set("supportsAllDrives", "true")
    const result = await requestGoogleAction(c, deps, driveWriteScopes, url, { method: "POST", body: JSON.stringify({ name, mimeType: folderMimeType, ...(parentId ? { parents: [parentId] } : {}) }) })
    if (!result.ok) return result.reply
    const file = await confirmedBody(result.response, fileSchema)
    if (!file || file.mimeType !== folderMimeType || file.name !== name || file.trashed || (parentId && !file.parents?.includes(parentId))) return unconfirmed(c, true)
    return c.json({ ok: true, file })
  })

  app.get(`${base}/drive-files/:fileId`, routeDescription("getGoogleDriveFileMetadata", "Read Google Drive file metadata, including current parent IDs for a move", fileReceiptSchema), orgMemberRoute(), paramValidator(fileParams), queryValidator(z.object({}).strict()), async (c) => {
    const { fileId } = c.req.valid("param")
    const url = new URL(`${googleBase("https://www.googleapis.com")}/drive/v3/files/${fileId}`)
    url.searchParams.set("fields", fileFields)
    url.searchParams.set("supportsAllDrives", "true")
    const result = await requestGoogleAction(c, deps, driveReadScopes, url)
    if (!result.ok) return result.reply
    const file = await confirmedBody(result.response, fileSchema)
    if (!file || file.id !== fileId) return unconfirmed(c, false)
    return c.json({ ok: true, file })
  })

  app.patch(`${base}/drive-files/:fileId`, routeDescription("updateGoogleDriveFileMetadata", "Rename, move, trash, or restore Google Drive file metadata; never permanently delete", fileReceiptSchema), orgMemberRoute(), boundedBody(), paramValidator(fileParams), queryValidator(z.object({}).strict()), jsonValidator(filePatchSchema), async (c) => {
    const { fileId } = c.req.valid("param")
    const { name, trashed, addParentId, removeParentId } = c.req.valid("json")
    if (addParentId === fileId) return c.json({ error: "invalid_request", details: [{ message: "Cannot move a folder into itself." }] }, 400)
    const url = new URL(`${googleBase("https://www.googleapis.com")}/drive/v3/files/${fileId}`)
    url.searchParams.set("fields", fileFields)
    url.searchParams.set("supportsAllDrives", "true")
    if (addParentId) url.searchParams.set("addParents", addParentId)
    if (removeParentId) url.searchParams.set("removeParents", removeParentId)
    const result = await requestGoogleAction(c, deps, driveWriteScopes, url, { method: "PATCH", body: JSON.stringify({ name, trashed }) })
    if (!result.ok) return result.reply
    const file = await confirmedBody(result.response, fileSchema)
    if (!file || file.id !== fileId || (name !== undefined && file.name !== name) || (trashed !== undefined && file.trashed !== trashed)
      || (addParentId && !file.parents?.includes(addParentId)) || (removeParentId && file.parents?.includes(removeParentId))) return unconfirmed(c, true)
    return c.json({ ok: true, file })
  })
  routeApp.route("/", app)
}
