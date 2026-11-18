import { Hono, type Context } from "hono"
import { describeRoute } from "hono-openapi"
import { z } from "zod"
import { normalizeDenTypeId } from "@openwork-ee/utils/typeid"
import { GOOGLE_DRIVE_EXPORT_FORMATS, GOOGLE_DRIVE_PULL_CHUNK_BYTES, GOOGLE_DRIVE_PULL_MAX_BYTES } from "@openwork/types/google-drive-upload"
import { attributeAuditRequest, auditSessionUserAttribution } from "../../audit/request-capture.js"
import { resolvePublicApiBaseUrl } from "../../capability-sources/generic-oauth.js"
import { signLink, verifyLink } from "../../capability-sources/signed-links.js"
import { env } from "../../env.js"
import { cloudTransportReadRoute, jsonValidator, orgMemberRoute, paramValidator, queryValidator, tokenRoute } from "../../middleware/index.js"
import { invalidRequestSchema, jsonResponse, unauthorizedSchema } from "../../openapi.js"
import { getOrganizationContextForUser } from "../../orgs.js"
import { readInternalCapabilityConnectorId } from "../../session.js"
import { readGoogleActionJson, requestGoogleAction, type GoogleWorkspaceActionDependencies } from "./google-workspace-actions.js"
import type { OrgRouteVariables } from "./shared.js"

const DRIVE_READ_SCOPES = [
  "https://www.googleapis.com/auth/drive.readonly",
  "https://www.googleapis.com/auth/drive",
  "https://www.googleapis.com/auth/drive.file",
]
const DRIVE_FOLDER_MIME_TYPE = "application/vnd.google-apps.folder"
const DRIVE_SHORTCUT_MIME_TYPE = "application/vnd.google-apps.shortcut"
// Streams are relayed at the client's pace, so they outlive the 30 s Google API budget; a client disconnect still stops them.
const DRIVE_STREAM_TIMEOUT_MS = 10 * 60 * 1000
// Short-lived like other agents' file download URLs (OpenAI's last about five minutes); a download in progress continues.
const DOWNLOAD_LINK_TTL_SECONDS = 5 * 60
const DOWNLOAD_LINK_DOMAIN = "openwork.google-drive.download-link.v1"
const FILE_FIELDS = "id,name,mimeType,size,md5Checksum,headRevisionId,version,modifiedTime,webViewLink,parents,trashed,shortcutDetails(targetId)"

const driveIdSchema = z.string().min(1).max(512).regex(/^[A-Za-z0-9_-]+$/)
const formatSchema = z.string().regex(/^[a-z]{2,5}$/).optional()
  .describe("Google Docs, Sheets, Slides and Drawings only: export format, such as xlsx or csv for a Sheet, docx, md, txt or pdf for a Doc, pptx for Slides. Defaults to the Office format.")
const connectionIdSchema = z.string().regex(/^(google-workspace|emc_[A-Za-z0-9]+)$/).optional()

const googleFileSchema = z.object({
  id: z.string(),
  name: z.string(),
  mimeType: z.string(),
  size: z.string().optional(),
  md5Checksum: z.string().optional(),
  headRevisionId: z.string().optional(),
  version: z.string().optional(),
  modifiedTime: z.string().optional(),
  webViewLink: z.string().optional(),
  parents: z.array(z.string()).optional(),
  trashed: z.boolean().optional(),
  shortcutDetails: z.object({ targetId: z.string().optional() }).optional(),
})

export const driveDownloadFileSchema = z.object({
  id: z.string(),
  name: z.string(),
  mimeType: z.string(),
  native: z.boolean().describe("Google Docs, Sheets, Slides or Drawings file, pulled as an export."),
  revision: z.string().nullable().describe("Pass back as baseRevision when replacing this file, so newer Drive changes are never overwritten silently."),
  md5Checksum: z.string().nullable(),
  size: z.number().int().nullable(),
  modifiedTime: z.string().nullable(),
  webViewLink: z.string().nullable(),
  parents: z.array(z.string()),
})

export const driveDownloadSchema = z.object({
  format: z.string().nullable(),
  mimeType: z.string(),
  extension: z.string().nullable().describe("Extension the saved file needs, for exports."),
  size: z.number().int().nullable().describe("Exact bytes for stored files; unknown until downloaded for exports."),
  exported: z.boolean(),
  maxBytes: z.number().int(),
})

const downloadInfoSchema = z.object({ ok: z.literal(true), file: driveDownloadFileSchema, download: driveDownloadSchema })
  .meta({ ref: "GoogleDriveDownloadInfo" })
const downloadLinkSchema = downloadInfoSchema.extend({
  downloadUrl: z.string().url().describe("Secret bearer URL for this one file, valid for five minutes. Do not print, share, log or persist it."),
  expiresAt: z.string().datetime(),
  resourceLink: z.object({
    type: z.literal("resource_link"), uri: z.string().url(), name: z.string(), mimeType: z.string(), size: z.number().int().optional(),
  }).describe("The same download as an MCP resource link."),
  instructions: z.string(),
}).meta({ ref: "GoogleDriveDownloadLink" })
const errorSchema = z.object({ error: z.string(), message: z.string() })

type DriveContext = Pick<Context<{ Variables: OrgRouteVariables }>, "get" | "json" | "req" | "header" | "body">
type DriveFile = z.infer<typeof driveDownloadFileSchema>
type DriveDownload = z.infer<typeof driveDownloadSchema>
type DescribeResult = { ok: true; file: DriveFile; download: DriveDownload } | { ok: false; reply: Response }

function exportFormat(format: string) {
  for (const formats of Object.values(GOOGLE_DRIVE_EXPORT_FORMATS)) {
    if (formats[format]) return formats[format]
  }
  return null
}

function googleApiBase() {
  return (env.googleApiBaseUrl ?? "https://www.googleapis.com").replace(/\/+$/, "")
}

function streaming(dependencies: GoogleWorkspaceActionDependencies): GoogleWorkspaceActionDependencies {
  return {
    ...dependencies,
    fetch: (input, init) => {
      const timeout = AbortSignal.timeout(DRIVE_STREAM_TIMEOUT_MS)
      return fetch(input, { ...init, signal: init?.signal ? AbortSignal.any([init.signal, timeout]) : timeout })
    },
  }
}

function selected(dependencies: GoogleWorkspaceActionDependencies, connectionId: string | null | undefined): GoogleWorkspaceActionDependencies {
  return connectionId === undefined ? dependencies : {
    ...dependencies,
    token: (identity) => dependencies.token({ ...identity, connectionId }),
  }
}

/** Metadata and the exact bytes a pull would save, without downloading anything. Shortcuts resolve to their target. */
async function describeDriveDownload(c: DriveContext, dependencies: GoogleWorkspaceActionDependencies, fileId: string, format: string | undefined, followShortcut = true): Promise<DescribeResult> {
  const url = new URL(`${googleApiBase()}/drive/v3/files/${encodeURIComponent(fileId)}`)
  url.searchParams.set("supportsAllDrives", "true")
  url.searchParams.set("fields", FILE_FIELDS)
  const result = await requestGoogleAction(c, dependencies, DRIVE_READ_SCOPES, url)
  if (!result.ok) return result
  const parsed = googleFileSchema.safeParse(await readGoogleActionJson(result.response))
  if (!parsed.success || parsed.data.id !== fileId) {
    return { ok: false, reply: c.json({ error: "google_api_error", message: "Google did not return the requested Drive file." }, 502) }
  }
  const google = parsed.data
  const target = google.shortcutDetails?.targetId
  if (google.mimeType === DRIVE_SHORTCUT_MIME_TYPE && followShortcut && target && driveIdSchema.safeParse(target).success) {
    return describeDriveDownload(c, dependencies, target, format, false)
  }
  if (google.mimeType === DRIVE_FOLDER_MIME_TYPE) {
    return { ok: false, reply: c.json({ error: "invalid_request", message: "This Drive item is a folder. Search the folder and pull its files one at a time." }, 400) }
  }
  if (google.trashed) {
    return { ok: false, reply: c.json({ error: "drive_file_trashed", message: "The Drive file is in the trash. Restore it before pulling it." }, 409) }
  }
  const native = google.mimeType.startsWith("application/vnd.google-apps.")
  const size = google.size === undefined ? null : Number(google.size)
  const file: DriveFile = {
    id: google.id, name: google.name, mimeType: google.mimeType, native,
    revision: (native ? google.version : google.headRevisionId ?? google.version) ?? null,
    md5Checksum: google.md5Checksum ?? null,
    size: native || size === null || !Number.isSafeInteger(size) ? null : size,
    modifiedTime: google.modifiedTime ?? null, webViewLink: google.webViewLink ?? null, parents: google.parents ?? [],
  }
  if (native) {
    const formats = GOOGLE_DRIVE_EXPORT_FORMATS[google.mimeType]
    if (!formats) {
      return { ok: false, reply: c.json({ error: "unsupported_drive_file", message: "Only Google Docs, Sheets, Slides and Drawings can be exported; this Google file type has no downloadable content." }, 400) }
    }
    const chosen = format ?? Object.keys(formats)[0]
    const exported = formats[chosen]
    if (!exported) {
      return { ok: false, reply: c.json({ error: "invalid_request", message: `This file can be pulled as: ${Object.keys(formats).join(", ")}.` }, 400) }
    }
    return { ok: true, file, download: { format: chosen, mimeType: exported.mimeType, extension: exported.extension, size: null, exported: true, maxBytes: GOOGLE_DRIVE_PULL_MAX_BYTES } }
  }
  if (format !== undefined) {
    return { ok: false, reply: c.json({ error: "invalid_request", message: "format applies only to Google Docs, Sheets, Slides and Drawings; stored files are pulled byte for byte." }, 400) }
  }
  if (file.size !== null && file.size > GOOGLE_DRIVE_PULL_MAX_BYTES) {
    return { ok: false, reply: c.json({ error: "file_too_large", message: `This file is ${file.size} bytes; pulls support files up to ${GOOGLE_DRIVE_PULL_MAX_BYTES} bytes.` }, 413) }
  }
  return { ok: true, file, download: { format: null, mimeType: google.mimeType, extension: null, size: file.size, exported: false, maxBytes: GOOGLE_DRIVE_PULL_MAX_BYTES } }
}

/** Stops a stream that grows past the pull cap; the client sees a short, failed download. */
function capped(body: ReadableStream<Uint8Array>, maxBytes: number) {
  let seen = 0
  return body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      seen += chunk.byteLength
      if (seen > maxBytes) {
        controller.error(new Error("Drive download exceeded the pull size limit."))
        return
      }
      controller.enqueue(chunk)
    },
  }))
}

async function streamDriveContent(
  c: DriveContext,
  dependencies: GoogleWorkspaceActionDependencies,
  fileId: string,
  format: string | undefined,
  range: string | undefined,
) {
  let url: URL
  if (format !== undefined) {
    const target = exportFormat(format)
    if (!target) return c.json({ error: "invalid_request", message: "Unknown export format." }, 400)
    if (range) return c.json({ error: "invalid_request", message: "Exports are downloaded whole; omit Range." }, 400)
    url = new URL(`${googleApiBase()}/drive/v3/files/${encodeURIComponent(fileId)}/export`)
    url.searchParams.set("mimeType", target.mimeType)
  } else {
    url = new URL(`${googleApiBase()}/drive/v3/files/${encodeURIComponent(fileId)}`)
    url.searchParams.set("alt", "media")
    url.searchParams.set("supportsAllDrives", "true")
  }
  if (range) {
    const match = /^bytes=(\d{1,15})-(\d{1,15})$/.exec(range)
    const start = match ? Number(match[1]) : NaN
    const end = match ? Number(match[2]) : NaN
    if (!match || end < start || end - start + 1 > GOOGLE_DRIVE_PULL_CHUNK_BYTES || end >= GOOGLE_DRIVE_PULL_MAX_BYTES) {
      return c.json({ error: "invalid_request", message: `Range must be bytes=START-END, at most ${GOOGLE_DRIVE_PULL_CHUNK_BYTES} bytes, inside the pull size limit.` }, 400)
    }
  }
  const result = await requestGoogleAction(c, streaming(dependencies), DRIVE_READ_SCOPES, url, range ? { headers: { range } } : {})
  if (!result.ok) return result.reply
  const upstream = result.response
  if (!upstream.body) return c.json({ error: "google_api_error", message: "Google returned no file content." }, 502)
  const headers: Record<string, string> = { "content-type": "application/octet-stream", "cache-control": "no-store", "x-content-type-options": "nosniff" }
  const contentRange = upstream.headers.get("content-range")
  if (contentRange) headers["content-range"] = contentRange
  const contentLength = upstream.headers.get("content-length")
  if (contentLength && Number(contentLength) <= GOOGLE_DRIVE_PULL_MAX_BYTES) headers["content-length"] = contentLength
  return c.body(capped(upstream.body, range ? GOOGLE_DRIVE_PULL_CHUNK_BYTES : GOOGLE_DRIVE_PULL_MAX_BYTES), upstream.status === 206 ? 206 : 200, headers)
}

const downloadLinkPayloadSchema = z.object({
  v: z.literal(1), o: z.string(), u: z.string(), m: z.string(), c: z.string().nullable(),
  f: driveIdSchema, x: z.string().nullable(), e: z.number().int(),
})

function signDownloadLink(payload: z.infer<typeof downloadLinkPayloadSchema>) {
  return signLink(DOWNLOAD_LINK_DOMAIN, payload)
}

function verifyDownloadLink(token: string) {
  return verifyLink(DOWNLOAD_LINK_DOMAIN, token, downloadLinkPayloadSchema)
}

/** Drive file downloads for host file transport and shell clients; bytes never enter tool results. */
export function registerGoogleDriveFileRoutes<T extends { Variables: OrgRouteVariables }>(routeApp: Hono<T>, dependencies: GoogleWorkspaceActionDependencies) {
  const app = new Hono<{ Variables: OrgRouteVariables }>()
  const fileParams = z.object({ fileId: driveIdSchema })
  const hostQuery = z.object({ format: formatSchema, connectionId: connectionIdSchema }).strict()
  const commonErrors = {
    400: jsonResponse("Folder, unsupported Google file type or invalid format.", invalidRequestSchema.or(errorSchema)),
    401: jsonResponse("Sign in first.", unauthorizedSchema),
    403: jsonResponse("Organization policy blocks the selected connection.", errorSchema),
    409: jsonResponse("Connect Google with Drive read access, or the file is in the trash.", errorSchema),
    413: jsonResponse("The file is larger than the pull size limit.", errorSchema),
    502: jsonResponse("Google refused or did not return the file; the message gives Google's reason.", errorSchema),
  }

  app.get("/v1/direct-downloads/google-workspace/drive-files/:fileId", describeRoute({
    operationId: "describeHostGoogleDriveDownload", tags: ["Direct uploads"], security: [{ mcpAccessToken: [] }],
    summary: "Describe a Google Drive file pull for host file transport",
    description: "Returns the file's revision, checksum and the exact format and size a pull would save, without downloading content. Hosts then fetch the content route in ranged chunks. Optional connectionId selects a native Google Workspace connection; unavailable selections never fall back to the default.",
    responses: { 200: jsonResponse("Pull plan; no file content.", downloadInfoSchema), ...commonErrors },
  }), cloudTransportReadRoute(), paramValidator(fileParams), queryValidator(hostQuery), async (c) => {
    const { fileId } = c.req.valid("param")
    const { format, connectionId } = c.req.valid("query")
    const described = await describeDriveDownload(c, selected(dependencies, connectionId), fileId, format)
    if (!described.ok) return described.reply
    c.header("cache-control", "no-store")
    return c.json({ ok: true, file: described.file, download: described.download })
  })

  app.get("/v1/direct-downloads/google-workspace/drive-files/:fileId/content", describeRoute({
    operationId: "downloadHostGoogleDriveFile", tags: ["Direct uploads"], security: [{ mcpAccessToken: [] }],
    summary: "Stream a Google Drive file's bytes to host file transport",
    description: "Streams stored files as-is (Range: bytes=START-END, up to 8 MiB per request) or exports Google files whole in the requested format. Den does not keep or inspect the bytes. Responses stop at the pull size limit.",
    responses: {
      200: { description: "File bytes.", content: { "application/octet-stream": { schema: { type: "string", format: "binary" } } } },
      206: { description: "Requested byte range.", content: { "application/octet-stream": { schema: { type: "string", format: "binary" } } } },
      ...commonErrors,
    },
  }), cloudTransportReadRoute(), paramValidator(fileParams), queryValidator(hostQuery), async (c) => {
    const { fileId } = c.req.valid("param")
    const { format, connectionId } = c.req.valid("query")
    return streamDriveContent(c, selected(dependencies, connectionId), fileId, format, c.req.header("range"))
  })

  app.post("/v1/capabilities/google-workspace/drive-download-links", describeRoute({
    operationId: "createGoogleDriveDownloadLink", tags: ["Capability Sources"],
    summary: "Create a five-minute download link for one Google Drive file, for clients with a shell",
    description: "For clients without OpenWork host file transport but with a shell, such as a Workbot computer or a coding agent. Download with curl into a file instead of reading the file into context; Docs, Sheets and Slides export to Office formats by default. To save edits back, prepare createGoogleDriveUploadSession with fileId and this revision as baseRevision. Uses the selected connection.",
    responses: { 200: jsonResponse("Short-lived bearer download URL, as JSON and as an MCP resource link, with the file's revision; no file content.", downloadLinkSchema), ...commonErrors },
  }), orgMemberRoute(), jsonValidator(z.object({ fileId: driveIdSchema, format: formatSchema }).strict()), async (c) => {
    const context = c.get("organizationContext")
    if (!context) return c.json({ error: "unauthorized", message: "Sign in to an organization first." }, 401)
    const { fileId, format } = c.req.valid("json")
    const connectionId = readInternalCapabilityConnectorId(c.req.raw.headers)
    const described = await describeDriveDownload(c, selected(dependencies, connectionId ?? undefined), fileId, format)
    if (!described.ok) return described.reply
    const expires = Math.floor(Date.now() / 1000) + DOWNLOAD_LINK_TTL_SECONDS
    const token = signDownloadLink({
      v: 1, o: context.organization.id, u: context.currentMember.userId, m: context.currentMember.id,
      c: connectionId, f: described.file.id, x: described.download.format, e: expires,
    })
    // In the query, which request traces strip, rather than the path they keep.
    const downloadUrl = `${resolvePublicApiBaseUrl(c.req.raw, env.apiPublicUrl)}/v1/direct-downloads/google-workspace/drive-link?token=${token}`
    const name = `${described.file.name}${described.download.extension && !described.file.name.toLowerCase().endsWith(described.download.extension) ? described.download.extension : ""}`
    c.header("cache-control", "no-store")
    return c.json({
      ok: true, file: described.file, download: described.download, downloadUrl, expiresAt: new Date(expires * 1000).toISOString(),
      resourceLink: { type: "resource_link", uri: downloadUrl, name, mimeType: described.download.mimeType, ...(described.download.size === null ? {} : { size: described.download.size }) },
      instructions: `Save it straight to a file, for example: curl -fsSL -o 'drive-download' '<downloadUrl>'. Choose a local output path you control; treat the Drive filename as data, never as shell code. Check the size${described.file.md5Checksum ? " and md5" : ""} against this result. Work on the file with shell tools, then save edits back with createGoogleDriveUploadSession (fileId, baseRevision: "${described.file.revision ?? ""}").`,
    })
  })

  app.get("/v1/direct-downloads/google-workspace/drive-link", describeRoute({
    operationId: "downloadGoogleDriveFileByLink", tags: ["Direct uploads"], security: [],
    summary: "Download one Google Drive file with a short-lived link",
    description: "The signed link names one member, connection, file and format and expires after five minutes. The member's current organization access and Google connection are checked again on every download.",
    responses: {
      200: { description: "File bytes.", content: { "application/octet-stream": { schema: { type: "string", format: "binary" } } } },
      404: jsonResponse("Unknown or expired link.", errorSchema),
      ...commonErrors,
    },
  }), tokenRoute, queryValidator(z.object({ token: z.string().min(1).max(2048) }).strict()), async (c) => {
    const payload = verifyDownloadLink(c.req.valid("query").token)
    if (!payload) return c.json({ error: "not_found", message: "This download link is unknown or expired. Create a new one." }, 404)
    const context = await getOrganizationContextForUser({
      userId: normalizeDenTypeId("user", payload.u),
      organizationId: normalizeDenTypeId("organization", payload.o),
    })
    if (!context || context.currentMember.id !== payload.m) {
      return c.json({ error: "not_found", message: "This download link is unknown or expired. Create a new one." }, 404)
    }
    const attribution = auditSessionUserAttribution(payload.u, payload.m)
    if (attribution) {
      const audited = await attributeAuditRequest(c, { organizationId: payload.o, ...attribution, origin: "mcp" })
      if (!audited.ok) return audited.response
    }
    c.set("organizationContext", context)
    return streamDriveContent(c, selected(dependencies, payload.c), payload.f, payload.x ?? undefined, c.req.header("range"))
  })

  routeApp.route("/", app)
}
