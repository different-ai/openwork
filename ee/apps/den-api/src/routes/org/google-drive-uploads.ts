import { Hono } from "hono"
import { describeRoute } from "hono-openapi"
import { z } from "zod"
import { GOOGLE_DRIVE_CONVERTIBLE_MIME_TYPES, GOOGLE_DRIVE_UPLOAD_CHUNK_BYTES, GOOGLE_DRIVE_UPLOAD_MAX_BYTES, isGoogleDriveUploadSessionUrl } from "@openwork/types/google-drive-upload"
import { env } from "../../env.js"
import { cloudTransportRoute, jsonValidator, orgMemberRoute } from "../../middleware/index.js"
import { invalidRequestSchema, jsonResponse, unauthorizedSchema } from "../../openapi.js"
import { readGoogleActionJson, requestGoogleAction, type GoogleWorkspaceActionDependencies } from "./google-workspace-actions.js"
import type { OrgRouteVariables } from "./shared.js"

const driveIdSchema = z.string().min(1).max(512).regex(/^[A-Za-z0-9_-]+$/)
const driveWriteScopes = ["https://www.googleapis.com/auth/drive.file", "https://www.googleapis.com/auth/drive"]
const uploadedFileFields = "id,name,mimeType,modifiedTime,webViewLink,size,md5Checksum,headRevisionId,version"

const sessionFields = z.object({
  name: z.string().trim().min(1).max(255).regex(/^[^\x00-\x1f\x7f]+$/).describe("File basename; no file bytes or local paths. Ignored when replacing a file."),
  size: z.number().int().min(1).max(GOOGLE_DRIVE_UPLOAD_MAX_BYTES).describe("Exact file size in bytes, up to Google's 5 TiB limit."),
  mimeType: z.string().min(1).max(255).regex(/^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+$/).default("application/octet-stream"),
  folderId: driveIdSchema.optional(),
  fileId: driveIdSchema.optional().describe("Replace this existing file's content instead of creating a file. It keeps its ID, link, sharing and comments; the previous version stays in Drive's version history for 30 days."),
  baseRevision: z.string().min(1).max(512).optional().describe("Required with fileId: the revision your copy was downloaded from. Refused with drive_conflict when Drive changed since; download the newer version and reapply the edits, or save a new file."),
  convertTo: z.enum(GOOGLE_DRIVE_CONVERTIBLE_MIME_TYPES).optional().describe("New files only: save the uploaded Office file as this native Google Docs, Sheets or Slides type."),
})

function refineSession(input: z.infer<typeof sessionFields>, ctx: z.RefinementCtx) {
  if (input.fileId && input.folderId) ctx.addIssue({ code: "custom", path: ["folderId"], message: "A replaced file keeps its folder; omit folderId with fileId." })
  if (input.fileId && input.convertTo) ctx.addIssue({ code: "custom", path: ["convertTo"], message: "convertTo applies only to new files." })
  if (input.baseRevision && !input.fileId) ctx.addIssue({ code: "custom", path: ["baseRevision"], message: "baseRevision requires fileId." })
  if (input.fileId && !input.baseRevision) ctx.addIssue({ code: "custom", path: ["baseRevision"], message: "Replacing a file needs the revision it was downloaded from, so newer Drive changes are never overwritten. Download the file first." })
}

export const driveUploadSessionBodySchema = sessionFields.strict().superRefine(refineSession)

export const driveUploadSessionResponseSchema = z.object({
  ok: z.literal(true),
  uploadUrl: z.string().url().describe("Secret bearer upload-session URL. Never print, share, persist, or log it. Only upload the authorized file; no Google access token is needed."),
  method: z.literal("PUT"),
  size: z.number().int(),
  chunkSize: z.literal(GOOGLE_DRIVE_UPLOAD_CHUNK_BYTES),
  replaces: z.object({ fileId: z.string(), previousRevision: z.string().nullable() }).optional().describe("Present when the upload replaces an existing file's content."),
  instructions: z.string(),
}).meta({ ref: "GoogleDriveUploadSessionResponse" })

const replaceTargetSchema = z.object({
  id: z.string(),
  mimeType: z.string(),
  trashed: z.boolean().optional(),
  headRevisionId: z.string().optional(),
  version: z.string().optional(),
  modifiedTime: z.string().optional(),
})

const sessionDescription = "Prepare a Google Drive resumable upload session for an explicitly requested file upload. This does not upload bytes or prove completion. Clients with file transport can PUT local bytes directly to the returned secret uploadUrl, outside model context. With fileId the upload replaces that file's content as a new Drive version; with convertTo a new Office file becomes a native Google file. Google sessions can remain valid for up to one week; they are not short-lived signed URLs. Do not automatically create another session after an uncertain result. Final PUT returns file metadata, including headRevisionId and md5Checksum for later replaces. Uses the selected connection."

/** Shared implementation: native capability selects via signed headers; hosts via explicit connectionId. */
export function registerGoogleDriveUploadRoutes<T extends { Variables: OrgRouteVariables }>(routeApp: Hono<T>, dependencies: GoogleWorkspaceActionDependencies) {
  const app = new Hono<{ Variables: OrgRouteVariables }>()
  const errorSchema = z.object({ error: z.string(), message: z.string() })
  const responseErrors = {
    400: jsonResponse("Invalid upload metadata, or a Google Docs, Sheets or Slides file cannot be replaced by an upload.", invalidRequestSchema.or(errorSchema)),
    401: jsonResponse("Sign in first.", unauthorizedSchema),
    403: jsonResponse("Organization policy blocks the selected connection.", errorSchema),
    409: jsonResponse("Connect Google with Drive write access, or the file changed in Drive since baseRevision (drive_conflict) or is in the trash.", errorSchema.extend({
      currentRevision: z.string().nullable().optional(),
      modifiedTime: z.string().nullable().optional(),
    })),
    502: jsonResponse("Google did not confirm upload preparation.", errorSchema),
  }
  const hostBody = sessionFields.extend({
    connectionId: z.string().regex(/^(google-workspace|emc_[A-Za-z0-9]+)$/).optional(),
  }).strict().superRefine(refineSession)
  const handler = async (c: Parameters<typeof requestGoogleAction>[0], input: z.infer<typeof hostBody>) => {
    const base = (env.googleApiBaseUrl ?? "https://www.googleapis.com").replace(/\/+$/, "")
    const selectedDependencies = input.connectionId === undefined ? dependencies : {
      ...dependencies,
      token: (identity: Parameters<GoogleWorkspaceActionDependencies["token"]>[0]) => dependencies.token({ ...identity, connectionId: input.connectionId }),
    }
    let replaces: { fileId: string; previousRevision: string | null } | undefined
    if (input.fileId) {
      // Check-then-write: Drive has no compare-and-swap for content, so this
      // narrows the window and the replaced version stays in Drive's history.
      const metadataUrl = new URL(`${base}/drive/v3/files/${encodeURIComponent(input.fileId)}`)
      metadataUrl.searchParams.set("supportsAllDrives", "true")
      metadataUrl.searchParams.set("fields", "id,mimeType,trashed,headRevisionId,version,modifiedTime")
      const current = await requestGoogleAction(c, selectedDependencies, driveWriteScopes, metadataUrl)
      if (!current.ok) return current.reply
      const target = replaceTargetSchema.safeParse(await readGoogleActionJson(current.response))
      if (!target.success || target.data.id !== input.fileId) {
        return c.json({ error: "google_api_error", message: "Google did not return the file to replace. No file bytes were sent." }, 502)
      }
      if (target.data.mimeType.startsWith("application/vnd.google-apps.")) {
        return c.json({ error: "native_file_replace_unsupported", message: "Google Docs, Sheets and Slides files cannot be replaced by an uploaded file. Save the edited file as a new file instead (convertTo keeps it a Google file), or edit a Sheet with the Sheets values actions." }, 400)
      }
      if (target.data.trashed) {
        return c.json({ error: "drive_file_trashed", message: "The Drive file is in the trash. Restore it before replacing its content." }, 409)
      }
      const currentRevision = target.data.headRevisionId ?? target.data.version ?? null
      if (input.baseRevision !== undefined && input.baseRevision !== currentRevision) {
        return c.json({
          error: "drive_conflict",
          message: "The file changed in Drive since this copy was downloaded, so it was not replaced. Download it again and reapply the edits, or save the edits as a new file.",
          currentRevision, modifiedTime: target.data.modifiedTime ?? null,
        }, 409)
      }
      replaces = { fileId: input.fileId, previousRevision: currentRevision }
    }
    const url = new URL(`${base}/upload/drive/v3/files${input.fileId ? `/${encodeURIComponent(input.fileId)}` : ""}`)
    url.searchParams.set("uploadType", "resumable")
    url.searchParams.set("supportsAllDrives", "true")
    url.searchParams.set("fields", uploadedFileFields)
    const result = await requestGoogleAction(c, selectedDependencies, driveWriteScopes, url, {
      method: input.fileId ? "PATCH" : "POST",
      redirect: "error",
      headers: { "x-upload-content-type": input.mimeType, "x-upload-content-length": String(input.size) },
      body: JSON.stringify(input.fileId ? {} : {
        name: input.name,
        mimeType: input.convertTo ?? input.mimeType,
        ...(input.folderId ? { parents: [input.folderId] } : {}),
      }),
    })
    if (!result.ok) return result.reply
    const uploadUrl = result.response.headers.get("location")
    await result.response.body?.cancel()
    if (!uploadUrl || !isGoogleDriveUploadSessionUrl(uploadUrl, base)) {
      return c.json({ error: "google_api_error", message: "Google returned an invalid upload session. No file bytes were sent; do not retry automatically." }, 502)
    }
    c.header("cache-control", "no-store")
    return c.json({
      ok: true, uploadUrl, method: "PUT", size: input.size, chunkSize: GOOGLE_DRIVE_UPLOAD_CHUNK_BYTES,
      ...(replaces ? { replaces } : {}),
      instructions: "Keep uploadUrl secret (a bearer credential, valid for up to one week). PUT bytes with Content-Type and Content-Range: bytes START-END/TOTAL; non-final chunks must be multiples of 256 KiB. HTTP 308 is progress, not a redirect: read Range for the committed offset. After an uncertain PUT, query this SAME session with an empty PUT and Content-Range: bytes */TOTAL before resending. HTTP 200/201 with a file id confirms completion. Never forward OpenWork or Google authorization headers to the session URL. Unfinished sessions expire according to Google's policy. Do not put file bytes in tool arguments.",
    })
  }
  app.post("/v1/capabilities/google-workspace/drive-upload-sessions", describeRoute({
    operationId: "createGoogleDriveUploadSession", tags: ["Capability Sources"],
    summary: "Prepare a resumable Google Drive upload, or a replacement of an existing file's content, for a client with local file transport",
    description: sessionDescription,
    responses: { 200: jsonResponse("Secret upload session; file not yet uploaded.", driveUploadSessionResponseSchema), ...responseErrors },
  }), orgMemberRoute(), jsonValidator(driveUploadSessionBodySchema), async (c) => handler(c, c.req.valid("json")))
  app.post("/v1/direct-uploads/google-workspace/drive-upload-sessions", describeRoute({
    operationId: "prepareHostGoogleDriveUploadSession", tags: ["Direct uploads"],
    summary: "Prepare a Google Drive session for host file transport", description: sessionDescription,
    responses: { 200: jsonResponse("Secret upload session for host transport.", driveUploadSessionResponseSchema), ...responseErrors },
  }), cloudTransportRoute(), jsonValidator(hostBody), async (c) => handler(c, c.req.valid("json")))
  routeApp.route("/", app)
}
