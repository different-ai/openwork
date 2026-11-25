import { officeFileTypeSchema, officeFormats, officeMimeTypes } from "@openwork/documents/office-engine"
import { validateOfficePackage } from "@openwork/documents/office-server"
import { Hono, type MiddlewareHandler } from "hono"
import { describeRoute, type DescribeRouteOptions } from "hono-openapi"
import { z } from "zod"
import { documentIdSchema, editorDocumentSchema, type TextDocument } from "@openwork/documents/model"
import { openExcel, openWord, openOfficeTextPreview, columnLetters } from "@openwork/documents/office"
import { env } from "../../env.js"
import { orgMemberRoute, paramValidator, queryValidator } from "../../middleware/index.js"
import { jsonResponse } from "../../openapi.js"
import { documentMediaKind, documentMediaRange, documentMediaRangeHeader, documentMediaResponse, documentMediaUnsatisfiable, readDocumentMediaRange } from "./document-media.js"
import { readGoogleActionJson, requestGoogleAction, type GoogleWorkspaceActionDependencies } from "./google-workspace-actions.js"
import type { OrgRouteVariables } from "./shared.js"

const scope = "https://www.googleapis.com/auth/"
const readScopes = [scope + "drive.readonly", scope + "drive"]
const sheetReadScopes = [...readScopes, scope + "spreadsheets.readonly", scope + "spreadsheets"]
const connectionSchema = z.string().regex(/^(google-workspace|emc_[A-Za-z0-9]+)$/)
const params = z.object({ fileId: documentIdSchema })
const query = z.object({ sheetId: z.string().max(200).optional(), startRow: z.coerce.number().int().min(1).max(1_048_526).default(1), connectionId: connectionSchema.optional() }).strict()
const fileSchema = z.object({ id: documentIdSchema, name: z.string(), mimeType: z.string(), version: z.string(), headRevisionId: z.string().optional(), size: z.string().optional(), modifiedTime: z.string().optional(), webViewLink: z.string().optional(), trashed: z.boolean().optional() })
const XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
const DOC = "application/vnd.google-apps.document"
const SHEET = "application/vnd.google-apps.spreadsheet"
const SLIDES = "application/vnd.google-apps.presentation"
const MAX_BYTES = 12 * 1024 * 1024
const base = "/v1/documents/google-drive/files/:fileId"
const errorSchema = z.object({ error: z.string(), message: z.string() })
const readFile = (fileId: string) => { const url = new URL(`${env.googleApiBaseUrl ?? "https://www.googleapis.com"}/drive/v3/files/${fileId}`); url.searchParams.set("fields", "id,name,mimeType,version,headRevisionId,size,modifiedTime,webViewLink,trashed"); url.searchParams.set("supportsAllDrives", "true"); return url }
const googleUrl = (host: string, path: string) => new URL(`${env.googleApiBaseUrl ?? host}${path}`)
const conflict = (c: Parameters<typeof requestGoogleAction>[0]) => c.json({ error: "drive_conflict", message: "This file changed in Drive. Reload it to see the latest version." }, 409)
const failure = (c: Parameters<typeof requestGoogleAction>[0], message: string) => c.json({ error: "document_unavailable", message }, 400)
async function boundedBytes(response: Response, max = MAX_BYTES) {
  if (Number(response.headers.get("content-length")) > max) { await response.body?.cancel(); throw new Error("This file is too large to preview.") }
  if (!response.body) return new Uint8Array()
  const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let size = 0
  try { for (;;) { const next = await reader.read(); if (next.done) break; size += next.value.byteLength; if (size > max) throw new Error("This file is too large to preview."); chunks.push(next.value) } }
  finally { await reader.cancel().catch(() => {}); reader.releaseLock() }
  const bytes = new Uint8Array(size); let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength } return bytes
}
const textRunSchema = z.object({ startIndex: z.number().int().optional(), endIndex: z.number().int().optional(), textRun: z.object({ content: z.string(), textStyle: z.record(z.string(), z.unknown()).optional() }).optional() })
const contentSchema = z.object({ paragraph: z.object({ elements: z.array(textRunSchema), paragraphStyle: z.object({ namedStyleType: z.string().optional() }).optional() }).optional() })
const docTabSchema = z.object({ tabProperties: z.object({ tabId: z.string(), title: z.string() }), documentTab: z.object({ body: z.object({ content: z.array(contentSchema) }).optional() }).optional(), childTabs: z.array(z.unknown()).optional() })
const docSchema = z.object({ revisionId: z.string(), tabs: z.array(z.unknown()).optional(), body: z.object({ content: z.array(contentSchema) }).optional() })
function docSections(data: z.infer<typeof docSchema>) {
  const sections: TextDocument["sections"] = []
  const visit = (tabs: unknown[], depth = 0) => {
    if (depth > 4) throw new Error("This document has too many nested tabs.")
    for (const raw of tabs) {
      if (sections.length >= 64) throw new Error("This document has too many tabs.")
      const parsed = docTabSchema.parse(raw); const content = parsed.documentTab?.body?.content ?? []
      sections.push({ id: parsed.tabProperties.tabId, name: parsed.tabProperties.title, paragraphs: paragraphs(content) })
      visit(parsed.childTabs ?? [], depth + 1)
    }
  }
  const paragraphs = (content: z.infer<typeof contentSchema>[]) => content.flatMap((block, index) => block.paragraph ? [{ id: String(index), heading: block.paragraph.paragraphStyle?.namedStyleType?.startsWith("HEADING") === true, runs: block.paragraph.elements.flatMap(element => {
    if (!element.textRun || element.startIndex === undefined || element.endIndex === undefined) return []
    const text = element.textRun.content.replace(/\n$/, "")
    const id = `${element.startIndex}:${element.startIndex + text.length}`
    const style = element.textRun.textStyle ?? {}
    return [{ id, text, bold: style.bold === true, italic: style.italic === true, underline: style.underline === true }]
  }) }] : [])
  if (data.tabs?.length) visit(data.tabs)
  else sections.push({ id: "", name: "Document", paragraphs: paragraphs(data.body?.content ?? []) })
  return sections
}
const sheetSchema = z.object({ properties: z.object({ sheetId: z.number().int(), title: z.string(), gridProperties: z.object({ rowCount: z.number().int().optional(), columnCount: z.number().int().optional() }).optional() }), data: z.array(z.object({ startRow: z.number().int().optional(), startColumn: z.number().int().optional(), rowData: z.array(z.object({ values: z.array(z.object({ formattedValue: z.string().optional(), userEnteredValue: z.object({ stringValue: z.string().optional(), numberValue: z.number().optional(), boolValue: z.boolean().optional(), formulaValue: z.string().optional() }).optional() })).optional() })).optional() })).optional() })
const sheetsSchema = z.object({ spreadsheetId: z.string(), sheets: z.array(sheetSchema) })

export function registerGoogleDocumentEditorRoutes<T extends { Variables: OrgRouteVariables }>(routeApp: Hono<T>, deps: GoogleWorkspaceActionDependencies) {
  const app = new Hono<{ Variables: OrgRouteVariables }>()
  const guard: MiddlewareHandler<{ Variables: OrgRouteVariables }> = async (c, next) => {
    const context = c.get("organizationContext")
    if (!context?.features.workbotDocuments) return c.json({ error: "feature_disabled", message: "Documents is off for this workspace." }, 403)
    await next()
  }
  const description = (operationId: string, summary: string, schema: z.ZodType) => { const options: DescribeRouteOptions & { "x-mcp": false } = { operationId, tags: ["Documents"], "x-mcp": false, summary, description: "Requires organization membership, Workbot and Documents, and the member’s currently authorized Drive connection. Reads recheck provider access.", responses: { 200: jsonResponse("Document result.", schema), 400: jsonResponse("The file cannot be shown.", errorSchema), 409: jsonResponse("Reconnect or reload the changed file.", errorSchema) } }; return describeRoute(options) }
  const authorize = async (c: Parameters<typeof requestGoogleAction>[0], connectionId?: string) => {
    const context = c.get("organizationContext")
    if (!context) return { ok: false, reply: c.json({ error: "unauthorized", message: "Sign in to your workspace." }, 401) } as const
    const token = await deps.token({ organizationId: context.organization.id, orgMembershipId: context.currentMember.id, connectionId: connectionId ?? null })
    if (token.kind !== "ok") return { ok: false, reply: c.json({ error: token.kind, message: token.message }, token.kind === "policy_blocked" ? 403 : 409) } as const
    if (!token.connectionId) return { ok: false, reply: c.json({ error: "needs_connection", message: "Connect Google Drive to open documents." }, 409) } as const
    const selected = { ...deps, token: (identity: Parameters<typeof deps.token>[0]) => deps.token({ ...identity, connectionId: token.connectionId }) }
    return { ok: true, token, connectionId: token.connectionId, selected } as const
  }
  const metadata = async (c: Parameters<typeof requestGoogleAction>[0], selected: GoogleWorkspaceActionDependencies, fileId: string) => {
    const result = await requestGoogleAction(c, selected, readScopes, readFile(fileId))
    if (!result.ok) return result
    const file = fileSchema.safeParse(await readGoogleActionJson(result.response))
    if (!file.success || file.data.id !== fileId || file.data.trashed) return { ok: false, reply: failure(c, "This file is unavailable or in the trash.") } as const
    return { ok: true, file: file.data } as const
  }
  const media = async (c: Parameters<typeof requestGoogleAction>[0], selected: GoogleWorkspaceActionDependencies, fileId: string, range?: string) => { const url = readFile(fileId); url.searchParams.delete("fields"); url.searchParams.set("alt", "media"); return requestGoogleAction(c, selected, readScopes, url, range ? { headers: { range } } : {}) }
  const exportPdf = async (c: Parameters<typeof requestGoogleAction>[0], selected: GoogleWorkspaceActionDependencies, fileId: string) => { const url = googleUrl("https://www.googleapis.com", `/drive/v3/files/${fileId}/export`); url.searchParams.set("mimeType", "application/pdf"); return requestGoogleAction(c, selected, readScopes, url) }
  const readDoc = async (c: Parameters<typeof requestGoogleAction>[0], selected: GoogleWorkspaceActionDependencies, fileId: string) => { const url = googleUrl("https://docs.googleapis.com", `/v1/documents/${fileId}`); url.searchParams.set("includeTabsContent", "true"); const result = await requestGoogleAction(c, selected, readScopes, url); if (!result.ok) return result; const data = docSchema.safeParse(await readGoogleActionJson(result.response)); return data.success ? { ok: true, data: data.data } as const : { ok: false, reply: failure(c, "Google could not return this document.") } as const }

  const itemSchema = z.object({ id: documentIdSchema, name: z.string(), mimeType: z.string(), modifiedTime: z.string().nullable(), size: z.number().nullable(), openUrl: z.string().nullable() })
  app.get(`${base}/metadata`, description("getGoogleDriveDocumentMetadata", "Resolve an authorized Drive document link without downloading content", itemSchema), orgMemberRoute(), guard, paramValidator(params), queryValidator(z.object({}).strict()), async c => {
    const context = c.get("organizationContext")
    if (!context?.features.workbotWorkspaceAssistant) return c.json({ error: "feature_disabled", message: "Opening document links is off for this workspace." }, 403)
    const { fileId } = c.req.valid("param")
    const auth = await authorize(c); if (!auth.ok) return auth.reply
    const meta = await metadata(c, auth.selected, fileId); if (!meta.ok) return meta.reply
    const file = meta.file
    const size = file.size === undefined ? null : Number(file.size)
    c.header("cache-control", "no-store")
    return c.json({ id: file.id, name: file.name, mimeType: file.mimeType, modifiedTime: file.modifiedTime ?? null, size: size !== null && Number.isSafeInteger(size) && size >= 0 ? size : null, openUrl: file.webViewLink ?? `https://drive.google.com/file/d/${encodeURIComponent(file.id)}/view` })
  })

  app.get(`${base}/editor`, description("openGoogleDriveDocumentEditor", "Open a read-only view of a Drive document", editorDocumentSchema), orgMemberRoute(), guard, paramValidator(params), queryValidator(query), async c => {
    const { fileId } = c.req.valid("param"); const input = c.req.valid("query")
    const auth = await authorize(c, input.connectionId); if (!auth.ok) return auth.reply
    const meta = await metadata(c, auth.selected, fileId); if (!meta.ok) return meta.reply
    const file = meta.file
    const common = { fileId, name: file.name, revision: file.headRevisionId ?? file.version, canEdit: false, connectionId: auth.connectionId }
    c.header("cache-control", "no-store")
    try {
      if (file.mimeType === DOC) { const result = await readDoc(c, auth.selected, fileId); if (!result.ok) return result.reply; return c.json({ ...common, kind: "document", source: "google", revision: result.data.revisionId, sections: docSections(result.data), notice: "Text preview. Tables, images and layout are available in the original document." }) }
      if (file.mimeType === SHEET) {
        const info = await requestGoogleAction(c, auth.selected, sheetReadScopes, googleUrl("https://sheets.googleapis.com", `/v4/spreadsheets/${fileId}?fields=spreadsheetId,sheets(properties)`)); if (!info.ok) return info.reply
        const parsed = sheetsSchema.parse(await readGoogleActionJson(info.response)); const sheet = input.sheetId ? parsed.sheets.find(item => String(item.properties.sheetId) === input.sheetId) : parsed.sheets[0]; if (!sheet) return failure(c, "This spreadsheet has no sheets.")
        const endRow = Math.min(input.startRow + 49, sheet.properties.gridProperties?.rowCount ?? 1000)
        if (input.startRow > endRow) return failure(c, "This worksheet has no rows in this range.")
        const endColumn = columnLetters(Math.min(26, sheet.properties.gridProperties?.columnCount ?? 26))
        const range = `'${sheet.properties.title.replace(/'/g, "''")}'!A${input.startRow}:${endColumn}${endRow}`
        const url = googleUrl("https://sheets.googleapis.com", `/v4/spreadsheets/${fileId}`); url.searchParams.set("ranges", range); url.searchParams.set("includeGridData", "true"); url.searchParams.set("fields", "spreadsheetId,sheets(properties,data(startRow,startColumn,rowData(values(formattedValue,userEnteredValue))))")
        const result = await requestGoogleAction(c, auth.selected, sheetReadScopes, url); if (!result.ok) return result.reply
        const data = sheetsSchema.parse(await readGoogleActionJson(result.response)); const cells = []
        for (const grid of data.sheets[0]?.data ?? []) for (const [row, rowData] of (grid.rowData ?? []).entries()) for (const [column, cell] of (rowData.values ?? []).entries()) cells.push({ row: (grid.startRow ?? input.startRow - 1) + row + 1, column: (grid.startColumn ?? 0) + column + 1, text: String(cell.userEnteredValue?.stringValue ?? cell.userEnteredValue?.numberValue ?? cell.userEnteredValue?.boolValue ?? cell.formattedValue ?? ""), ...(cell.userEnteredValue?.formulaValue ? { formula: cell.userEnteredValue.formulaValue.replace(/^=/, "") } : {}) })
        const after = await metadata(c, auth.selected, fileId); if (!after.ok) return after.reply; if (after.file.version !== file.version) return conflict(c)
        return c.json({ ...common, kind: "spreadsheet", source: "google", sheets: parsed.sheets.map(s => ({ id: String(s.properties.sheetId), name: s.properties.title, rows: s.properties.gridProperties?.rowCount ?? 1000, columns: s.properties.gridProperties?.columnCount ?? 26 })), activeSheetId: String(sheet.properties.sheetId), startRow: input.startRow, endRow, cells })
      }
      if (officeMimeTypes.has(file.mimeType) || file.mimeType.startsWith("text/")) {
        const result = await media(c, auth.selected, fileId); if (!result.ok) return result.reply
        const bytes = await boundedBytes(result.response, file.mimeType.startsWith("text/") ? 1_000_000 : MAX_BYTES)
        const after = await metadata(c, auth.selected, fileId); if (!after.ok) return after.reply; if (after.file.version !== file.version) return conflict(c)
        if (file.mimeType === XLSX) return c.json({ ...common, ...await openExcel(bytes, input) })
        if (file.mimeType === DOCX) return c.json({ ...common, ...await openWord(bytes) })
        const officeType = officeFileTypeSchema.options.find(type => officeFormats[type].mimeType === file.mimeType)
        if (officeType) {
          await validateOfficePackage(bytes, officeType)
          const text = await openOfficeTextPreview(bytes, officeType)
          return c.json({ ...common, kind: "text", text, notice: "Text preview. Layout and images are available in the original file." })
        }
        return c.json({ ...common, kind: "text", text: new TextDecoder("utf-8", { fatal: true }).decode(bytes) })
      }
      const playable = documentMediaKind(file.mimeType)
      return c.json({ ...common, kind: "preview", mimeType: file.mimeType, canEdit: false, ...(playable ? { media: playable } : {}), ...(file.mimeType === SLIDES ? { notice: "Preview only. Open in Google Slides to edit; changes stay in the original presentation." } : {}) })
    } catch (error) {
      if (officeMimeTypes.has(file.mimeType)) return c.json({ ...common, kind: "preview", mimeType: file.mimeType })
      return failure(c, error instanceof Error ? error.message : "This file cannot be previewed.")
    }
  })

  app.get(`${base}/content`, description("readGoogleDriveDocumentContent", "Preview a Drive PDF or image, or play a video or audio file", z.unknown()), orgMemberRoute(), guard, paramValidator(params), queryValidator(z.object({ connectionId: connectionSchema })), async c => {
    const { fileId } = c.req.valid("param"); const auth = await authorize(c, c.req.valid("query").connectionId); if (!auth.ok) return auth.reply
    const meta = await metadata(c, auth.selected, fileId); if (!meta.ok) return meta.reply
    const slides = meta.file.mimeType === SLIDES
    const playable = documentMediaKind(meta.file.mimeType)
    if (playable) {
      const size = Number(meta.file.size)
      const range = documentMediaRange(c.req.header("range"), size)
      if (!range) return documentMediaUnsatisfiable(size)
      const result = await media(c, auth.selected, fileId, documentMediaRangeHeader(range)); if (!result.ok) return result.reply
      try { return documentMediaResponse(await readDocumentMediaRange(result.response, range), { mimeType: meta.file.mimeType, range, size }) } catch { return c.json({ error: "google_api_error", message: "Google did not return this part of the file. Try again." }, 502) }
    }
    if (!slides && !["application/pdf", "image/png", "image/jpeg", "image/gif", "image/webp"].includes(meta.file.mimeType)) return failure(c, "This file has no safe inline preview.")
    const result = slides ? await exportPdf(c, auth.selected, fileId) : await media(c, auth.selected, fileId); if (!result.ok) return result.reply
    try { const bytes = await boundedBytes(result.response); return new Response(new Uint8Array(bytes).buffer, { headers: { "content-type": slides ? "application/pdf" : meta.file.mimeType, "cache-control": "no-store", "x-content-type-options": "nosniff", "content-security-policy": "default-src 'none'; sandbox" } }) } catch { return failure(c, "This preview is too large.") }
  })
  routeApp.route("/", app)
}
