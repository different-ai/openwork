import { officeFileTypeSchema, officeFormats, officeMimeTypes } from "@openwork/documents/office-engine"
import { validateOfficePackage } from "@openwork/documents/office-server"
import { Hono, type MiddlewareHandler } from "hono"
import { bodyLimit } from "hono/body-limit"
import { describeRoute, type DescribeRouteOptions } from "hono-openapi"
import { z } from "zod"
import { documentIdSchema, documentSaveSchema, editorDocumentSchema, type EditorDocument, type TextDocument } from "@openwork/documents/model"
import { openExcel, openWord, openOfficeTextPreview, patchExcel, patchWord, columnLetters } from "@openwork/documents/office"
import { cellInputFromText, unsafeFormulaReason } from "@openwork/documents/office"
import { env } from "../../env.js"
import { orgMemberRoute, jsonValidator, paramValidator, queryValidator } from "../../middleware/index.js"
import { jsonResponse } from "../../openapi.js"
import { readGoogleActionJson, requestGoogleAction, type GoogleWorkspaceActionDependencies } from "./google-workspace-actions.js"
import type { OrgRouteVariables } from "./shared.js"

const scope = "https://www.googleapis.com/auth/"
const readScopes = [scope + "drive.readonly", scope + "drive"]
const writeScopes = [scope + "drive"]
const sheetReadScopes = [...readScopes, scope + "spreadsheets.readonly", scope + "spreadsheets"]
const sheetWriteScopes = [...writeScopes, scope + "spreadsheets"]
const connectionSchema = z.string().regex(/^(google-workspace|emc_[A-Za-z0-9]+)$/)
const params = z.object({ fileId: documentIdSchema })
const query = z.object({ sheetId: z.string().max(200).optional(), startRow: z.coerce.number().int().min(1).max(1_048_526).default(1), connectionId: connectionSchema.optional() }).strict()
const fileSchema = z.object({ id: documentIdSchema, name: z.string(), mimeType: z.string(), version: z.string(), headRevisionId: z.string().optional(), size: z.string().optional(), modifiedTime: z.string().optional(), webViewLink: z.string().optional(), trashed: z.boolean().optional(), capabilities: z.object({ canEdit: z.boolean().optional() }).optional() })
const XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
const DOC = "application/vnd.google-apps.document"
const SHEET = "application/vnd.google-apps.spreadsheet"
const SLIDES = "application/vnd.google-apps.presentation"
const MAX_BYTES = 12 * 1024 * 1024
const base = "/v1/documents/google-drive/files/:fileId"
const errorSchema = z.object({ error: z.string(), message: z.string() })
const readFile = (fileId: string) => { const url = new URL(`${env.googleApiBaseUrl ?? "https://www.googleapis.com"}/drive/v3/files/${fileId}`); url.searchParams.set("fields", "id,name,mimeType,version,headRevisionId,size,modifiedTime,webViewLink,trashed,capabilities(canEdit)"); url.searchParams.set("supportsAllDrives", "true"); return url }
const googleUrl = (host: string, path: string) => new URL(`${env.googleApiBaseUrl ?? host}${path}`)
const conflict = (c: Parameters<typeof requestGoogleAction>[0]) => c.json({ error: "drive_conflict", message: "This file changed in Drive. Your edits are kept here; reload the file before saving again." }, 409)
const failure = (c: Parameters<typeof requestGoogleAction>[0], message: string) => c.json({ error: "document_unavailable", message }, 400)
async function boundedBytes(response: Response, max = MAX_BYTES) {
  if (Number(response.headers.get("content-length")) > max) { await response.body?.cancel(); throw new Error("This file is too large for inline editing.") }
  if (!response.body) return new Uint8Array()
  const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let size = 0
  try { for (;;) { const next = await reader.read(); if (next.done) break; size += next.value.byteLength; if (size > max) throw new Error("This file is too large for inline editing."); chunks.push(next.value) } }
  finally { await reader.cancel().catch(() => {}); reader.releaseLock() }
  const bytes = new Uint8Array(size); let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength } return bytes
}
const textRunSchema = z.object({ startIndex: z.number().int().optional(), endIndex: z.number().int().optional(), textRun: z.object({ content: z.string(), textStyle: z.record(z.string(), z.unknown()).optional() }).optional() })
const contentSchema = z.object({ paragraph: z.object({ elements: z.array(textRunSchema), paragraphStyle: z.object({ namedStyleType: z.string().optional() }).optional() }).optional() })
const docTabSchema = z.object({ tabProperties: z.object({ tabId: z.string(), title: z.string() }), documentTab: z.object({ body: z.object({ content: z.array(contentSchema) }).optional() }).optional(), childTabs: z.array(z.unknown()).optional() })
const docSchema = z.object({ revisionId: z.string(), tabs: z.array(z.unknown()).optional(), body: z.object({ content: z.array(contentSchema) }).optional() })
function docSections(data: z.infer<typeof docSchema>, onStyle?: (sectionId: string, runId: string, style: Record<string, unknown>) => void) {
  const sections: TextDocument["sections"] = []
  const visit = (tabs: unknown[], depth = 0) => {
    if (depth > 4) throw new Error("This document has too many nested tabs.")
    for (const raw of tabs) {
      if (sections.length >= 64) throw new Error("This document has too many tabs.")
      const parsed = docTabSchema.parse(raw); const content = parsed.documentTab?.body?.content ?? []
      sections.push({ id: parsed.tabProperties.tabId, name: parsed.tabProperties.title, paragraphs: paragraphs(content, parsed.tabProperties.tabId) })
      visit(parsed.childTabs ?? [], depth + 1)
    }
  }
  const paragraphs = (content: z.infer<typeof contentSchema>[], sectionId: string) => content.flatMap((block, index) => block.paragraph ? [{ id: String(index), heading: block.paragraph.paragraphStyle?.namedStyleType?.startsWith("HEADING") === true, runs: block.paragraph.elements.flatMap(element => {
    if (!element.textRun || element.startIndex === undefined || element.endIndex === undefined) return []
    const text = element.textRun.content.replace(/\n$/, "")
    const id = `${element.startIndex}:${element.startIndex + text.length}`
    const style = element.textRun.textStyle ?? {}
    onStyle?.(sectionId, id, style)
    return [{ id, text, bold: style.bold === true, italic: style.italic === true, underline: style.underline === true }]
  }) }] : [])
  if (data.tabs?.length) visit(data.tabs)
  else sections.push({ id: "", name: "Document", paragraphs: paragraphs(data.body?.content ?? [], "") })
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
  const description = (operationId: string, summary: string, schema: z.ZodType) => { const options: DescribeRouteOptions & { "x-mcp": false } = { operationId, tags: ["Documents"], "x-mcp": false, summary, description: "Requires organization membership, Workbot and Documents, and the member’s currently authorized Drive connection. Reads recheck provider access. Writes require current grants, explicit edits and a matching revision.", responses: { 200: jsonResponse("Document result.", schema), 400: jsonResponse("Unsupported edit.", errorSchema), 409: jsonResponse("Reconnect or reload the changed file.", errorSchema) } }; return describeRoute(options) }
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
  const media = async (c: Parameters<typeof requestGoogleAction>[0], selected: GoogleWorkspaceActionDependencies, fileId: string) => { const url = readFile(fileId); url.searchParams.delete("fields"); url.searchParams.set("alt", "media"); return requestGoogleAction(c, selected, readScopes, url) }
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

  app.get(`${base}/editor`, description("openGoogleDriveDocumentEditor", "Open a Drive document in the inline editor", editorDocumentSchema), orgMemberRoute(), guard, paramValidator(params), queryValidator(query), async c => {
    const { fileId } = c.req.valid("param"); const input = c.req.valid("query")
    const auth = await authorize(c, input.connectionId); if (!auth.ok) return auth.reply
    const meta = await metadata(c, auth.selected, fileId); if (!meta.ok) return meta.reply
    const file = meta.file
    const permitted = file.mimeType === SHEET ? sheetWriteScopes : writeScopes
    const canEdit = c.get("organizationContext")!.features.workbotDocumentEditing && file.capabilities?.canEdit === true && permitted.some(s => auth.token.account.scopes?.includes(s) && auth.token.enabledScopes.includes(s))
    const common = { fileId, name: file.name, revision: file.headRevisionId ?? file.version, canEdit, connectionId: auth.connectionId }
    c.header("cache-control", "no-store")
    try {
      if (file.mimeType === DOC) { const result = await readDoc(c, auth.selected, fileId); if (!result.ok) return result.reply; return c.json({ ...common, kind: "document", source: "google", revision: result.data.revisionId, sections: docSections(result.data), notice: "Inline text editing. Tables, images and other layouts remain in the original document." }) }
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
      return c.json({ ...common, kind: "preview", mimeType: file.mimeType, canEdit: false, ...(file.mimeType === SLIDES ? { notice: "Preview only. Open in Google Slides to edit; changes stay in the original presentation." } : {}) })
    } catch (error) {
      // A limited reader must not force an Office startup or hide the explicit Edit action.
      if (officeMimeTypes.has(file.mimeType)) return c.json({ ...common, kind: "preview", mimeType: file.mimeType })
      return failure(c, error instanceof Error ? error.message : "This file cannot be edited inline.")
    }
  })

  app.post(`${base}/editor`, description("saveGoogleDriveDocumentEdits", "Save explicit inline edits to the same Drive file", z.object({ ok: z.literal(true) })), orgMemberRoute(), guard, bodyLimit({ maxSize: 2 * 1024 * 1024 }), paramValidator(params), jsonValidator(documentSaveSchema), async c => {
    const context = c.get("organizationContext")!
    if (!context.features.workbotDocumentEditing) return c.json({ error: "feature_disabled", message: "Document editing is off for this workspace." }, 403)
    const { fileId } = c.req.valid("param"); const save = c.req.valid("json")
    const auth = await authorize(c, save.connectionId); if (!auth.ok) return auth.reply
    const meta = await metadata(c, auth.selected, fileId); if (!meta.ok) return meta.reply
    const file = meta.file
    if (!file.capabilities?.canEdit) return c.json({ error: "read_only", message: "You have read-only access to this file." }, 403)
    c.header("cache-control", "no-store")
    try {
      if (file.mimeType === DOC && save.kind === "document") {
        const current = await readDoc(c, auth.selected, fileId); if (!current.ok) return current.reply; if (current.data.revisionId !== save.revision) return conflict(c)
        const styles = new Map<string, Record<string, unknown>>()
        const sections = docSections(current.data, (sectionId, runId, style) => styles.set(JSON.stringify([sectionId, runId]), style)); const seen = new Set<string>(); const requests = []
        const changes = save.changes.map(change => { const run = sections.find(s => s.id === change.sectionId)?.paragraphs.flatMap(p => p.runs).find(r => r.id === change.runId); const key = `${change.sectionId}:${change.runId}`; if (!run || seen.has(key)) throw new Error("The edited text no longer exists."); seen.add(key); return { ...change, run } }).sort((a,b) => Number(b.runId.split(":")[0]) - Number(a.runId.split(":")[0]))
        for (const change of changes) {
          const [startIndex, endIndex] = change.runId.split(":").map(Number); const tab = change.sectionId ? { tabId: change.sectionId } : {}
          if (endIndex > startIndex) requests.push({ deleteContentRange: { range: { startIndex, endIndex, ...tab } } })
          if (change.value) { requests.push({ insertText: { location: { index: startIndex, ...tab }, text: change.value } }); const style = Object.fromEntries(Object.entries(styles.get(JSON.stringify([change.sectionId, change.runId])) ?? {}).filter(([key]) => ["bold", "italic", "underline", "strikethrough", "smallCaps", "fontSize", "weightedFontFamily", "foregroundColor", "backgroundColor", "baselineOffset", "link"].includes(key))); if (Object.keys(style).length) requests.push({ updateTextStyle: { range: { startIndex, endIndex: startIndex + change.value.length, ...tab }, textStyle: style, fields: Object.keys(style).join(",") } }) }
        }
        const result = await requestGoogleAction(c, auth.selected, writeScopes, googleUrl("https://docs.googleapis.com", `/v1/documents/${fileId}:batchUpdate`), { method: "POST", body: JSON.stringify({ writeControl: { requiredRevisionId: save.revision }, requests }) }); if (!result.ok) return result.reply
        await result.response.body?.cancel(); return c.json({ ok: true })
      }
      if ((file.headRevisionId ?? file.version) !== save.revision) return conflict(c)
      if (file.mimeType === SHEET && save.kind === "spreadsheet") {
        if (!/^\d+$/.test(save.sheetId)) return failure(c, "Invalid worksheet.")
        const seen = new Set<string>()
        const requests = save.changes.map(change => { const key = `${change.row}:${change.column}`; if (seen.has(key)) throw new Error("A cell appears more than once."); seen.add(key); if (change.formula && unsafeFormulaReason(change.value)) throw new Error("This formula reaches outside the spreadsheet or is unsupported."); const value = cellInputFromText(change.value); const userEnteredValue = change.formula ? { formulaValue: `=${change.value.replace(/^=/, "")}` } : typeof value === "number" ? { numberValue: value } : typeof value === "boolean" ? { boolValue: value } : { stringValue: change.value }; return { updateCells: { range: { sheetId: Number(save.sheetId), startRowIndex: change.row - 1, endRowIndex: change.row, startColumnIndex: change.column - 1, endColumnIndex: change.column }, rows: [{ values: [{ userEnteredValue }] }], fields: "userEnteredValue" } } })
        const result = await requestGoogleAction(c, auth.selected, sheetWriteScopes, googleUrl("https://sheets.googleapis.com", `/v4/spreadsheets/${fileId}:batchUpdate`), { method: "POST", body: JSON.stringify({ requests }) }); if (!result.ok) return result.reply; await result.response.body?.cancel(); return c.json({ ok: true })
      }
      const source = await media(c, auth.selected, fileId); if (!source.ok) return source.reply
      const bytes = await boundedBytes(source.response)
      let updated: Uint8Array
      if (file.mimeType === XLSX && save.kind === "spreadsheet") updated = await patchExcel(bytes, save)
      else if (file.mimeType === DOCX && save.kind === "document") updated = await patchWord(bytes, save)
      else if (file.mimeType.startsWith("text/") && save.kind === "text") updated = new TextEncoder().encode(save.text)
      else return failure(c, "This file type does not support these edits.")
      const after = await metadata(c, auth.selected, fileId); if (!after.ok) return after.reply; if (after.file.version !== file.version) return conflict(c)
      const uploadDeps = { ...auth.selected, fetch: (input: Parameters<typeof fetch>[0], init?: RequestInit) => { const headers = new Headers(init?.headers); headers.set("content-type", file.mimeType); return auth.selected.fetch(input, { ...init, headers }) } }
      const url = googleUrl("https://www.googleapis.com", `/upload/drive/v3/files/${fileId}?uploadType=media&supportsAllDrives=true&fields=id,version`)
      const result = await requestGoogleAction(c, uploadDeps, writeScopes, url, { method: "PATCH", body: new Uint8Array(updated).buffer, redirect: "error" }); if (!result.ok) return result.reply
      const receipt = z.object({ id: z.string() }).safeParse(await readGoogleActionJson(result.response)); if (!receipt.success || receipt.data.id !== fileId) return c.json({ error: "save_unconfirmed", message: "Google did not confirm the save. Keep your edits and check Drive before trying again." }, 502)
      return c.json({ ok: true })
    } catch (error) { return failure(c, error instanceof Error ? error.message : "These edits could not be saved. Your draft is kept here.") }
  })

  app.get(`${base}/content`, description("readGoogleDriveDocumentContent", "Preview a Drive PDF or image", z.unknown()), orgMemberRoute(), guard, paramValidator(params), queryValidator(z.object({ connectionId: connectionSchema })), async c => {
    const { fileId } = c.req.valid("param"); const auth = await authorize(c, c.req.valid("query").connectionId); if (!auth.ok) return auth.reply
    const meta = await metadata(c, auth.selected, fileId); if (!meta.ok) return meta.reply
    // Google Slides previews as a PDF export; the presentation itself is never converted or copied.
    const slides = meta.file.mimeType === SLIDES
    if (!slides && !["application/pdf", "image/png", "image/jpeg", "image/gif", "image/webp"].includes(meta.file.mimeType)) return failure(c, "This file has no safe inline preview.")
    const result = slides ? await exportPdf(c, auth.selected, fileId) : await media(c, auth.selected, fileId); if (!result.ok) return result.reply
    try { const bytes = await boundedBytes(result.response); return new Response(new Uint8Array(bytes).buffer, { headers: { "content-type": slides ? "application/pdf" : meta.file.mimeType, "cache-control": "no-store", "x-content-type-options": "nosniff", "content-security-policy": "default-src 'none'; sandbox" } }) } catch { return failure(c, "This preview is too large.") }
  })
  routeApp.route("/", app)
}
