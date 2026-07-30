import type { Hono } from "hono"
import { bodyLimit } from "hono/body-limit"
import { describeRoute } from "hono-openapi"
import { z } from "zod"
import {
  databaseFileReferenceStorage,
  FILE_REFERENCE_MAX_BYTES,
  type FileReferenceStorage,
} from "../../file-references.js"
import { jsonResponse, notFoundSchema, unauthorizedSchema } from "../../openapi.js"
import { orgMemberRoute } from "../../middleware/index.js"
import type { OrgRouteVariables } from "./shared.js"

const fileReferenceResponseSchema = z.object({
  fileRef: z.string(),
  filename: z.string(),
  mimeType: z.string(),
  byteLength: z.number().int().positive(),
  sha256: z.string(),
  expiresAt: z.string(),
}).meta({ ref: "FileReferenceResponse" })

function safeFilename(value: string) {
  const basename = value.replaceAll("\\", "/").split("/").pop()?.trim() ?? ""
  const safe = basename.replace(/[\u0000-\u001f\u007f<>:"|?*]/g, "_").trim()
  return safe && safe !== "." && safe !== ".." ? safe.slice(0, 255) : "attachment.bin"
}

function safeMimeType(value: string) {
  const normalized = value.trim().toLowerCase()
  return /^[!#$%&'*+.^_`|~0-9a-z-]+\/[!#$%&'*+.^_`|~0-9a-z-]+$/.test(normalized)
    ? normalized.slice(0, 255)
    : "application/octet-stream"
}

export function registerFileReferenceRoutes<T extends { Variables: OrgRouteVariables }>(
  app: Hono<T>,
  options: { storage?: FileReferenceStorage } = {},
) {
  const storage = options.storage ?? databaseFileReferenceStorage

  app.post(
    "/v1/file-references",
    describeRoute({
      tags: ["File References"],
      summary: "Stage file bytes outside model context",
      description: "Stores a short-lived, member-scoped file for later capability upload. This transport endpoint is called by the trusted OpenWork server, not by an agent tool call.",
      responses: {
        200: jsonResponse("File staged.", fileReferenceResponseSchema),
        401: jsonResponse("The caller must be signed in.", unauthorizedSchema),
      },
    }),
    orgMemberRoute(),
    bodyLimit({
      maxSize: FILE_REFERENCE_MAX_BYTES + 256 * 1024,
      onError: (c) => c.json({
        error: "file_too_large",
        message: `Files must be ${FILE_REFERENCE_MAX_BYTES} bytes or less.`,
      }, 413),
    }),
    async (c) => {
      if (!c.req.header("content-type")?.toLowerCase().startsWith("multipart/form-data")) {
        return c.json({ error: "invalid_request", message: "Upload the file as multipart form data." }, 400)
      }
      const body = await c.req.parseBody()
      const file = body.file instanceof File ? body.file : null
      if (!file) return c.json({ error: "file_required", message: "Form field 'file' is required." }, 400)
      if (file.size < 1 || file.size > FILE_REFERENCE_MAX_BYTES) {
        return c.json({
          error: "file_too_large",
          message: `Files must contain between 1 and ${FILE_REFERENCE_MAX_BYTES} bytes.`,
        }, 413)
      }
      const payload = c.get("organizationContext")
      const stored = await storage.put({
        organizationId: payload.organization.id,
        orgMembershipId: payload.currentMember.id,
        filename: safeFilename(typeof body.filename === "string" ? body.filename : file.name),
        mimeType: safeMimeType(typeof body.mimeType === "string" ? body.mimeType : file.type),
        bytes: new Uint8Array(await file.arrayBuffer()),
      })
      return c.json({
        fileRef: stored.fileRef,
        filename: stored.filename,
        mimeType: stored.mimeType,
        byteLength: stored.byteLength,
        sha256: stored.sha256,
        expiresAt: stored.expiresAt.toISOString(),
      })
    },
  )

  app.get(
    "/v1/file-references/:fileRef/content",
    describeRoute({
      tags: ["File References"],
      summary: "Materialize a staged file outside model context",
      description: "Streams a member-scoped staged file to the trusted OpenWork server. File bytes are never returned as an MCP tool result.",
      responses: {
        200: { description: "Staged file bytes." },
        401: jsonResponse("The caller must be signed in.", unauthorizedSchema),
        404: jsonResponse("The file reference is missing, expired, or belongs to another member.", notFoundSchema),
      },
    }),
    orgMemberRoute(),
    async (c) => {
      const payload = c.get("organizationContext")
      const stored = await storage.read({
        organizationId: payload.organization.id,
        orgMembershipId: payload.currentMember.id,
        fileRef: c.req.param("fileRef"),
      })
      if (!stored) return c.json({ error: "not_found" }, 404)
      c.header("Content-Type", stored.mimeType)
      c.header("Content-Length", String(stored.byteLength))
      c.header("X-OpenWork-Filename", encodeURIComponent(stored.filename))
      c.header("X-OpenWork-Sha256", stored.sha256)
      c.header("Cache-Control", "private, no-store")
      c.header("X-Content-Type-Options", "nosniff")
      const body = stored.bytes.buffer.slice(
        stored.bytes.byteOffset,
        stored.bytes.byteOffset + stored.bytes.byteLength,
      ) as ArrayBuffer
      return c.body(body)
    },
  )
}
