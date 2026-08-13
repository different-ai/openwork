import { TempFileTable } from "@openwork-ee/den-db/schema"
import { createDenTypeId, normalizeDenTypeId } from "@openwork-ee/utils/typeid"
import { and, count, eq, gt, lt } from "@openwork-ee/den-db/drizzle"
import type { Hono } from "hono"
import { bodyLimit } from "hono/body-limit"
import { describeRoute, type DescribeRouteOptions } from "hono-openapi"
import { z } from "zod"
import { db } from "../../db.js"
import { env } from "../../env.js"
import { jsonResponse, notFoundSchema, unauthorizedSchema } from "../../openapi.js"
import { jsonValidator, orgMemberRoute, publicRoute } from "../../middleware/index.js"
import {
  createTempFileTokenPair,
  resolveTempFileContentType,
  sanitizeTempFilename,
  tempFileContentUrl,
  tempFileExpiresAt,
  verifyTempFileToken,
} from "../../temp-files.js"
import { resolveTempFileStorage, type TempFileStorage } from "../../temp-file-storage.js"
import { checkRateLimit } from "../../utils/rate-limit.js"
import type { OrgRouteVariables } from "./shared.js"

const MINT_RATE_LIMIT_MAX = 60
const MINT_RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000
// Multipart is not accepted here, so the only overhead above the byte cap is
// chunked-transfer framing.
const BODY_LIMIT_HEADROOM_BYTES = 64 * 1024

const mintTemporaryFileSchema = z.object({
  filename: z.string().trim().min(1).max(255)
    .describe("Base filename with extension, for example report.pdf. Used as the served filename."),
  contentType: z.string().trim().max(255).optional()
    .describe("MIME type of the bytes you will upload, for example application/pdf. Defaults to application/octet-stream."),
  sizeBytes: z.number().int().positive().optional()
    .describe("Byte size of the file you will upload, from ls -l or stat. Supplying it fails fast instead of failing mid-upload."),
}).meta({ ref: "TemporaryFileMintRequest" })

const mintResponseSchema = z.object({
  fileId: z.string(),
  uploadUrl: z.string(),
  downloadUrl: z.string(),
  expiresAt: z.string(),
  maxBytes: z.number(),
  storageTier: z.enum(["volume", "s3"]),
  instructions: z.string(),
}).meta({ ref: "TemporaryFileMintResponse" })

const uploadResponseSchema = z.object({
  ok: z.literal(true),
  fileId: z.string(),
  sizeBytes: z.number(),
  expiresAt: z.string(),
}).meta({ ref: "TemporaryFileUploadResponse" })

const temporaryFileErrorSchema = z.object({
  error: z.string(),
  message: z.string().optional(),
  maxBytes: z.number().optional(),
  retryAfterSeconds: z.number().optional(),
}).meta({ ref: "TemporaryFileError" })

// The description below is the only steering surface this feature has. Agents
// reach it through search_capabilities, on every harness, with no prompt
// changes, so it has to state the whole contract on its own.
const MINT_DESCRIPTION = [
  "Creates a short-lived private file slot and returns an uploadUrl and a downloadUrl.",
  "Use this whenever another capability or connected tool needs a URL to a file that exists in your workspace —",
  "for example a parameter described as a file URL, document URL, or attachment URL.",
  "After minting, upload the raw bytes from your execution environment with a real HTTP PUT, for example:",
  "curl -sS -X PUT --data-binary @/path/to/file '<uploadUrl>'.",
  "Then pass downloadUrl, never uploadUrl, to the tool that needs the file.",
  "The uploadUrl accepts exactly one PUT of at most maxBytes bytes, and both URLs stop working at expiresAt.",
  "Never paste, print, or base64-encode file bytes into a message or a tool argument: the bytes must travel only through the PUT.",
  "The downloadUrl is an unguessable expiring link that external services can fetch without additional authentication,",
  "so share it only with the tool that should read the file.",
].join(" ")

// The byte routes carry URLs that are handed out, never searched for. The tag
// is already outside SAFE_INCLUDED_TAGS; the explicit flag keeps them out of
// the capability catalog even if that tag list later changes.
type NonMcpDescribeRouteOptions = DescribeRouteOptions & { "x-mcp": false }
const describeNonMcpRoute = (options: NonMcpDescribeRouteOptions) => describeRoute(options)

function uploadInstructions(uploadUrl: string) {
  return `Upload the file bytes with: curl -sS -X PUT --data-binary @<path> '${uploadUrl}' — then pass downloadUrl to the tool that needs the file. Do not print the bytes.`
}

function publicBaseUrl() {
  return env.apiPublicUrl ?? `http://127.0.0.1:${env.port}`
}

async function loadTempFile(fileId: string) {
  let normalized
  try {
    normalized = normalizeDenTypeId("tempFile", fileId)
  } catch {
    return null
  }
  const [row] = await db.select().from(TempFileTable).where(eq(TempFileTable.id, normalized)).limit(1)
  return row ?? null
}

async function discardTempFile(storage: TempFileStorage, row: { id: string; storage_key: string }) {
  await storage.delete(row.storage_key).catch(() => undefined)
  await db.delete(TempFileTable).where(eq(TempFileTable.id, normalizeDenTypeId("tempFile", row.id)))
}

export function registerTemporaryFileRoutes<T extends { Variables: OrgRouteVariables }>(
  app: Hono<T>,
  options: { storage?: TempFileStorage; publicBaseUrl?: string; now?: () => Date } = {},
) {
  const storage = options.storage ?? resolveTempFileStorage()
  const baseUrl = options.publicBaseUrl ?? publicBaseUrl()
  const clock = options.now ?? (() => new Date())

  app.post(
    "/v1/temporary-files",
    describeRoute({
      tags: ["Temporary Files"],
      summary: "Create a temporary file slot with an upload URL and an expiring download URL",
      description: MINT_DESCRIPTION,
      responses: {
        200: jsonResponse("The temporary file slot was created.", mintResponseSchema),
        401: jsonResponse("The caller must be an organization member.", unauthorizedSchema),
        413: jsonResponse("The declared size exceeds the configured maximum.", temporaryFileErrorSchema),
        429: jsonResponse("Too many temporary files were created.", temporaryFileErrorSchema),
      },
    }),
    orgMemberRoute(),
    jsonValidator(mintTemporaryFileSchema),
    async (c) => {
      const payload = c.get("organizationContext")
      if (!payload) return c.json({ error: "unauthorized" }, 401)

      const body = c.req.valid("json")
      const now = clock()

      const retryAfterSeconds = await checkRateLimit(
        `temp-file-mint:${payload.organization.id}:${payload.currentMember.id}`,
        MINT_RATE_LIMIT_MAX,
        MINT_RATE_LIMIT_WINDOW_MS,
        now.getTime(),
      )
      if (retryAfterSeconds !== null) {
        return c.json({
          error: "rate_limited",
          message: "Too many temporary files were created recently. Try again shortly.",
          retryAfterSeconds,
        }, 429)
      }

      if (body.sizeBytes && body.sizeBytes > env.tempFiles.maxBytes) {
        return c.json({
          error: "file_too_large",
          message: `Temporary files are limited to ${env.tempFiles.maxBytes} bytes.`,
          maxBytes: env.tempFiles.maxBytes,
        }, 413)
      }

      // Expired rows for this organization are cleared on the way in, so a
      // deployment stays usable even if the sweeper is not running.
      await db.delete(TempFileTable).where(and(
        eq(TempFileTable.organization_id, payload.organization.id),
        lt(TempFileTable.expires_at, now),
      ))

      const [live] = await db
        .select({ value: count() })
        .from(TempFileTable)
        .where(and(
          eq(TempFileTable.organization_id, payload.organization.id),
          gt(TempFileTable.expires_at, now),
        ))
      if ((live?.value ?? 0) >= env.tempFiles.maxLivePerOrganization) {
        return c.json({
          error: "too_many_temporary_files",
          message: "This workspace already holds the maximum number of live temporary files. Wait for older files to expire.",
        }, 429)
      }

      const fileId = createDenTypeId("tempFile")
      const tokens = createTempFileTokenPair()
      const expiresAt = tempFileExpiresAt(now, env.tempFiles.ttlSeconds)

      await db.insert(TempFileTable).values({
        id: fileId,
        organization_id: payload.organization.id,
        created_by_user_id: payload.currentMember.userId,
        upload_token_hash: tokens.uploadTokenHash,
        download_token_hash: tokens.downloadTokenHash,
        filename: sanitizeTempFilename(body.filename),
        content_type: resolveTempFileContentType({ declared: body.contentType, filename: body.filename }),
        max_bytes: env.tempFiles.maxBytes,
        storage_tier: storage.tier,
        storage_key: storage.keyFor(fileId),
        status: "pending",
        expires_at: expiresAt,
      })

      const uploadUrl = tempFileContentUrl({ baseUrl, fileId, token: tokens.uploadToken })
      return c.json({
        fileId,
        uploadUrl,
        downloadUrl: tempFileContentUrl({ baseUrl, fileId, token: tokens.downloadToken }),
        expiresAt: expiresAt.toISOString(),
        maxBytes: env.tempFiles.maxBytes,
        storageTier: storage.tier,
        instructions: uploadInstructions(uploadUrl),
      })
    },
  )

  app.put(
    "/v1/temporary-files/:fileId/content",
    describeNonMcpRoute({
      tags: ["Direct uploads"],
      "x-mcp": false,
      summary: "Upload the bytes for a temporary file",
      description: "Accepts one raw PUT of the file bytes for a temporary file slot. The token from the upload URL authorizes the write; the bytes are never exposed to a model.",
      responses: {
        200: jsonResponse("The bytes were stored.", uploadResponseSchema),
        400: jsonResponse("The request body was empty.", temporaryFileErrorSchema),
        404: jsonResponse("No temporary file matches this id and token.", notFoundSchema),
        409: jsonResponse("This upload URL was already used.", temporaryFileErrorSchema),
        410: jsonResponse("The temporary file expired.", temporaryFileErrorSchema),
        413: jsonResponse("The body exceeded the configured maximum.", temporaryFileErrorSchema),
      },
    }),
    publicRoute,
    bodyLimit({
      maxSize: env.tempFiles.maxBytes + BODY_LIMIT_HEADROOM_BYTES,
      onError: (c) => c.json({
        error: "file_too_large",
        message: `Temporary files are limited to ${env.tempFiles.maxBytes} bytes.`,
        maxBytes: env.tempFiles.maxBytes,
      }, 413),
    }),
    async (c) => {
      const row = await loadTempFile(c.req.param("fileId"))
      if (!row || !verifyTempFileToken(c.req.query("token"), row.upload_token_hash)) {
        return c.json({ error: "not_found" }, 404)
      }

      const now = clock()
      if (row.expires_at <= now) {
        await discardTempFile(storage, row)
        return c.json({ error: "temporary_file_expired" }, 410)
      }
      if (row.status === "uploaded") {
        return c.json({
          error: "temporary_file_already_uploaded",
          message: "This upload URL was already used. Create a new temporary file.",
        }, 409)
      }

      const bytes = await c.req.arrayBuffer()
      if (bytes.byteLength < 1) {
        return c.json({ error: "empty_file", message: "Send the file bytes as the request body." }, 400)
      }
      if (bytes.byteLength > row.max_bytes) {
        return c.json({
          error: "file_too_large",
          message: `Temporary files are limited to ${row.max_bytes} bytes.`,
          maxBytes: row.max_bytes,
        }, 413)
      }

      await storage.put(row.storage_key, bytes)

      // The slot is claimed only after the bytes are committed, so an
      // interrupted transfer can be retried, while a completed upload can
      // never be swapped for different content after the download URL is
      // shared.
      const claimed = await db
        .update(TempFileTable)
        .set({
          status: "uploaded",
          size_bytes: bytes.byteLength,
          uploaded_at: now,
          content_type: resolveTempFileContentType({
            declared: row.content_type,
            filename: row.filename,
            uploaded: c.req.header("content-type"),
          }),
        })
        .where(and(
          eq(TempFileTable.id, row.id),
          eq(TempFileTable.status, "pending"),
          gt(TempFileTable.expires_at, now),
        ))

      if (claimed.rowsAffected === 0) {
        return c.json({
          error: "temporary_file_already_uploaded",
          message: "This upload URL was already used. Create a new temporary file.",
        }, 409)
      }

      return c.json({
        ok: true as const,
        fileId: row.id,
        sizeBytes: bytes.byteLength,
        expiresAt: row.expires_at.toISOString(),
      })
    },
  )

  app.get(
    "/v1/temporary-files/:fileId/content",
    describeNonMcpRoute({
      tags: ["Direct uploads"],
      "x-mcp": false,
      summary: "Download the bytes for a temporary file",
      description: "Serves the stored bytes to any client holding the download URL, so a tool that accepts a file URL can fetch them directly.",
      responses: {
        200: { description: "The stored file bytes." },
        404: jsonResponse("No temporary file matches this id and token.", notFoundSchema),
        409: jsonResponse("The bytes have not been uploaded yet.", temporaryFileErrorSchema),
        410: jsonResponse("The temporary file expired.", temporaryFileErrorSchema),
      },
    }),
    publicRoute,
    async (c) => {
      const row = await loadTempFile(c.req.param("fileId"))
      if (!row || !verifyTempFileToken(c.req.query("token"), row.download_token_hash)) {
        return c.json({ error: "not_found" }, 404)
      }

      if (row.expires_at <= clock()) {
        await discardTempFile(storage, row)
        return c.json({ error: "temporary_file_expired" }, 410)
      }
      if (row.status !== "uploaded") {
        return c.json({
          error: "temporary_file_not_uploaded",
          message: "The bytes for this temporary file have not been uploaded yet.",
        }, 409)
      }

      const bytes = await storage.read(row.storage_key)
      // A missing object means storage expired the bytes ahead of the row;
      // report it as expiry rather than as a lookup failure.
      if (!bytes) return c.json({ error: "temporary_file_expired" }, 410)

      c.header("Content-Type", row.content_type)
      c.header("Content-Length", String(bytes.byteLength))
      c.header("Content-Disposition", `attachment; filename="${sanitizeTempFilename(row.filename)}"`)
      c.header("X-Content-Type-Options", "nosniff")
      c.header("Cache-Control", "private, no-store")
      return c.body(bytes)
    },
  )
}

export const TEMPORARY_FILE_MINT_DESCRIPTION = MINT_DESCRIPTION
