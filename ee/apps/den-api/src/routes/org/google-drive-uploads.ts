import { Hono } from "hono"
import { describeRoute } from "hono-openapi"
import { z } from "zod"
import { GOOGLE_DRIVE_UPLOAD_CHUNK_BYTES, GOOGLE_DRIVE_UPLOAD_MAX_BYTES, isGoogleDriveUploadSessionUrl } from "@openwork/types/google-drive-upload"
import { env } from "../../env.js"
import { requireFeature } from "../../features.js"
import { cloudTransportRoute, jsonValidator, orgMemberRoute } from "../../middleware/index.js"
import { invalidRequestSchema, jsonResponse, unauthorizedSchema } from "../../openapi.js"
import { requestGoogleAction, type GoogleWorkspaceActionDependencies } from "./google-workspace-actions.js"
import type { OrgRouteVariables } from "./shared.js"

export const driveUploadSessionBodySchema = z.object({
  name: z.string().trim().min(1).max(255).regex(/^[^\x00-\x1f\x7f]+$/).describe("File basename; no file bytes or local paths."),
  size: z.number().int().min(1).max(GOOGLE_DRIVE_UPLOAD_MAX_BYTES).describe("Exact file size in bytes, up to Google's 5 TiB limit."),
  mimeType: z.string().min(1).max(255).regex(/^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+$/).default("application/octet-stream"),
  folderId: z.string().min(1).max(512).regex(/^[A-Za-z0-9_-]+$/).optional(),
}).strict()

export const driveUploadSessionResponseSchema = z.object({
  ok: z.literal(true),
  uploadUrl: z.string().url().describe("Secret bearer upload-session URL. Never print, share, persist, or log it. Only upload the authorized file; no Google access token is needed."),
  method: z.literal("PUT"),
  size: z.number().int(),
  chunkSize: z.literal(GOOGLE_DRIVE_UPLOAD_CHUNK_BYTES),
  instructions: z.string(),
}).meta({ ref: "GoogleDriveUploadSessionResponse" })

const sessionDescription = "Prepare a Google Drive resumable upload session for an explicitly requested file upload. This does not upload bytes or prove completion. Clients with file transport can PUT local bytes directly to the returned secret uploadUrl, outside model context. Google sessions can remain valid for up to one week; they are not short-lived signed URLs. Do not automatically create another session after an uncertain result. Final PUT returns file metadata. Uses the selected connection."

/** Shared implementation: native capability selects via signed headers; hosts via explicit connectionId. */
export function registerGoogleDriveUploadRoutes<T extends { Variables: OrgRouteVariables }>(routeApp: Hono<T>, dependencies: GoogleWorkspaceActionDependencies) {
  const app = new Hono<{ Variables: OrgRouteVariables }>()
  const responseErrors = {
    400: jsonResponse("Invalid upload metadata.", invalidRequestSchema),
    401: jsonResponse("Sign in first.", unauthorizedSchema),
    403: jsonResponse("Organization policy blocks the selected connection.", z.object({ error: z.string(), message: z.string() })),
    404: jsonResponse("Resumable uploads are disabled.", z.object({ error: z.literal("feature_disabled"), feature: z.literal("driveResumableUploads") })),
    409: jsonResponse("Connect Google with Drive write access.", z.object({ error: z.string(), message: z.string() })),
    502: jsonResponse("Google did not confirm upload preparation.", z.object({ error: z.string(), message: z.string() })),
  }
  const hostBody = driveUploadSessionBodySchema.extend({
    connectionId: z.string().regex(/^(google-workspace|emc_[A-Za-z0-9]+)$/).optional(),
  })
  const handler = async (c: Parameters<typeof requestGoogleAction>[0], input: z.infer<typeof hostBody>) => {
    const base = (env.googleApiBaseUrl ?? "https://www.googleapis.com").replace(/\/+$/, "")
    const url = new URL(`${base}/upload/drive/v3/files`)
    url.searchParams.set("uploadType", "resumable")
    url.searchParams.set("supportsAllDrives", "true")
    url.searchParams.set("fields", "id,name,mimeType,modifiedTime,webViewLink,size")
    const selectedDependencies = input.connectionId === undefined ? dependencies : {
      ...dependencies,
      token: (identity: Parameters<GoogleWorkspaceActionDependencies["token"]>[0]) => dependencies.token({ ...identity, connectionId: input.connectionId }),
    }
    const result = await requestGoogleAction(c, selectedDependencies,
      ["https://www.googleapis.com/auth/drive.file", "https://www.googleapis.com/auth/drive"], url, {
        method: "POST",
        redirect: "error",
        headers: { "x-upload-content-type": input.mimeType, "x-upload-content-length": String(input.size) },
        body: JSON.stringify({ name: input.name, mimeType: input.mimeType, ...(input.folderId ? { parents: [input.folderId] } : {}) }),
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
      instructions: "Keep uploadUrl secret (a bearer credential, valid for up to one week). PUT bytes with Content-Type and Content-Range: bytes START-END/TOTAL; non-final chunks must be multiples of 256 KiB. HTTP 308 is progress, not a redirect: read Range for the committed offset. After an uncertain PUT, query this SAME session with an empty PUT and Content-Range: bytes */TOTAL before resending. HTTP 200/201 with a file id confirms completion. Never forward OpenWork or Google authorization headers to the session URL. Unfinished sessions expire according to Google's policy. Do not put file bytes in tool arguments.",
    })
  }
  app.post("/v1/capabilities/google-workspace/drive-upload-sessions", describeRoute({
    operationId: "createGoogleDriveUploadSession", tags: ["Capability Sources"],
    summary: "Prepare a resumable Google Drive file upload for a client with local file transport",
    description: sessionDescription,
    responses: { 200: jsonResponse("Secret upload session; file not yet uploaded.", driveUploadSessionResponseSchema), ...responseErrors },
  }), orgMemberRoute(), requireFeature("driveResumableUploads"), jsonValidator(driveUploadSessionBodySchema), async (c) => handler(c, c.req.valid("json")))
  app.post("/v1/direct-uploads/google-workspace/drive-upload-sessions", describeRoute({
    operationId: "prepareHostGoogleDriveUploadSession", tags: ["Direct uploads"],
    summary: "Prepare a Google Drive session for host file transport", description: sessionDescription,
    responses: { 200: jsonResponse("Secret upload session for host transport.", driveUploadSessionResponseSchema), ...responseErrors },
  }), cloudTransportRoute(), requireFeature("driveResumableUploads"), jsonValidator(hostBody), async (c) => handler(c, c.req.valid("json")))
  routeApp.route("/", app)
}
