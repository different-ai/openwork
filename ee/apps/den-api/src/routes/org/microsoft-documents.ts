import { Hono, type MiddlewareHandler } from "hono"
import { bodyLimit } from "hono/body-limit"
import { describeRoute, type DescribeRouteOptions } from "hono-openapi"
import { z } from "zod"
import { documentIdSchema, documentSaveSchema, editorDocumentSchema } from "@openwork/documents/model"
import { openExcel, openWord, patchExcel, patchWord } from "@openwork/documents/office"
import { organizationFeatureEnabled } from "../../features.js"
import { jsonValidator, paramValidator, queryValidator } from "../../middleware/index.js"
import { jsonResponse } from "../../openapi.js"
import type { OrgRouteVariables } from "./shared.js"
import { decodeMicrosoftDocumentId, graphItemSchema, graphListingSchema, listingResponseSchema, microsoftDocumentItem, officeUrl } from "./microsoft-document-items.js"

const XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
const PREVIEWS = new Set(["application/pdf", "image/png", "image/jpeg", "image/gif", "image/webp"])
const MAX_BYTES = 12 * 1024 * 1024
const PAGE_SIZE = 25
const FIELDS = "id,name,size,lastModifiedDateTime,webUrl,eTag,file,folder,parentReference,remoteItem"
const base = "/v1/documents/microsoft-365/files"
const errorSchema = z.object({ error: z.string(), message: z.string() })

type Context = Parameters<MiddlewareHandler<{ Variables: OrgRouteVariables }>>[0]
export type MicrosoftDocumentsAccess =
  | { ok: true; accessToken: string; canWrite: boolean }
  | { ok: false; reply: Response }

export type MicrosoftDocumentsOptions = {
  memberRoute: MiddlewareHandler<{ Variables: OrgRouteVariables }>
  graphBaseUrl: string
  fetch: typeof fetch
  /** The calling member's Microsoft token with OneDrive read access, or the reply that explains why not. */
  access(c: Context): Promise<MicrosoftDocumentsAccess>
}

async function boundedBytes(response: Response): Promise<Uint8Array> {
  if (Number(response.headers.get("content-length")) > MAX_BYTES) { await response.body?.cancel(); throw new Error("This file is too large for inline editing.") }
  const buffer = new Uint8Array(await response.arrayBuffer())
  if (buffer.byteLength > MAX_BYTES) throw new Error("This file is too large for inline editing.")
  return buffer
}

export function registerMicrosoftDocumentRoutes<T extends { Variables: OrgRouteVariables }>(routeApp: Hono<T>, options: MicrosoftDocumentsOptions) {
  const app = new Hono<{ Variables: OrgRouteVariables }>()
  const graphRoot = new URL(options.graphBaseUrl.replace(/\/+$/, "") + "/")
  const graphUrl = (path: string) => new URL(path.replace(/^\/+/, ""), graphRoot)
  const guard: MiddlewareHandler<{ Variables: OrgRouteVariables }> = async (c, next) => {
    const context = c.get("organizationContext")
    if (!context || !(await organizationFeatureEnabled(context.organization.id, "workbotDocuments"))) return c.json({ error: "feature_disabled", message: "Documents is off for this workspace." }, 403)
    await next()
  }
  const description = (operationId: string, summary: string, schema: z.ZodType) => {
    const options: DescribeRouteOptions & { "x-mcp": false } = { operationId, tags: ["Documents"], "x-mcp": false, summary, description: "Requires organization membership and Documents, and the member's Microsoft 365 connection with OneDrive read access. Saves also require OneDrive write access and a matching file version.", responses: { 200: jsonResponse("Document result.", schema), 400: jsonResponse("Unsupported file or edit.", errorSchema), 409: jsonResponse("Connect Microsoft 365, or reload the changed file.", errorSchema) } }
    return describeRoute(options)
  }
  const failure = (c: Context, message: string) => c.json({ error: "document_unavailable", message }, 400)

  /** One Graph request with the member's token, turning Graph's refusals into readable replies. */
  const graph = async (c: Context, accessToken: string, url: URL, init: RequestInit = {}) => {
    const headers = new Headers(init.headers)
    headers.set("authorization", `Bearer ${accessToken}`)
    let response: Response
    try {
      response = await options.fetch(url, { ...init, headers, signal: c.req.raw.signal })
    } catch {
      return { ok: false, reply: c.json({ error: "microsoft_graph_error", message: "Microsoft 365 could not be reached. Try again." }, 502) } as const
    }
    if (response.ok) return { ok: true, response } as const
    const body = await response.json().catch(() => null) as { error?: { message?: unknown } } | null
    const detail = typeof body?.error?.message === "string" ? ` ${body.error.message.slice(0, 300)}` : ""
    if (response.status === 401) return { ok: false, reply: c.json({ error: "needs_connection", message: "Microsoft 365 rejected this connection. Reconnect Microsoft 365, then try again." }, 409) } as const
    if (response.status === 403) return { ok: false, reply: c.json({ error: "forbidden", message: `You don't have access to this OneDrive item.${detail}` }, 403) } as const
    if (response.status === 404) return { ok: false, reply: c.json({ error: "not_found", message: "This OneDrive item no longer exists or isn't shared with you." }, 404) } as const
    if (response.status === 412) return { ok: false, reply: c.json({ error: "drive_conflict", message: "This file changed in OneDrive. Your edits are kept here; reload the file before saving again." }, 409) } as const
    return { ok: false, reply: c.json({ error: "microsoft_graph_error", message: `Microsoft 365 returned HTTP ${response.status}.${detail}` }, 502) } as const
  }
  const item = async (c: Context, accessToken: string, fileId: string) => {
    const ids = decodeMicrosoftDocumentId(fileId)
    if (!ids) return { ok: false, reply: failure(c, "This is not a OneDrive file.") } as const
    const path = `drives/${encodeURIComponent(ids.driveId)}/items/${encodeURIComponent(ids.itemId)}`
    const url = graphUrl(path); url.searchParams.set("$select", FIELDS)
    const result = await graph(c, accessToken, url); if (!result.ok) return result
    const parsed = graphItemSchema.safeParse(await result.response.json().catch(() => null))
    if (!parsed.success || parsed.data.folder || !parsed.data.file) return { ok: false, reply: failure(c, "This OneDrive item is not a file.") } as const
    return { ok: true, ids, path, file: parsed.data, mimeType: parsed.data.file.mimeType ?? "application/octet-stream", revision: parsed.data.eTag ?? "" } as const
  }
  const download = async (c: Context, accessToken: string, path: string) => {
    const result = await graph(c, accessToken, graphUrl(`${path}/content`)); if (!result.ok) return result
    return { ok: true, bytes: await boundedBytes(result.response) } as const
  }

  /** For edits: a refused download ends the save with Graph's own reply. */
  const downloadOrThrow = async (c: Context, accessToken: string, path: string) => {
    const source = await download(c, accessToken, path)
    if (!source.ok) throw source.reply
    return source.bytes
  }

  const listQuery = z.object({
    view: z.enum(["recent", "folder"]).default("folder"),
    folderId: z.union([z.literal("root"), z.literal("shared"), documentIdSchema]).default("root"),
    query: z.string().trim().max(500).optional(),
    cursor: z.string().max(4096).optional(),
  }).strict()
  app.get(base, description("listMicrosoft365Documents", "Browse, search and list recent OneDrive files", listingResponseSchema), options.memberRoute, guard, queryValidator(listQuery), async c => {
    const access = await options.access(c); if (!access.ok) return access.reply
    const input = c.req.valid("query")
    let url: URL
    if (input.cursor) {
      // Continue only Microsoft's own next page link, never an arbitrary address.
      let next: URL
      try { next = new URL(Buffer.from(input.cursor, "base64url").toString("utf8")) } catch { return failure(c, "This page link is invalid.") }
      if (next.origin !== graphRoot.origin || !next.pathname.startsWith(graphRoot.pathname)) return failure(c, "This page link is invalid.")
      url = next
    } else if (input.query) {
      url = graphUrl(`me/drive/root/search(q='${encodeURIComponent(input.query.replace(/'/g, "''"))}')`); url.searchParams.set("$top", String(PAGE_SIZE))
    } else if (input.view === "recent") {
      url = graphUrl("me/drive/recent"); url.searchParams.set("$top", String(PAGE_SIZE))
    } else if (input.folderId === "shared") {
      url = graphUrl("me/drive/sharedWithMe")
    } else if (input.folderId === "root") {
      url = graphUrl("me/drive/root/children"); url.searchParams.set("$top", String(PAGE_SIZE)); url.searchParams.set("$select", FIELDS)
    } else {
      const ids = decodeMicrosoftDocumentId(input.folderId)
      if (!ids) return failure(c, "This is not a OneDrive folder.")
      url = graphUrl(`drives/${encodeURIComponent(ids.driveId)}/items/${encodeURIComponent(ids.itemId)}/children`); url.searchParams.set("$top", String(PAGE_SIZE)); url.searchParams.set("$select", FIELDS)
    }
    const result = await graph(c, access.accessToken, url); if (!result.ok) return result.reply
    const listing = graphListingSchema.safeParse(await result.response.json().catch(() => null))
    if (!listing.success) return c.json({ error: "microsoft_graph_error", message: "Microsoft 365 returned an unexpected file list." }, 502)
    const files = listing.data.value.flatMap(raw => { const entry = microsoftDocumentItem(raw); return entry ? [entry] : [] })
    const next = listing.data["@odata.nextLink"]
    c.header("cache-control", "no-store")
    return c.json({ files, nextCursor: next ? Buffer.from(next, "utf8").toString("base64url") : null })
  })

  const params = z.object({ fileId: documentIdSchema })
  const metadataSchema = z.object({ id: documentIdSchema, name: z.string(), mimeType: z.string(), modifiedTime: z.string().nullable(), size: z.number().nullable(), openUrl: z.string().nullable() })
  app.get(`${base}/:fileId/metadata`, description("getMicrosoft365DocumentMetadata", "Read a OneDrive file's details without its content", metadataSchema), options.memberRoute, guard, paramValidator(params), queryValidator(z.object({}).strict()), async c => {
    const access = await options.access(c); if (!access.ok) return access.reply
    const { fileId } = c.req.valid("param")
    const meta = await item(c, access.accessToken, fileId); if (!meta.ok) return meta.reply
    c.header("cache-control", "no-store")
    return c.json({ id: fileId, name: meta.file.name ?? "Untitled", mimeType: meta.mimeType, modifiedTime: meta.file.lastModifiedDateTime ?? null, size: meta.file.size ?? null, openUrl: officeUrl(meta.file.webUrl) })
  })

  const editorQuery = z.object({ sheetId: z.string().max(200).optional(), startRow: z.coerce.number().int().min(1).max(1_048_526).default(1), connectionId: z.literal("microsoft-365").optional() }).strict()
  app.get(`${base}/:fileId/editor`, description("openMicrosoft365DocumentEditor", "Open a OneDrive file in the inline editor", editorDocumentSchema), options.memberRoute, guard, paramValidator(params), queryValidator(editorQuery), async c => {
    const access = await options.access(c); if (!access.ok) return access.reply
    const { fileId } = c.req.valid("param"); const input = c.req.valid("query")
    const meta = await item(c, access.accessToken, fileId); if (!meta.ok) return meta.reply
    const common = { fileId, name: meta.file.name ?? "Untitled", revision: meta.revision, canEdit: access.canWrite && !!meta.revision, connectionId: "microsoft-365" }
    c.header("cache-control", "no-store")
    try {
      if (meta.mimeType === XLSX || meta.mimeType === DOCX || meta.mimeType.startsWith("text/")) {
        const source = await download(c, access.accessToken, meta.path); if (!source.ok) return source.reply
        if (meta.mimeType === XLSX) return c.json({ ...common, ...await openExcel(source.bytes, input) })
        if (meta.mimeType === DOCX) return c.json({ ...common, ...await openWord(source.bytes) })
        return c.json({ ...common, kind: "text", text: new TextDecoder("utf-8", { fatal: true }).decode(source.bytes) })
      }
      return c.json({ ...common, kind: "preview", mimeType: meta.mimeType, canEdit: false })
    } catch (error) { return failure(c, error instanceof Error ? error.message : "This file cannot be edited inline.") }
  })

  app.post(`${base}/:fileId/editor`, description("saveMicrosoft365DocumentEdits", "Save explicit inline edits to the same OneDrive file", z.object({ ok: z.literal(true) })), options.memberRoute, guard, bodyLimit({ maxSize: 2 * 1024 * 1024 }), paramValidator(params), jsonValidator(documentSaveSchema), async c => {
    const access = await options.access(c); if (!access.ok) return access.reply
    if (!access.canWrite) return c.json({ error: "read_only", message: "The Microsoft 365 connector doesn't allow saving to OneDrive. An admin can enable OneDrive write access." }, 403)
    const { fileId } = c.req.valid("param"); const save = c.req.valid("json")
    if (save.connectionId !== "microsoft-365") return failure(c, "This edit belongs to another connection.")
    const meta = await item(c, access.accessToken, fileId); if (!meta.ok) return meta.reply
    if (!meta.revision || meta.revision !== save.revision) return c.json({ error: "drive_conflict", message: "This file changed in OneDrive. Your edits are kept here; reload the file before saving again." }, 409)
    c.header("cache-control", "no-store")
    try {
      let updated: Uint8Array
      if (meta.mimeType === XLSX && save.kind === "spreadsheet") updated = await patchExcel(await downloadOrThrow(c, access.accessToken, meta.path), save)
      else if (meta.mimeType === DOCX && save.kind === "document") updated = await patchWord(await downloadOrThrow(c, access.accessToken, meta.path), save)
      else if (meta.mimeType.startsWith("text/") && save.kind === "text") updated = new TextEncoder().encode(save.text)
      else return failure(c, "This file type does not support these edits.")
      // If-Match makes OneDrive refuse the write when someone else saved in between.
      const result = await graph(c, access.accessToken, graphUrl(`${meta.path}/content`), { method: "PUT", body: new Uint8Array(updated).buffer, headers: { "content-type": meta.mimeType, "if-match": meta.revision }, redirect: "error" })
      if (!result.ok) return result.reply
      const receipt = graphItemSchema.safeParse(await result.response.json().catch(() => null))
      if (!receipt.success || receipt.data.id !== meta.ids.itemId) return c.json({ error: "save_unconfirmed", message: "OneDrive did not confirm the save. Keep your edits and check OneDrive before trying again." }, 502)
      return c.json({ ok: true })
    } catch (error) {
      if (error instanceof Response) return error
      return failure(c, error instanceof Error ? error.message : "These edits could not be saved. Your draft is kept here.")
    }
  })

  app.get(`${base}/:fileId/content`, description("readMicrosoft365DocumentContent", "Preview a OneDrive PDF or image", z.unknown()), options.memberRoute, guard, paramValidator(params), queryValidator(z.object({ connectionId: z.literal("microsoft-365") }).strict()), async c => {
    const access = await options.access(c); if (!access.ok) return access.reply
    const { fileId } = c.req.valid("param")
    const meta = await item(c, access.accessToken, fileId); if (!meta.ok) return meta.reply
    if (!PREVIEWS.has(meta.mimeType)) return failure(c, "This file has no safe inline preview.")
    try {
      const source = await download(c, access.accessToken, meta.path); if (!source.ok) return source.reply
      return new Response(new Uint8Array(source.bytes).buffer, { headers: { "content-type": meta.mimeType, "cache-control": "no-store", "x-content-type-options": "nosniff", "content-security-policy": "default-src 'none'; sandbox" } })
    } catch { return failure(c, "This preview is too large.") }
  })

  routeApp.route("/", app)
}
