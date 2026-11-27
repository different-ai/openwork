import { and, desc, eq, inArray, isNull } from "@openwork-ee/den-db/drizzle"
import { ConfigObjectTable, ConfigObjectVersionTable } from "@openwork-ee/den-db/schema"
import { typeId, type DenTypeId } from "@openwork-ee/utils/typeid"
import { mcpAppCompiledRevisionSchema } from "@openwork/types/mcp-app"
import type { Hono, MiddlewareHandler } from "hono"
import { describeRoute } from "hono-openapi"
import { z } from "zod"
import { INSUFFICIENT_SCOPE_CHALLENGE, requiresAdminError } from "../../agent-error-envelope.js"
import { db } from "../../db.js"
import { env } from "../../env.js"
import { requireFeature } from "../../features.js"
import { exportMcpAppStorageCsv, exportMcpAppStorageSqlite, McpAppStorageCsvLimitError, readMcpAppStorageSummary } from "../../mcp-app-storage/export.js"
import { orgMemberRoute, verifyOrgRole } from "../../middleware/index.js"
import { denTypeIdSchema, forbiddenSchema, jsonResponse, notFoundSchema, unauthorizedSchema } from "../../openapi.js"
import type { OrgRouteVariables } from "./shared.js"

const storageCollectionSchema = z.object({ name: z.string(), rows: z.number().int() }).meta({ ref: "ArtifactStorageCollection" })
const storageSummarySchema = z.object({
  appId: denTypeIdSchema("configObject"),
  title: z.string(),
  declared: z.boolean(),
  collections: z.array(storageCollectionSchema),
  rowCount: z.number().int(),
  sizeBytes: z.number().int(),
  updatedAt: z.iso.datetime().nullable(),
  maxRows: z.number().int(),
  maxBytes: z.number().int(),
}).meta({ ref: "ArtifactStorageSummaryResponse" })
const unavailableSchema = z.object({ error: z.literal("storage_unavailable") }).meta({ ref: "ArtifactStorageUnavailableError" })
const invalidExportSchema = z.object({ error: z.enum(["invalid_export_format", "invalid_collection"]), message: z.string() }).meta({ ref: "ArtifactStorageInvalidExportError" })
const tooLargeSchema = z.object({ error: z.literal("csv_export_too_large"), message: z.string() }).meta({ ref: "ArtifactStorageCsvTooLargeError" })

const commonResponses = {
  401: jsonResponse("The caller must be signed in.", unauthorizedSchema),
  403: jsonResponse("The caller must be an organization owner or admin.", forbiddenSchema),
  404: jsonResponse("The artifact is not in this organization, has been deleted, or artifact storage is disabled.", notFoundSchema),
  503: jsonResponse("Artifact storage is unavailable.", unavailableSchema),
}
const appIdParameter = { in: "path", name: "appId", required: true, description: "The artifact's configuration object ID.", schema: { type: "string" } } as const
const collectionName = z.string().regex(/^[a-z][a-z0-9_]{0,39}$/u)

async function loadArtifact(organizationId: DenTypeId<"organization">, appId: string) {
  const parsedId = typeId.schema("configObject").safeParse(appId)
  if (!parsedId.success) return null
  const [artifact] = await db.select({ id: ConfigObjectTable.id, title: ConfigObjectTable.title }).from(ConfigObjectTable).where(and(
    eq(ConfigObjectTable.id, parsedId.data), eq(ConfigObjectTable.organizationId, organizationId), eq(ConfigObjectTable.objectType, "app"),
    inArray(ConfigObjectTable.status, ["active", "archived"]), isNull(ConfigObjectTable.deletedAt),
  )).limit(1)
  if (!artifact) return null
  const [revision] = await db.select({ payload: ConfigObjectVersionTable.normalizedPayloadJson, deleted: ConfigObjectVersionTable.isDeletedVersion })
    .from(ConfigObjectVersionTable)
    .where(and(eq(ConfigObjectVersionTable.configObjectId, artifact.id), eq(ConfigObjectVersionTable.organizationId, organizationId)))
    .orderBy(desc(ConfigObjectVersionTable.createdAt), desc(ConfigObjectVersionTable.id)).limit(1)
  const compiled = revision && !revision.deleted ? mcpAppCompiledRevisionSchema.safeParse(revision.payload) : null
  return { ref: { organizationId, appId: artifact.id }, title: artifact.title, storage: compiled?.success ? compiled.data.storage : undefined }
}

function filenameSlug(title: string): string {
  return title.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 80).replace(/^-|-$/g, "") || "artifact"
}

const requireStorageAdmin: MiddlewareHandler<{ Variables: OrgRouteVariables }> = async (c, next) => {
  const context = c.get("organizationContext")
  if (!context) return c.json({ error: "organization_not_found" }, 404)
  if (!verifyOrgRole({ roles: ["admin"], userContext: context.currentMember })) {
    c.header("WWW-Authenticate", INSUFFICIENT_SCOPE_CHALLENGE)
    return c.json({
      error: "forbidden",
      ...requiresAdminError("Only workspace owners and admins can do this. Ask one of them, or have them change your role."),
    }, 403)
  }
  await next()
}

export function registerOrgMcpAppStorageRoutes<T extends { Variables: OrgRouteVariables }>(app: Hono<T>) {
  app.get(
    "/v1/mcp-apps/:appId/storage",
    describeRoute({
      tags: ["Artifacts"],
      summary: "Read an artifact's saved data summary",
      description: "Returns artifact storage usage and limits for an active or archived artifact. Counts include personal and shared rows; no row contents are returned.",
      parameters: [appIdParameter],
      responses: { ...commonResponses, 200: jsonResponse("The artifact's storage summary.", storageSummarySchema) },
    }),
    orgMemberRoute(),
    requireFeature("artifactStorage"),
    requireStorageAdmin,
    async (c) => {
      const context = c.get("organizationContext")
      if (!context) return c.json({ error: "organization_not_found" }, 404)
      const artifact = await loadArtifact(context.organization.id, c.req.param("appId"))
      if (!artifact) return c.json({ error: "artifact_not_found" }, 404)
      try {
        const summary = await readMcpAppStorageSummary(artifact.ref, artifact.storage)
        return c.json({
          appId: artifact.ref.appId,
          title: artifact.title,
          declared: artifact.storage !== undefined,
          ...(summary ?? { collections: artifact.storage?.collections.map(({ name }) => ({ name, rows: 0 })) ?? [], rowCount: 0, sizeBytes: 0, updatedAt: null }),
          maxRows: env.artifactStorage.maxRows,
          maxBytes: env.artifactStorage.maxBytes,
        }, 200, { "Cache-Control": "no-store" })
      } catch {
        return c.json({ error: "storage_unavailable" }, 503)
      }
    },
  )

  app.get(
    "/v1/mcp-apps/:appId/storage/export",
    describeRoute({
      tags: ["Artifacts"],
      summary: "Export an artifact's saved data",
      description: "Downloads the organization's saved data, including personal rows belonging to all members. SQLite includes the entire database. CSV downloads one declared collection or a former collection that still has rows.",
      parameters: [
        appIdParameter,
        { in: "query", name: "format", required: true, description: "The download format.", schema: { type: "string", enum: ["sqlite", "csv"] } },
        { in: "query", name: "collection", description: "The collection name, required for CSV.", schema: { type: "string" } },
      ],
      responses: {
        ...commonResponses,
        200: { description: "The downloadable file.", content: {
          "application/vnd.sqlite3": { schema: { type: "string", format: "binary" } },
          "text/csv": { schema: { type: "string" } },
        } },
        400: jsonResponse("Invalid format or collection.", invalidExportSchema),
        404: jsonResponse("The artifact is not accessible, storage is disabled, or there is no saved data.", notFoundSchema),
        413: jsonResponse("The collection is too large for CSV. Use the SQLite export.", tooLargeSchema),
      },
    }),
    orgMemberRoute(),
    requireFeature("artifactStorage"),
    requireStorageAdmin,
    async (c) => {
      const context = c.get("organizationContext")
      if (!context) return c.json({ error: "organization_not_found" }, 404)
      const artifact = await loadArtifact(context.organization.id, c.req.param("appId"))
      if (!artifact) return c.json({ error: "artifact_not_found" }, 404)
      const format = c.req.query("format")
      if (format !== "sqlite" && format !== "csv") return c.json({ error: "invalid_export_format", message: "Choose SQLite or CSV." }, 400)
      const slug = filenameSlug(artifact.title)
      const attachment = (filename: string, contentType: string) => ({
        "Content-Type": contentType,
        "Content-Disposition": `attachment; filename="${filename}"`,
        "Cache-Control": "no-store",
      })
      try {
        if (format === "sqlite") {
          const data = await exportMcpAppStorageSqlite(artifact.ref)
          if (!data) return c.json({ error: "no_saved_data" }, 404)
          return c.body(new Uint8Array(data), 200, attachment(`${slug}-${artifact.ref.appId}.sqlite`, "application/vnd.sqlite3"))
        }
        const collection = c.req.query("collection")
        if (!collection || !collectionName.safeParse(collection).success) {
          return c.json({ error: "invalid_collection", message: "Choose a collection to export as CSV." }, 400)
        }
        const declared = artifact.storage?.collections.find(({ name }) => name === collection)
        const summary = await readMcpAppStorageSummary(artifact.ref, artifact.storage)
        if (!summary) return c.json({ error: "no_saved_data" }, 404)
        if (!declared && !summary.collections.some(({ name }) => name === collection)) {
          return c.json({ error: "invalid_collection", message: "Choose a declared collection or one with saved rows." }, 400)
        }
        const fields = declared?.fields.map(({ name }) => name) ?? []
        const csv = await exportMcpAppStorageCsv(artifact.ref, { collection, fields })
        return c.body(csv, 200, attachment(`${slug}-${collection}.csv`, "text/csv; charset=utf-8"))
      } catch (error) {
        if (error instanceof McpAppStorageCsvLimitError) {
          return c.json({ error: "csv_export_too_large", message: "This collection is too large for CSV. Export SQLite instead." }, 413)
        }
        return c.json({ error: "storage_unavailable" }, 503)
      }
    },
  )
}
