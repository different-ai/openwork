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
  TEMP_FILE_DIGEST_ALGORITHM,
  TEMP_FILE_DIGEST_PATTERN,
  tempFileContentUrl,
  tempFileDigest,
  tempFileDigestValue,
  tempFileExpiresAt,
  tempFileUri,
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

// The digest, the file object, and the transfer descriptors below follow
// SEP-2631, the open MCP proposal for file objects and transfer. Nothing in the
// ratified specification carries a file between a client and a server without
// base64, so this route cannot be conformant to anything today; matching the
// proposal's names means that if it lands, the adapter is a rename rather than
// a redesign.
const digestSchema = z.object({
  algorithm: z.literal(TEMP_FILE_DIGEST_ALGORITHM)
    .describe("Digest algorithm. Only sha-256 is supported."),
  value: z.string().regex(TEMP_FILE_DIGEST_PATTERN)
    .describe("Base64url SHA-256 of the file bytes, without padding."),
}).meta({ ref: "TemporaryFileDigest" })

const mintTemporaryFileSchema = z.object({
  filename: z.string().trim().min(1).max(255)
    .describe("Base filename with extension, for example report.pdf. Used as the served filename."),
  contentType: z.string().trim().max(255).optional()
    .describe("MIME type of the bytes you will upload, for example application/pdf. Defaults to application/octet-stream."),
  sizeBytes: z.number().int().positive().optional()
    .describe("Byte size of the file you will upload, from ls -l or stat. Supplying it fails fast instead of failing mid-upload."),
  digest: digestSchema.optional()
    .describe("Optional integrity digest of the bytes you will upload. When supplied, an upload whose bytes hash to anything else is rejected and the slot stays empty. Produce it with: openssl dgst -sha256 -binary <path> | basenc --base64url | tr -d '='."),
}).meta({ ref: "TemporaryFileMintRequest" })

// The file handle: a stable identity for the file, separate from the URLs that
// move its bytes.
const fileValueSchema = z.object({
  uri: z.string(),
  name: z.string(),
  mimeType: z.string(),
  size: z.number().optional(),
  digest: digestSchema.optional(),
}).meta({ ref: "TemporaryFileValue" })

// How to move the bytes: one descriptor per direction. `transport` names the
// transfer mechanism rather than the URL scheme — an ordinary HTTP request
// against `url` — so it stays "https" even where a development deployment
// serves the URL over plain http.
const transferSchema = z.object({
  transport: z.literal("https"),
  method: z.string(),
  url: z.string(),
  expiresAt: z.string(),
}).meta({ ref: "TemporaryFileTransfer" })

const mintResponseSchema = z.object({
  fileId: z.string(),
  uploadUrl: z.string(),
  downloadUrl: z.string(),
  expiresAt: z.string(),
  maxSize: z.number(),
  storageTier: z.enum(["volume", "s3"]),
  instructions: z.string(),
  file: fileValueSchema,
  upload: transferSchema,
  download: transferSchema,
}).meta({ ref: "TemporaryFileMintResponse" })

const uploadResponseSchema = z.object({
  ok: z.literal(true),
  fileId: z.string(),
  uri: z.string(),
  sizeBytes: z.number(),
  expiresAt: z.string(),
  digest: digestSchema,
}).meta({ ref: "TemporaryFileUploadResponse" })

// `error` is this API's own machine-readable code; `reason` carries the
// SEP-2631 vocabulary alongside it, so a future file-transfer adapter can pass
// the payload through untouched.
const temporaryFileErrorSchema = z.object({
  error: z.string(),
  reason: z.string().optional(),
  message: z.string().optional(),
  maxSize: z.number().optional(),
  actualSize: z.number().optional(),
  expectedDigest: digestSchema.optional(),
  actualDigest: digestSchema.optional(),
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
  "The uploadUrl accepts exactly one PUT of at most maxSize bytes, and both URLs stop working at expiresAt.",
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
          reason: "rateLimited",
          message: "Too many temporary files were created recently. Try again shortly.",
          retryAfterSeconds,
        }, 429)
      }

      if (body.sizeBytes && body.sizeBytes > env.tempFiles.maxBytes) {
        return c.json({
          error: "file_too_large",
          reason: "maxSizeExceeded",
          message: `Temporary files are limited to ${env.tempFiles.maxBytes} bytes.`,
          maxSize: env.tempFiles.maxBytes,
          actualSize: body.sizeBytes,
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
          reason: "tooManyFiles",
          message: "This workspace already holds the maximum number of live temporary files. Wait for older files to expire.",
        }, 429)
      }

      const fileId = createDenTypeId("tempFile")
      const tokens = createTempFileTokenPair()
      const expiresAt = tempFileExpiresAt(now, env.tempFiles.ttlSeconds)
      const filename = sanitizeTempFilename(body.filename)
      const contentType = resolveTempFileContentType({ declared: body.contentType, filename: body.filename })

      await db.insert(TempFileTable).values({
        id: fileId,
        organization_id: payload.organization.id,
        created_by_user_id: payload.currentMember.userId,
        upload_token_hash: tokens.uploadTokenHash,
        download_token_hash: tokens.downloadTokenHash,
        filename,
        content_type: contentType,
        max_bytes: env.tempFiles.maxBytes,
        storage_tier: storage.tier,
        storage_key: storage.keyFor(fileId),
        status: "pending",
        expected_sha256: body.digest?.value ?? null,
        expires_at: expiresAt,
      })

      const uploadUrl = tempFileContentUrl({ baseUrl, fileId, token: tokens.uploadToken })
      const downloadUrl = tempFileContentUrl({ baseUrl, fileId, token: tokens.downloadToken })
      const expiresAtIso = expiresAt.toISOString()
      return c.json({
        // Flat fields first: this is the shape agents reach for today, and the
        // one most file-hosting APIs already use.
        fileId,
        uploadUrl,
        downloadUrl,
        expiresAt: expiresAtIso,
        maxSize: env.tempFiles.maxBytes,
        storageTier: storage.tier,
        instructions: uploadInstructions(uploadUrl),
        // The same slot in the SEP-2631 shape, for a caller that already
        // speaks it.
        file: {
          uri: tempFileUri(fileId),
          name: filename,
          mimeType: contentType,
          ...(body.sizeBytes ? { size: body.sizeBytes } : {}),
          ...(body.digest ? { digest: body.digest } : {}),
        },
        upload: { transport: "https" as const, method: "PUT", url: uploadUrl, expiresAt: expiresAtIso },
        download: { transport: "https" as const, method: "GET", url: downloadUrl, expiresAt: expiresAtIso },
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
        422: jsonResponse("The bytes did not match the declared digest.", temporaryFileErrorSchema),
      },
    }),
    publicRoute,
    bodyLimit({
      maxSize: env.tempFiles.maxBytes + BODY_LIMIT_HEADROOM_BYTES,
      onError: (c) => c.json({
        error: "file_too_large",
        reason: "maxSizeExceeded",
        message: `Temporary files are limited to ${env.tempFiles.maxBytes} bytes.`,
        maxSize: env.tempFiles.maxBytes,
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
        return c.json({ error: "temporary_file_expired", reason: "expired" }, 410)
      }
      if (row.status === "uploaded") {
        return c.json({
          error: "temporary_file_already_uploaded",
          reason: "alreadyUploaded",
          message: "This upload URL was already used. Create a new temporary file.",
        }, 409)
      }

      const bytes = await c.req.arrayBuffer()
      if (bytes.byteLength < 1) {
        return c.json({
          error: "empty_file",
          reason: "emptyBody",
          message: "Send the file bytes as the request body.",
        }, 400)
      }
      if (bytes.byteLength > row.max_bytes) {
        return c.json({
          error: "file_too_large",
          reason: "maxSizeExceeded",
          message: `Temporary files are limited to ${row.max_bytes} bytes.`,
          maxSize: row.max_bytes,
          actualSize: bytes.byteLength,
        }, 413)
      }

      // Verified before the bytes are stored, so a mismatched upload leaves the
      // slot empty and retryable rather than holding content the caller did not
      // intend to publish.
      const digest = tempFileDigest(bytes)
      if (row.expected_sha256 && row.expected_sha256 !== digest) {
        return c.json({
          error: "digest_mismatch",
          reason: "digestMismatch",
          message: "The uploaded bytes do not match the digest declared when this file was created. The slot is unchanged; retry the upload.",
          expectedDigest: tempFileDigestValue(row.expected_sha256),
          actualDigest: tempFileDigestValue(digest),
        }, 422)
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
          content_sha256: digest,
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
          reason: "alreadyUploaded",
          message: "This upload URL was already used. Create a new temporary file.",
        }, 409)
      }

      return c.json({
        ok: true as const,
        fileId: row.id,
        uri: tempFileUri(row.id),
        sizeBytes: bytes.byteLength,
        expiresAt: row.expires_at.toISOString(),
        digest: tempFileDigestValue(digest),
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
        return c.json({ error: "temporary_file_expired", reason: "expired" }, 410)
      }
      if (row.status !== "uploaded") {
        return c.json({
          error: "temporary_file_not_uploaded",
          reason: "notUploaded",
          message: "The bytes for this temporary file have not been uploaded yet.",
        }, 409)
      }

      const bytes = await storage.read(row.storage_key)
      // A missing object means storage expired the bytes ahead of the row;
      // report it as expiry rather than as a lookup failure.
      if (!bytes) return c.json({ error: "temporary_file_expired", reason: "expired" }, 410)

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
