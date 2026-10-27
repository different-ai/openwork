import { Hono, type Context, type MiddlewareHandler } from "hono"
import { bodyLimit } from "hono/body-limit"
import { contextStorage } from "hono/context-storage"
import { describeRoute } from "hono-openapi"
import { z } from "zod"
import { normalizeDenTypeId } from "@openwork-ee/utils/typeid"
import {
  MICROSOFT_DRIVE_PULL_CHUNK_BYTES,
  MICROSOFT_DRIVE_TRANSFER_MAX_BYTES,
  MICROSOFT_DRIVE_UPLOAD_CHUNK_BYTES,
  MICROSOFT_DRIVE_UPLOAD_MAX_BYTES,
} from "@openwork/types/microsoft-drive-transfer"
import { attributeAuditRequest, auditSessionUserAttribution } from "../../audit/request-capture.js"
import { resolvePublicApiBaseUrl } from "../../capability-sources/generic-oauth.js"
import {
  extractMicrosoftDriveItem,
  isMicrosoftUploadSessionUrl,
  MicrosoftGraphRequestError,
  type Microsoft365DriveRef,
  type MicrosoftGraphClient,
} from "../../capability-sources/microsoft-graph.js"
import { openToken, sealToken, signLink, verifyLink } from "../../capability-sources/signed-links.js"
import { env } from "../../env.js"
import { cloudTransportReadRoute, cloudTransportRoute, jsonValidator, paramValidator, queryValidator, tokenRoute } from "../../middleware/index.js"
import { invalidRequestSchema, jsonResponse, unauthorizedSchema } from "../../openapi.js"
import { getOrganizationContextForUser } from "../../orgs.js"
import { readInternalCapabilityConnectorId } from "../../session.js"
import {
  driveIdSchema,
  driveItemNameSchema,
  driveItemSchema,
  graphError,
  graphErrorStatus,
  graphItemIdSchema,
  needsConnectionSchema,
  upstreamErrorSchema,
  type Microsoft365Access,
} from "./microsoft-365-shared.js"
import type { OrgRouteVariables } from "./shared.js"

const FILE_READ = ["filesRead", "filesWrite", "filesReadAll", "filesFull"]
const FILE_WRITE = ["filesWrite", "filesFull"]
const SITES_READ = ["sitesRead"]
// Streams are relayed at the client's pace, so they outlive the 30 s Graph budget; a client disconnect still stops them.
const STREAM_TIMEOUT_MS = 10 * 60 * 1000
const RELAY_TIMEOUT_MS = 2 * 60 * 1000
const DOWNLOAD_LINK_TTL_SECONDS = 5 * 60
const UPLOAD_TOKEN_MAX_SECONDS = 24 * 60 * 60
const DOWNLOAD_LINK_DOMAIN = "openwork.microsoft-365.download-link.v1"
const UPLOAD_TOKEN_DOMAIN = "openwork.microsoft-365.upload-relay.v1"
const FRAGMENT_BYTES = 320 * 1024

const connectionIdSchema = z.string().regex(/^(microsoft-365|emc_[A-Za-z0-9]+)$/).optional()
  .describe("Selected Microsoft 365 connection; omit for the default. Unavailable selections never fall back to another account.")
const formatSchema = z.literal("pdf").optional()
  .describe("pdf converts a Word, Excel, PowerPoint or other Office file; omit to transfer the stored bytes.")
const siteIdSchema = z.string().min(1).max(512).regex(/^[A-Za-z0-9.,_-]+$/).describe("SharePoint site id from a site search.")
const errorSchema = z.object({ error: z.string(), message: z.string() })

const siteSchema = z.object({ id: z.string(), name: z.string(), webUrl: z.string(), description: z.string() }).meta({ ref: "Microsoft365Site" })
const driveSchema = z.object({
  id: z.string().describe("Pass as driveId to list, read or save files in this library."),
  name: z.string(),
  webUrl: z.string(),
  driveType: z.string(),
}).meta({ ref: "Microsoft365Drive" })

const downloadFileSchema = z.object({
  id: z.string(),
  driveId: z.string(),
  parentId: z.string(),
  name: z.string(),
  mimeType: z.string(),
  revision: z.string().nullable().describe("The file's eTag. Pass it back as baseRevision when replacing the file, so newer changes are never overwritten silently."),
  size: z.number().int().nullable(),
  modifiedTime: z.string().nullable(),
  webUrl: z.string().nullable(),
})
const downloadSchema = z.object({
  format: z.literal("pdf").nullable(),
  mimeType: z.string(),
  extension: z.string().nullable().describe("Extension the saved file needs, for conversions."),
  size: z.number().int().nullable().describe("Exact bytes for stored files; unknown until downloaded for conversions."),
  exported: z.boolean(),
  maxBytes: z.number().int(),
})
const downloadInfoSchema = z.object({ ok: z.literal(true), file: downloadFileSchema, download: downloadSchema })
  .meta({ ref: "Microsoft365DriveDownloadInfo" })
const downloadLinkSchema = downloadInfoSchema.extend({
  downloadUrl: z.string().url().describe("Secret bearer URL for this one file, valid for five minutes. Do not print, share, log or persist it."),
  expiresAt: z.string().datetime(),
  resourceLink: z.object({
    type: z.literal("resource_link"), uri: z.string().url(), name: z.string(), mimeType: z.string(), size: z.number().int().optional(),
  }).describe("The same download as an MCP resource link."),
  instructions: z.string(),
}).meta({ ref: "Microsoft365DriveDownloadLink" })

const replacesSchema = z.object({ itemId: z.string(), driveId: z.string(), previousRevision: z.string().nullable() })
  .describe("Present when the upload replaces an existing file's content.")
const uploadSessionSchema = z.object({
  ok: z.literal(true),
  uploadUrl: z.string().url().describe("Secret bearer upload-session URL. Never print, share, persist or log it, and never send an Authorization header to it."),
  method: z.literal("PUT"),
  size: z.number().int(),
  chunkSize: z.literal(MICROSOFT_DRIVE_UPLOAD_CHUNK_BYTES),
  expiresAt: z.string().datetime().nullable(),
  replaces: replacesSchema.optional(),
  instructions: z.string(),
}).meta({ ref: "Microsoft365DriveUploadSessionResponse" })
const hostUploadSessionSchema = z.object({
  ok: z.literal(true),
  uploadToken: z.string().describe("Opaque token for the relay route; Microsoft's session URL stays in OpenWork Cloud."),
  size: z.number().int(),
  chunkSize: z.literal(MICROSOFT_DRIVE_UPLOAD_CHUNK_BYTES),
  expiresAt: z.string().datetime(),
  replaces: replacesSchema.optional(),
}).meta({ ref: "Microsoft365HostDriveUploadSession" })
const uploadProgressSchema = z.discriminatedUnion("status", [
  z.object({ ok: z.literal(true), status: z.literal("partial"), nextOffset: z.number().int().describe("Send the bytes from this offset next.") }),
  z.object({ ok: z.literal(true), status: z.literal("complete"), file: driveItemSchema }),
]).meta({ ref: "Microsoft365DriveUploadProgress" })

const conflictSchema = errorSchema.extend({ currentRevision: z.string().nullable().optional(), modifiedTime: z.string().nullable().optional() })

const uploadFields = z.object({
  driveId: driveIdSchema.optional(),
  itemId: graphItemIdSchema.optional().describe("Replace this existing file's content. It keeps its link and sharing; the previous version stays in its version history."),
  baseRevision: z.string().min(1).max(512).regex(/^[\x20-\x7e]+$/).optional().describe("Required with itemId: the eTag your copy was downloaded from. Refused with drive_conflict when the file changed since; download it again and reapply the edits, or save a new file."),
  folderId: graphItemIdSchema.optional().describe("New files only: the folder to create the file in; omit for the top of the drive."),
  name: driveItemNameSchema.optional().describe("New files only: the file name."),
  conflictBehavior: z.enum(["fail", "rename"]).default("fail").describe("New files only: fail, or let Microsoft rename the file when the name is taken."),
})

function refineUpload(input: z.infer<typeof uploadFields>, ctx: z.RefinementCtx) {
  if (input.itemId && (input.folderId || input.name)) ctx.addIssue({ code: "custom", path: ["itemId"], message: "A replaced file keeps its name and folder; omit folderId and name with itemId." })
  if (input.itemId && !input.baseRevision) ctx.addIssue({ code: "custom", path: ["baseRevision"], message: "Replacing a file needs the eTag it was downloaded from, so newer changes are never overwritten. Download the file first." })
  if (input.baseRevision && !input.itemId) ctx.addIssue({ code: "custom", path: ["baseRevision"], message: "baseRevision requires itemId." })
  if (!input.itemId && !input.name) ctx.addIssue({ code: "custom", path: ["name"], message: "A new file needs a name." })
}

const capabilityUploadBody = uploadFields.extend({
  size: z.number().int().min(1).max(MICROSOFT_DRIVE_UPLOAD_MAX_BYTES).describe("Exact file size in bytes."),
}).strict().superRefine(refineUpload)
const hostUploadBody = uploadFields.extend({
  size: z.number().int().min(1).max(MICROSOFT_DRIVE_TRANSFER_MAX_BYTES),
  connectionId: connectionIdSchema,
}).strict().superRefine(refineUpload)

const linkPayloadSchema = z.object({
  v: z.literal(1), o: z.string(), u: z.string(), m: z.string(), c: z.string().nullable(),
  d: z.string(), f: z.string().min(1).max(512), x: z.literal("pdf").nullable(), e: z.number().int(),
})
const uploadTokenSchema = z.object({
  v: z.literal(1), o: z.string(), m: z.string(), url: z.string().url(), s: z.number().int().min(1), e: z.number().int(),
})

type DriveContext = Pick<Context<{ Variables: OrgRouteVariables }>, "get" | "json" | "req" | "header" | "body">
type OrganizationContext = NonNullable<OrgRouteVariables["organizationContext"]>
type DownloadFile = z.infer<typeof downloadFileSchema>
type Download = z.infer<typeof downloadSchema>
type Failure = { ok: false; status: 400 | 409 | 413 | 502; body: z.infer<typeof conflictSchema> }

export type MicrosoftDriveFileRouteOptions = {
  access: Microsoft365Access
  graphBaseUrl?: string
  fetch?: typeof fetch
  memberRoute: MiddlewareHandler<{ Variables: OrgRouteVariables }>
  transportRoute?: ReturnType<typeof cloudTransportRoute>
  transportReadRoute?: ReturnType<typeof cloudTransportReadRoute>
}

function isoOrNull(value: string) {
  const time = Date.parse(value)
  return Number.isFinite(time) ? new Date(time).toISOString() : null
}

/** Metadata and the exact bytes a pull would save, without downloading anything. Shortcuts resolve to their target. */
async function describeDownload(graph: MicrosoftGraphClient, input: { ref?: Microsoft365DriveRef; link?: string; format?: "pdf" }): Promise<{ ok: true; file: DownloadFile; download: Download } | Failure> {
  const item = input.link ? await graph.resolveSharingLink(input.link) : await graph.getDriveItem(input.ref!)
  if (!item.id) return { ok: false, status: 502, body: { error: "microsoft_graph_error", message: "Microsoft did not return the requested file." } }
  if (item.kind === "folder") {
    return { ok: false, status: 400, body: { error: "invalid_request", message: "This item is a folder. List the folder and pull its files one at a time." } }
  }
  if (item.kind !== "file") {
    return { ok: false, status: 400, body: { error: "unsupported_drive_file", message: "This item, such as a OneNote notebook, has no downloadable content." } }
  }
  const file: DownloadFile = {
    id: item.id, driveId: item.driveId || input.ref?.driveId || "", parentId: item.parentId, name: item.name,
    mimeType: item.mimeType || "application/octet-stream", revision: item.eTag || null,
    size: item.size !== null && Number.isSafeInteger(item.size) ? item.size : null,
    modifiedTime: item.modifiedTime || null, webUrl: item.webUrl || null,
  }
  if (input.format === "pdf") {
    return { ok: true, file, download: { format: "pdf", mimeType: "application/pdf", extension: ".pdf", size: null, exported: true, maxBytes: MICROSOFT_DRIVE_TRANSFER_MAX_BYTES } }
  }
  if (file.size !== null && file.size > MICROSOFT_DRIVE_TRANSFER_MAX_BYTES) {
    return { ok: false, status: 413, body: { error: "file_too_large", message: `This file is ${file.size} bytes; pulls support files up to ${MICROSOFT_DRIVE_TRANSFER_MAX_BYTES} bytes.` } }
  }
  return { ok: true, file, download: { format: null, mimeType: file.mimeType, extension: null, size: file.size, exported: false, maxBytes: MICROSOFT_DRIVE_TRANSFER_MAX_BYTES } }
}

/** Stops a stream that grows past the pull cap; the client sees a short, failed download. */
function capped(body: ReadableStream<Uint8Array>, maxBytes: number) {
  let seen = 0
  return body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      seen += chunk.byteLength
      if (seen > maxBytes) {
        controller.error(new Error("Download exceeded the pull size limit."))
        return
      }
      controller.enqueue(chunk)
    },
  }))
}

async function streamContent(c: DriveContext, graph: MicrosoftGraphClient, ref: Microsoft365DriveRef, format: "pdf" | undefined, range: string | undefined) {
  if (format && range) return c.json({ error: "invalid_request", message: "Conversions are downloaded whole; omit Range." }, 400)
  if (range) {
    const match = /^bytes=(\d{1,15})-(\d{1,15})$/.exec(range)
    const start = match ? Number(match[1]) : NaN
    const end = match ? Number(match[2]) : NaN
    if (!match || end < start || end - start + 1 > MICROSOFT_DRIVE_PULL_CHUNK_BYTES || end >= MICROSOFT_DRIVE_TRANSFER_MAX_BYTES) {
      return c.json({ error: "invalid_request", message: `Range must be bytes=START-END, at most ${MICROSOFT_DRIVE_PULL_CHUNK_BYTES} bytes, inside the pull size limit.` }, 400)
    }
  }
  const upstream = await graph.downloadDriveContent(ref, { range, format })
  if (!upstream.body) return c.json({ error: "microsoft_graph_error", message: "Microsoft returned no file content." }, 502)
  const headers: Record<string, string> = { "content-type": "application/octet-stream", "cache-control": "no-store", "x-content-type-options": "nosniff" }
  const contentRange = upstream.headers.get("content-range")
  if (contentRange) headers["content-range"] = contentRange
  const contentLength = upstream.headers.get("content-length")
  if (contentLength && Number(contentLength) <= MICROSOFT_DRIVE_TRANSFER_MAX_BYTES) headers["content-length"] = contentLength
  return c.body(capped(upstream.body, range ? MICROSOFT_DRIVE_PULL_CHUNK_BYTES : MICROSOFT_DRIVE_TRANSFER_MAX_BYTES), upstream.status === 206 ? 206 : 200, headers)
}

/** Check-then-write: the eTag is compared first for a readable conflict, and Graph enforces it again (If-Match). */
async function prepareUpload(graph: MicrosoftGraphClient, input: z.infer<typeof uploadFields>) {
  if (input.itemId) {
    const current = await graph.getDriveItem({ driveId: input.driveId, itemId: input.itemId })
    if (current.kind === "folder") return { ok: false, status: 400, body: { error: "invalid_request", message: "This item is a folder; only files can be replaced." } } satisfies Failure
    const conflict = {
      ok: false, status: 409,
      body: {
        error: "drive_conflict",
        message: "The file changed since this copy was downloaded, so it was not replaced. Download it again and reapply the edits, or save the edits as a new file.",
        currentRevision: current.eTag || null, modifiedTime: current.modifiedTime || null,
      },
    } satisfies Failure
    if (current.eTag !== input.baseRevision) return conflict
    const target = { driveId: current.driveId || input.driveId, itemId: current.id }
    try {
      const session = await graph.createDriveUploadSession({ replace: target, eTag: input.baseRevision })
      return { ok: true, session, replaces: { itemId: current.id, driveId: target.driveId ?? "", previousRevision: current.eTag || null } } as const
    } catch (error) {
      if (error instanceof MicrosoftGraphRequestError && error.status === 412) return conflict
      throw error
    }
  }
  const session = await graph.createDriveUploadSession({
    parent: { driveId: input.driveId, itemId: input.folderId ?? "root" }, name: input.name!, conflictBehavior: input.conflictBehavior,
  })
  return { ok: true, session } as const
}

function nextOffset(value: unknown): number | null {
  if (typeof value !== "object" || value === null || !Array.isArray((value as { nextExpectedRanges?: unknown }).nextExpectedRanges)) return null
  const first = (value as { nextExpectedRanges: unknown[] }).nextExpectedRanges[0]
  const match = typeof first === "string" ? /^(\d{1,15})-/.exec(first) : null
  return match ? Number(match[1]) : null
}

/** Microsoft file search beyond the member's own drive, folders, links, SharePoint sites and file transfers. */
export function registerMicrosoftDriveFileRoutes<T extends { Variables: OrgRouteVariables }>(routeApp: Hono<T>, options: MicrosoftDriveFileRouteOptions) {
  routeApp.use("/v1/direct-downloads/microsoft-365/*", contextStorage())
  routeApp.use("/v1/direct-uploads/microsoft-365/*", contextStorage())
  const app = new Hono<{ Variables: OrgRouteVariables }>()
  const memberRoute = options.memberRoute
  const transportRoute = options.transportRoute ?? cloudTransportRoute()
  const transportReadRoute = options.transportReadRoute ?? cloudTransportReadRoute()
  const graphBaseUrl = options.graphBaseUrl
  const relayFetch = options.fetch ?? fetch
  const chunkBody = bodyLimit({
    maxSize: MICROSOFT_DRIVE_UPLOAD_CHUNK_BYTES,
    onError: (c) => c.json({ error: "invalid_request", message: `Send at most ${MICROSOFT_DRIVE_UPLOAD_CHUNK_BYTES} bytes per request.` }, 413),
  })
  const errors = {
    400: jsonResponse("Invalid request, a folder, or an item without content.", invalidRequestSchema.or(errorSchema)),
    401: jsonResponse("Sign in first.", unauthorizedSchema),
    403: jsonResponse("Organization policy blocks the selected connection.", errorSchema),
    409: jsonResponse("Connect Microsoft 365 with the needed permission, or the file changed since baseRevision (drive_conflict).", needsConnectionSchema.or(conflictSchema)),
    502: jsonResponse("Microsoft refused or did not return the file; the message gives Microsoft's reason.", upstreamErrorSchema.or(errorSchema)),
  }

  /** Runs with a Graph client for the request's member, or answers why there is none. */
  async function withGraph(c: DriveContext, features: readonly string[], label: string, connectionId: string | null | undefined, run: (graph: MicrosoftGraphClient, context: OrganizationContext) => Promise<Response>, timeoutMs?: number) {
    const context = c.get("organizationContext")
    if (!context) return c.json({ error: "unauthorized", message: "Sign in to an organization first." }, 401)
    const granted = await options.access({ organizationId: context.organization.id, orgMembershipId: context.currentMember.id, connectionId, features, label })
    if (!granted.ok) return c.json(granted.body, granted.status)
    try {
      return await run(granted.graph({ signal: c.req.raw.signal, timeoutMs }), context)
    } catch (error) {
      return c.json(graphError(error), graphErrorStatus(error))
    }
  }

  app.get("/v1/capabilities/microsoft-365/drive-children", describeRoute({
    operationId: "listMicrosoft365DriveChildren", tags: ["Capability Sources"],
    summary: "List a OneDrive or SharePoint folder",
    description: "Lists the items in a folder, or the top of a drive when folderId is omitted: the member's own OneDrive by default, or a SharePoint library or other drive with driveId. Read-only.",
    responses: { 200: jsonResponse("Folder items.", z.object({ ok: z.literal(true), files: z.array(driveItemSchema), nextPageToken: z.string().nullable() }).meta({ ref: "Microsoft365DriveChildrenResponse" })), ...errors },
  }), memberRoute, queryValidator(z.object({
    driveId: driveIdSchema.optional(),
    folderId: graphItemIdSchema.optional().describe("Folder id; omit for the top of the drive."),
    maxResults: z.coerce.number().int().min(1).max(100).default(25),
    pageToken: z.string().min(1).max(2048).optional().describe("nextPageToken from the previous page of the same folder."),
  })), (c) => withGraph(c, FILE_READ, "OneDrive read", undefined, async (graph) => {
    const query = c.req.valid("query")
    return c.json({ ok: true, ...await graph.listDriveChildren(query) })
  }))

  app.get("/v1/capabilities/microsoft-365/drive-item-by-link", describeRoute({
    operationId: "resolveMicrosoft365DriveLink", tags: ["Capability Sources"],
    summary: "Find the OneDrive, SharePoint or Teams file behind a link",
    description: "Turns a OneDrive, SharePoint or Teams file link the member can open into the item's driveId and id, for reading, pulling or saving it. Read-only; files outside the member's own OneDrive need the all-files permission.",
    responses: { 200: jsonResponse("The linked item.", z.object({ ok: z.literal(true), file: driveItemSchema }).meta({ ref: "Microsoft365DriveItemResponse" })), ...errors },
  }), memberRoute, queryValidator(z.object({ url: z.string().url().max(2048).startsWith("https://").describe("The file's OneDrive, SharePoint or Teams link.") })), (c) => withGraph(c, FILE_READ, "OneDrive read", undefined, async (graph) => (
    c.json({ ok: true, file: await graph.resolveSharingLink(c.req.valid("query").url) })
  )))

  app.get("/v1/capabilities/microsoft-365/sites", describeRoute({
    operationId: "searchMicrosoft365Sites", tags: ["Capability Sources"],
    summary: "Search SharePoint sites",
    description: "Finds SharePoint sites the member can open by name. List a site's document libraries next, then browse or search their files. Read-only; needs the SharePoint sites permission.",
    responses: { 200: jsonResponse("Sites.", z.object({ ok: z.literal(true), sites: z.array(siteSchema) }).meta({ ref: "Microsoft365SitesResponse" })), ...errors },
  }), memberRoute, queryValidator(z.object({
    query: z.string().trim().min(1).max(200).describe("Words in the site name; * lists sites the member can open."),
    maxResults: z.coerce.number().int().min(1).max(50).default(20),
  })), (c) => withGraph(c, SITES_READ, "SharePoint site access", undefined, async (graph) => (
    c.json({ ok: true, sites: await graph.searchSites(c.req.valid("query")) })
  )))

  app.get("/v1/capabilities/microsoft-365/sites/:siteId/drives", describeRoute({
    operationId: "listMicrosoft365SiteDrives", tags: ["Capability Sources"],
    summary: "List a SharePoint site's document libraries",
    description: "Lists the document libraries (drives) of one SharePoint site. Pass a library's id as driveId to browse, read or save its files. Read-only; needs the SharePoint sites permission.",
    responses: { 200: jsonResponse("Document libraries.", z.object({ ok: z.literal(true), drives: z.array(driveSchema) }).meta({ ref: "Microsoft365SiteDrivesResponse" })), ...errors },
  }), memberRoute, paramValidator(z.object({ siteId: siteIdSchema })), (c) => withGraph(c, SITES_READ, "SharePoint site access", undefined, async (graph) => (
    c.json({ ok: true, drives: await graph.listSiteDrives(c.req.valid("param").siteId) })
  )))

  app.post("/v1/capabilities/microsoft-365/drive-download-links", describeRoute({
    operationId: "createMicrosoft365DriveDownloadLink", tags: ["Capability Sources"],
    summary: "Create a five-minute download link for one OneDrive or SharePoint file, for clients with a shell",
    description: "For clients without OpenWork host file transport but with a shell, such as a Workbot computer or a coding agent. Download with curl into a file instead of reading the file into context; format pdf converts Office files. To save edits back, prepare createMicrosoft365DriveUploadSession with itemId and this revision as baseRevision. Uses the selected connection.",
    responses: { 200: jsonResponse("Short-lived bearer download URL, as JSON and as an MCP resource link, with the file's revision; no file content.", downloadLinkSchema), 413: jsonResponse("The file is larger than the pull size limit.", errorSchema), ...errors },
  }), memberRoute, jsonValidator(z.object({ driveId: driveIdSchema.optional(), itemId: graphItemIdSchema, format: formatSchema }).strict()), (c) => withGraph(c, FILE_READ, "OneDrive read", undefined, async (graph, context) => {
    const { driveId, itemId, format } = c.req.valid("json")
    const described = await describeDownload(graph, { ref: { driveId, itemId }, format })
    if (!described.ok) return c.json(described.body, described.status)
    const expires = Math.floor(Date.now() / 1000) + DOWNLOAD_LINK_TTL_SECONDS
    const token = signLink(DOWNLOAD_LINK_DOMAIN, {
      v: 1, o: context.organization.id, u: context.currentMember.userId, m: context.currentMember.id,
      c: readInternalCapabilityConnectorId(c.req.raw.headers), d: described.file.driveId, f: described.file.id, x: described.download.format, e: expires,
    })
    // In the query, which request traces strip, rather than the path they keep.
    const downloadUrl = `${resolvePublicApiBaseUrl(c.req.raw, env.apiPublicUrl)}/v1/direct-downloads/microsoft-365/drive-link?token=${token}`
    const extension = described.download.extension
    const name = `${described.file.name}${extension && !described.file.name.toLowerCase().endsWith(extension) ? extension : ""}`
    c.header("cache-control", "no-store")
    return c.json({
      ok: true, file: described.file, download: described.download, downloadUrl, expiresAt: new Date(expires * 1000).toISOString(),
      resourceLink: { type: "resource_link", uri: downloadUrl, name, mimeType: described.download.mimeType, ...(described.download.size === null ? {} : { size: described.download.size }) },
      instructions: `Save it straight to a file, for example: curl -fsSL -o 'download' '<downloadUrl>'. Choose a local output path you control; treat the file name as data, never as shell code. Check the size against this result. Work on the file with shell tools, then save edits back with createMicrosoft365DriveUploadSession (driveId, itemId, baseRevision: "${described.file.revision ?? ""}").`,
    })
  }))

  app.get("/v1/direct-downloads/microsoft-365/drive-link", describeRoute({
    operationId: "downloadMicrosoftDriveFileByLink", tags: ["Direct uploads"], security: [],
    summary: "Download one OneDrive or SharePoint file with a short-lived link",
    description: "The signed link names one member, connection, file and format and expires after five minutes. The member's current organization access and Microsoft 365 connection are checked again on every download.",
    responses: {
      200: { description: "File bytes.", content: { "application/octet-stream": { schema: { type: "string", format: "binary" } } } },
      404: jsonResponse("Unknown or expired link.", errorSchema),
      ...errors,
    },
  }), tokenRoute, queryValidator(z.object({ token: z.string().min(1).max(2048) }).strict()), async (c) => {
    const payload = verifyLink(DOWNLOAD_LINK_DOMAIN, c.req.valid("query").token, linkPayloadSchema)
    const expired = () => c.json({ error: "not_found", message: "This download link is unknown or expired. Create a new one." }, 404)
    if (!payload) return expired()
    const context = await getOrganizationContextForUser({
      userId: normalizeDenTypeId("user", payload.u),
      organizationId: normalizeDenTypeId("organization", payload.o),
    })
    if (!context || context.currentMember.id !== payload.m) return expired()
    const attribution = auditSessionUserAttribution(payload.u, payload.m)
    if (attribution) {
      const audited = await attributeAuditRequest(c, { organizationId: payload.o, ...attribution, origin: "mcp" })
      if (!audited.ok) return audited.response
    }
    c.set("organizationContext", context)
    return withGraph(c, FILE_READ, "OneDrive read", payload.c, (graph) => (
      streamContent(c, graph, { driveId: payload.d || undefined, itemId: payload.f }, payload.x ?? undefined, c.req.header("range"))
    ), STREAM_TIMEOUT_MS)
  })

  app.post("/v1/capabilities/microsoft-365/drive-upload-sessions", describeRoute({
    operationId: "createMicrosoft365DriveUploadSession", tags: ["Capability Sources"],
    summary: "Prepare an upload to OneDrive or SharePoint, or a replacement of an existing file's content, for a client with a shell",
    description: "Prepare a Microsoft upload session for an explicitly requested upload. This does not upload bytes or prove completion. With itemId and baseRevision the upload replaces that file's content as a new version; otherwise it creates name in folderId (or the top of the drive). Do not automatically create another session after an uncertain result. Uses the selected connection.",
    responses: { 200: jsonResponse("Secret upload session; file not yet uploaded.", uploadSessionSchema), ...errors },
  }), memberRoute, jsonValidator(capabilityUploadBody), (c) => withGraph(c, FILE_WRITE, "OneDrive write", undefined, async (graph) => {
    const input = c.req.valid("json")
    const prepared = await prepareUpload(graph, input)
    if (!prepared.ok) return c.json(prepared.body, prepared.status)
    c.header("cache-control", "no-store")
    return c.json({
      ok: true, uploadUrl: prepared.session.uploadUrl, method: "PUT", size: input.size, chunkSize: MICROSOFT_DRIVE_UPLOAD_CHUNK_BYTES,
      expiresAt: isoOrNull(prepared.session.expirationDateTime), ...("replaces" in prepared ? { replaces: prepared.replaces } : {}),
      instructions: "Keep uploadUrl secret and never send an Authorization header to it. Up to 60 MiB in one request: curl -fsS -X PUT -H 'Content-Range: bytes 0-<size-1>/<size>' --data-binary @<file> '<uploadUrl>'. Larger files go in order in parts of chunkSize bytes (non-final parts must be multiples of 320 KiB) with Content-Range: bytes START-END/TOTAL; HTTP 202 lists nextExpectedRanges. After an uncertain PUT, GET uploadUrl for nextExpectedRanges before resending. HTTP 200 or 201 with the file's id and eTag confirms completion.",
    })
  }))

  const hostQuery = z.object({
    driveId: driveIdSchema.optional(),
    itemId: graphItemIdSchema.optional(),
    url: z.string().url().max(2048).startsWith("https://").optional().describe("A OneDrive, SharePoint or Teams file link instead of driveId and itemId."),
    format: formatSchema,
    connectionId: connectionIdSchema,
  }).strict().refine((value) => Boolean(value.itemId) !== Boolean(value.url), "Pass itemId (with driveId outside the member's OneDrive) or url.")

  app.get("/v1/direct-downloads/microsoft-365/drive-files", describeRoute({
    operationId: "describeHostMicrosoftDriveDownload", tags: ["Direct uploads"], security: [{ mcpAccessToken: [] }],
    summary: "Describe a OneDrive or SharePoint file pull for host file transport",
    description: "Returns the file's drive, eTag revision and the exact format and size a pull would save, without downloading content. Hosts then fetch the content route in ranged chunks. Optional connectionId selects a Microsoft 365 connection; unavailable selections never fall back to the default.",
    responses: { 200: jsonResponse("Pull plan; no file content.", downloadInfoSchema), 413: jsonResponse("The file is larger than the pull size limit.", errorSchema), ...errors },
  }), transportReadRoute, queryValidator(hostQuery), (c) => {
    const { driveId, itemId, url, format, connectionId } = c.req.valid("query")
    return withGraph(c, FILE_READ, "OneDrive read", connectionId ?? null, async (graph) => {
      const described = await describeDownload(graph, url ? { link: url, format } : { ref: { driveId, itemId: itemId! }, format })
      if (!described.ok) return c.json(described.body, described.status)
      c.header("cache-control", "no-store")
      return c.json({ ok: true, file: described.file, download: described.download })
    })
  })

  app.get("/v1/direct-downloads/microsoft-365/drive-files/content", describeRoute({
    operationId: "downloadHostMicrosoftDriveFile", tags: ["Direct uploads"], security: [{ mcpAccessToken: [] }],
    summary: "Stream a OneDrive or SharePoint file's bytes to host file transport",
    description: "Streams stored files as-is (Range: bytes=START-END, up to 8 MiB per request) or converts Office files to PDF whole. Den does not keep or inspect the bytes. Responses stop at the pull size limit.",
    responses: {
      200: { description: "File bytes.", content: { "application/octet-stream": { schema: { type: "string", format: "binary" } } } },
      206: { description: "Requested byte range.", content: { "application/octet-stream": { schema: { type: "string", format: "binary" } } } },
      ...errors,
    },
  }), transportReadRoute, queryValidator(z.object({ driveId: driveIdSchema.optional(), itemId: graphItemIdSchema, format: formatSchema, connectionId: connectionIdSchema }).strict()), (c) => {
    const { driveId, itemId, format, connectionId } = c.req.valid("query")
    return withGraph(c, FILE_READ, "OneDrive read", connectionId ?? null, (graph) => streamContent(c, graph, { driveId, itemId }, format, c.req.header("range")), STREAM_TIMEOUT_MS)
  })

  app.post("/v1/direct-uploads/microsoft-365/drive-upload-sessions", describeRoute({
    operationId: "prepareHostMicrosoftDriveUploadSession", tags: ["Direct uploads"], security: [{ mcpAccessToken: [] }],
    summary: "Prepare a OneDrive or SharePoint upload for host file transport",
    description: "Like createMicrosoft365DriveUploadSession, but Microsoft's session URL stays in OpenWork Cloud: the host sends the file in chunks to the relay route with the returned uploadToken. Saves through OpenWork Cloud are limited to the pull size limit.",
    responses: { 200: jsonResponse("Opaque upload token; file not yet uploaded.", hostUploadSessionSchema), ...errors },
  }), transportRoute, jsonValidator(hostUploadBody), (c) => {
    const { connectionId, ...input } = c.req.valid("json")
    return withGraph(c, FILE_WRITE, "OneDrive write", connectionId ?? null, async (graph, context) => {
      const prepared = await prepareUpload(graph, input)
      if (!prepared.ok) return c.json(prepared.body, prepared.status)
      const graphExpiry = Date.parse(prepared.session.expirationDateTime)
      const expires = Math.floor(Math.min(Number.isFinite(graphExpiry) ? graphExpiry : Date.now() + 60 * 60 * 1000, Date.now() + UPLOAD_TOKEN_MAX_SECONDS * 1000) / 1000)
      const uploadToken = sealToken(UPLOAD_TOKEN_DOMAIN, { v: 1, o: context.organization.id, m: context.currentMember.id, url: prepared.session.uploadUrl, s: input.size, e: expires })
      c.header("cache-control", "no-store")
      return c.json({
        ok: true, uploadToken, size: input.size, chunkSize: MICROSOFT_DRIVE_UPLOAD_CHUNK_BYTES, expiresAt: new Date(expires * 1000).toISOString(),
        ...("replaces" in prepared ? { replaces: prepared.replaces } : {}),
      })
    })
  })

  /** Forwards one request to Microsoft's upload session; Microsoft's session URL never leaves Den. */
  async function relay(c: DriveContext, init: { method: "PUT" | "GET"; contentRange?: string; total?: number; body?: Uint8Array<ArrayBuffer> }) {
    const context = c.get("organizationContext")
    const session = openToken(UPLOAD_TOKEN_DOMAIN, c.req.query("token") ?? "", uploadTokenSchema)
    if (!session || !context || session.o !== context.organization.id || session.m !== context.currentMember.id || !isMicrosoftUploadSessionUrl(session.url, graphBaseUrl)) {
      return c.json({ error: "upload_session_expired", message: "This upload is unknown or expired. Check the file before starting another upload." }, 404)
    }
    if (init.total !== undefined && init.total !== session.s) {
      return c.json({ error: "invalid_request", message: "TOTAL must be the size the upload was prepared with." }, 400)
    }
    let response: Response
    try {
      response = await relayFetch(session.url, {
        method: init.method, redirect: "error",
        headers: init.method === "PUT" ? { "content-range": init.contentRange!, "content-length": String(init.body!.byteLength) } : {},
        body: init.body,
        signal: AbortSignal.any([c.req.raw.signal, AbortSignal.timeout(RELAY_TIMEOUT_MS)]),
      })
    } catch {
      return c.json({ error: "upload_unconfirmed", message: "Microsoft did not confirm this part. Query the upload status before sending more." }, 502)
    }
    const value: unknown = await response.json().catch(() => null)
    if (response.ok) {
      const offset = nextOffset(value)
      if (offset !== null && offset <= session.s) return c.json({ ok: true, status: "partial", nextOffset: offset })
      const file = extractMicrosoftDriveItem(value)
      if (file.id && (file.size === null || file.size === session.s)) return c.json({ ok: true, status: "complete", file })
      return c.json({ error: "upload_unconfirmed", message: "Microsoft returned an unexpected upload response. Check the file before retrying." }, 502)
    }
    if (response.status === 404) return c.json({ error: "upload_session_expired", message: "The Microsoft upload session expired or was cancelled. Check the file before starting another upload." }, 409)
    if (response.status === 409) return c.json({ error: "name_conflict", message: "A file with this name already exists in that folder. Choose another name." }, 409)
    if (response.status === 412) return c.json({ error: "drive_conflict", message: "The file changed while uploading, so it was not replaced. Download it again and reapply the edits, or save a copy." }, 409)
    if (response.status === 416) return c.json({ error: "upload_out_of_order", message: "Microsoft expected a different part. Query the upload status and continue from nextOffset." }, 409)
    return c.json({ error: "upload_unconfirmed", message: `Microsoft returned HTTP ${response.status}; the upload is not confirmed. Query its status before sending more.` }, 502)
  }

  const relayResponses = {
    200: jsonResponse("Progress or the saved file.", uploadProgressSchema),
    400: jsonResponse("Invalid Content-Range or part size.", errorSchema),
    404: jsonResponse("Unknown or expired upload.", errorSchema),
    409: jsonResponse("The session expired, the name is taken, the file changed (drive_conflict), or the part was out of order.", errorSchema),
    413: jsonResponse("The part is larger than chunkSize.", errorSchema),
    502: jsonResponse("Microsoft did not confirm the part.", errorSchema),
  }
  const relayQuery = queryValidator(z.object({ token: z.string().min(1).max(8192) }).strict())

  app.put("/v1/direct-uploads/microsoft-365/drive-upload-sessions/content", describeRoute({
    operationId: "relayHostMicrosoftDriveUpload", tags: ["Direct uploads"], security: [{ mcpAccessToken: [] }],
    summary: "Send one part of a host upload to OneDrive or SharePoint",
    description: "Send the file in order with Content-Range: bytes START-END/TOTAL, in parts of chunkSize bytes; non-final parts must be multiples of 320 KiB. Den forwards each part to Microsoft without keeping it.",
    requestBody: { content: { "application/octet-stream": { schema: { type: "string", format: "binary" } } } },
    responses: relayResponses,
  }), transportRoute, chunkBody, relayQuery, async (c) => {
    const match = /^bytes (\d{1,15})-(\d{1,15})\/(\d{1,15})$/.exec(c.req.header("content-range") ?? "")
    const start = match ? Number(match[1]) : NaN
    const end = match ? Number(match[2]) : NaN
    const total = match ? Number(match[3]) : NaN
    const length = end - start + 1
    const body = new Uint8Array(await c.req.arrayBuffer())
    if (!match || end < start || end >= total || length > MICROSOFT_DRIVE_UPLOAD_CHUNK_BYTES || (end + 1 < total && length % FRAGMENT_BYTES !== 0) || body.byteLength !== length) {
      return c.json({ error: "invalid_request", message: `Content-Range must be bytes START-END/TOTAL for exactly the bytes sent, at most ${MICROSOFT_DRIVE_UPLOAD_CHUNK_BYTES} bytes; non-final parts are multiples of 320 KiB.` }, 400)
    }
    return relay(c, { method: "PUT", contentRange: `bytes ${start}-${end}/${total}`, total, body })
  })

  app.get("/v1/direct-uploads/microsoft-365/drive-upload-sessions/content", describeRoute({
    operationId: "getHostMicrosoftDriveUploadStatus", tags: ["Direct uploads"], security: [{ mcpAccessToken: [] }],
    summary: "Check how much of a host upload Microsoft has received",
    description: "After an uncertain part, returns the offset to continue from. Never start another upload before checking.",
    responses: relayResponses,
  }), transportRoute, relayQuery, (c) => relay(c, { method: "GET" }))

  routeApp.route("/", app)
}
