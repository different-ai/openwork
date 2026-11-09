/**
 * `plugins.skills`: config objects (skills, agents, commands, tools, MCP
 * definitions, hooks, context, custom objects and imported Apps) of
 * Plugins › Skills…, one item per object, with its LATEST version.
 *
 * Exported per object: type, title (the item name), whether it is archived,
 * its content (raw source text, normalized payload and schema version of the
 * latest version) and who can use it, by role (everyone, teams, people by
 * email). Content is encrypted at rest because it is confidential, not
 * because it is a credential: it IS exported (decision D1), so the area is
 * marked `containsConfidentialContent`. Nothing here is a secret.
 *
 * Informational only (exported for readers, never written, never a diff):
 * description and title (derived from the content by the store), the source
 * path, how the object was created (`origin`), `managedBy` and `source`, and
 * an MCP App's remote install (`remoteApp`).
 *
 * Which objects: org-shared ones only (see plugins-support.ts). Personal
 * objects (only their creator can reach them), Workflows / scripts and
 * authored MCP Apps are not part of this area and an import never touches
 * them.
 *
 * Source-managed objects (`managedBy: "source"`, synced from a GitHub source
 * in Plugins › Sources) are exported so plugins can reference them, but their
 * content belongs to the source: an import refuses to create them or change
 * their content or lifecycle (the item fails with `source_managed`; skip it,
 * the source sync brings it back), and never deletes them. Their access
 * grants are admin-set and can be changed.
 *
 * Apply goes through the plugin-system store, as the config-object routes do:
 * `createConfigObject`, `createConfigObjectVersion` (an update with changed
 * content adds exactly one new immutable version; title and description are
 * re-derived from it), `setConfigObjectLifecycle` and the access-grant calls.
 */
import { and, eq, inArray } from "@openwork-ee/den-db/drizzle"
import { ConnectorInstanceTable, RemoteMcpAppTable, configObjectTypeValues } from "@openwork-ee/den-db/schema"
import { denTypeIdPrefixes, normalizeDenTypeId } from "@openwork-ee/utils/typeid"
import { isAuthoredMcpAppVersion } from "@openwork/types/mcp-app"
import { z } from "zod"
import { latestConfigObjectVersions } from "../../config-object-versions.js"
import { requirePluginArchCapability } from "../../routes/org/plugin-system/access.js"
import { createConfigObject, createConfigObjectVersion, setConfigObjectLifecycle } from "../../routes/org/plugin-system/store.js"
import { ConfigApplyItemError, defineConfigArea, type ConfigAreaContext, type ConfigItem } from "../area.js"
import {
  accessByRoleSchema,
  accessSpec,
  applyAccess,
  jsonOverlap,
  loadAudienceNames,
  loadConfigObjects,
  loadGrants,
  loadSharedPlugins,
  nameSimilarity,
  normalizeText,
  parseSpec,
  pluginArchActor,
  sharedConfigObjectIds,
  textOverlap,
} from "./plugins-support.js"
import { ConfigApplyError, applyWithSteps, isJsonObject, specObject, touches } from "./route-support.js"

const AREA = "plugins.skills"

const contentSchema = z.object({
  /** The source file as written (SKILL.md for skills). */
  rawSourceText: z.string().max(4 * 1024 * 1024).nullable().default(null),
  /** The normalized payload the desktop reads. */
  payload: z.record(z.string(), z.unknown()).nullable().default(null),
  schemaVersion: z.string().trim().min(1).max(100).nullable().default(null),
}).strict()

const specSchema = z.object({
  type: z.enum(configObjectTypeValues),
  archived: z.boolean().default(false),
  content: contentSchema,
  access: accessByRoleSchema.default({ orgWide: null, teams: { viewer: [], editor: [], manager: [] }, members: { viewer: [], editor: [], manager: [] } }),
  // Informational (see informationalFields).
  description: z.string().max(65535).nullable().default(null),
  sourcePath: z.string().max(255).nullable().default(null),
  origin: z.enum(["cloud", "import", "connector"]).default("cloud"),
  managedBy: z.enum(["manual", "source"]).default("manual"),
  /** Name of the source (Plugins › Sources) a source-managed object comes from. */
  source: z.string().max(255).nullable().default(null),
  remoteApp: z.object({ sourceUrl: z.string().max(2048), status: z.enum(["active", "retired"]) }).strict().nullable().default(null),
}).strict()

const applySpecSchema = z.object({
  type: z.enum(configObjectTypeValues),
  archived: z.boolean().default(false),
  content: contentSchema,
  origin: z.enum(["cloud", "import", "connector"]).default("cloud"),
  managedBy: z.enum(["manual", "source"]).default("manual"),
  source: z.string().nullable().default(null),
  sourcePath: z.string().nullable().default(null),
  description: z.string().nullable().default(null),
  remoteApp: z.unknown().optional(),
}).passthrough()

type Row = Awaited<ReturnType<typeof loadConfigObjects>>[number]

function contentOf(spec: ConfigItem["spec"]): { rawSourceText: string | null; payload: unknown } {
  const content = isJsonObject(spec.content) ? spec.content : {}
  return {
    rawSourceText: typeof content.rawSourceText === "string" ? content.rawSourceText : null,
    payload: content.payload ?? null,
  }
}

async function readSkills(ctx: ConfigAreaContext, ids: readonly string[] | null): Promise<ConfigItem[]> {
  const organizationId = normalizeDenTypeId("organization", ctx.organizationId)
  let rows: Row[] = await loadConfigObjects(ctx.db, organizationId, ids)
  if (rows.length === 0) return []
  const latest = await latestConfigObjectVersions(rows.map((row) => row.id), organizationId)
  // Authored MCP Apps are compiled through create_app / update_app, never through this area.
  rows = rows.filter((row) => {
    const version = latest.get(row.id)
    return !(row.objectType === "app" && version && isAuthoredMcpAppVersion(version))
  })
  if (ids === null) {
    const { shared } = await loadSharedPlugins(ctx.db, organizationId)
    const sharedIds = await sharedConfigObjectIds({ db: ctx.db, organizationId, objects: rows, sharedPluginIds: shared.ids })
    rows = rows.filter((row) => sharedIds.has(row.id))
  }
  if (rows.length === 0) return []
  const objectIds = rows.map((row) => row.id)
  const instanceIds = [...new Set(rows.flatMap((row) => row.connectorInstanceId ? [row.connectorInstanceId] : []))]
  const [grants, instances, remoteApps] = await Promise.all([
    loadGrants(ctx.db, "config_object", organizationId, objectIds),
    instanceIds.length === 0 ? [] : ctx.db.select({ id: ConnectorInstanceTable.id, name: ConnectorInstanceTable.name })
      .from(ConnectorInstanceTable)
      .where(and(eq(ConnectorInstanceTable.organizationId, organizationId), inArray(ConnectorInstanceTable.id, instanceIds))),
    ctx.db.select().from(RemoteMcpAppTable).where(and(eq(RemoteMcpAppTable.organizationId, organizationId), inArray(RemoteMcpAppTable.configObjectId, objectIds))),
  ])
  const names = await loadAudienceNames(ctx.db, organizationId, grants)
  const instanceNames = new Map(instances.map((instance) => [instance.id, instance.name]))
  const remoteByObject = new Map(remoteApps.map((app) => [app.configObjectId, app]))

  const items = rows.map((row): ConfigItem => {
    const version = latest.get(row.id)
    const remote = remoteByObject.get(row.id)
    const sourceManaged = row.sourceMode === "connector" || row.connectorInstanceId !== null
    return {
      id: row.id,
      key: null,
      name: row.title,
      spec: {
        type: row.objectType,
        archived: row.status === "archived",
        content: {
          rawSourceText: version?.rawSourceText ?? null,
          payload: version?.normalizedPayloadJson ?? null,
          schemaVersion: version?.schemaVersion ?? null,
        },
        access: accessSpec(grants.filter((grant) => grant.resourceId === row.id), names),
        description: row.description ?? null,
        sourcePath: row.currentRelativePath ?? null,
        origin: row.sourceMode,
        managedBy: sourceManaged ? "source" : "manual",
        source: row.connectorInstanceId ? instanceNames.get(row.connectorInstanceId) ?? null : null,
        remoteApp: remote ? { sourceUrl: remote.sourceUrl, status: remote.status } : null,
      },
    }
  })
  return items.sort((left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id))
}

function sourceManagedFailure(name: string, source: string | null, field: string): ConfigApplyItemError {
  const from = source ? `the source "${source}"` : "its source"
  return new ConfigApplyItemError({
    code: "source_managed",
    message: `"${name}" comes from ${from} (Plugins › Sources): its content is changed in the repository and synced, not imported. Skip this item; the source sync brings it back.`,
    field,
    status: 409,
  })
}

export const pluginsSkillsArea = defineConfigArea({
  key: AREA,
  label: "Skills, agents and commands",
  path: ["Plugins", "Skills"],
  idPrefix: denTypeIdPrefixes.configObject,
  specVersion: 1,
  specSchema,
  dependsOn: ["members.teams", "members.people"],
  deployments: ["cloud", "self_hosted"],
  // Exports every org-shared object whoever it is shared with: the "manage everything shared" view.
  viewPermission: "sharing.manage_all",
  managePermission: "sharing.manage_all",
  tables: ["config_object", "config_object_version", "config_object_access_grant", "remote_mcp_app"],
  naturalKeys: [{
    // Source-managed objects are identified by the source and file they come from.
    label: "source file",
    get: (item) => item.spec.managedBy === "source" && typeof item.spec.source === "string" && typeof item.spec.sourcePath === "string"
      ? `${normalizeText(item.spec.source)}\n${item.spec.sourcePath}`
      : null,
  }],
  similarity: (blob, target) => {
    if (blob.spec.type !== target.spec.type) return { score: 0, reasons: ["different type"] }
    const reasons = [`same type (${String(blob.spec.type)})`]
    const name = nameSimilarity(blob.name, target.name)
    if (name === 1) reasons.push("same title")
    else if (name > 0) reasons.push(`similar title (${Math.round(name * 100)}%)`)
    const left = contentOf(blob.spec)
    const right = contentOf(target.spec)
    const content = Math.max(textOverlap(left.rawSourceText, right.rawSourceText), jsonOverlap(left.payload, right.payload))
    if (content === 1) reasons.push("same content")
    else if (content > 0) reasons.push(`${Math.round(content * 100)}% of the content equal`)
    return { score: Math.min(1, 0.35 * name + 0.65 * content), reasons }
  },
  secretFields: [],
  containsConfidentialContent: true,
  informationalFields: ["description", "sourcePath", "origin", "managedBy", "source", "remoteApp"],
  // The title is derived from the content (SKILL.md name, metadata title): never set by an import.
  informationalName: true,
  // Store calls run on the global db (and re-sync plugin MCP access).
  transactional: false,
  protectedFromDelete: (item) => item.spec.managedBy === "source"
    ? `"${item.name}" comes from ${typeof item.spec.source === "string" ? `the source "${item.spec.source}"` : "a source"}; remove it from the repository instead.`
    : null,

  irreversible: (op) => {
    if (op.kind === "update" && touches(op.changes, "content")) {
      return [`A new version of "${op.previous.name}" is saved; reverting adds another version, the history keeps this one.`]
    }
    return []
  },

  async exportItems(ctx) {
    return readSkills(ctx, null)
  },

  async readItems(ctx, ids) {
    return readSkills(ctx, ids)
  },

  async apply(ctx, op) {
    return applyWithSteps(async (log) => {
      const actor = await pluginArchActor(ctx)
      const warnings: string[] = []

      if (op.kind === "delete") {
        if (op.previous.spec.managedBy === "source") throw sourceManagedFailure(op.previous.name, typeof op.previous.spec.source === "string" ? op.previous.spec.source : null, "managedBy")
        await log.run({ action: "delete", target: "object", detail: op.previous.name }, () =>
          setConfigObjectLifecycle({ context: actor, configObjectId: normalizeDenTypeId("configObject", op.targetId), action: "delete" }))
        return { localId: op.targetId }
      }

      const raw = specObject(op.item.spec)
      const spec = parseSpec(applySpecSchema, raw)
      const value = {
        ...(spec.content.rawSourceText !== null ? { rawSourceText: spec.content.rawSourceText } : {}),
        ...(spec.content.payload !== null ? { normalizedPayloadJson: spec.content.payload } : {}),
        ...(spec.content.schemaVersion !== null ? { schemaVersion: spec.content.schemaVersion } : {}),
        // Titles of non-skill objects are derived from metadata first: keep the exported title.
        metadata: { title: op.item.name, ...(spec.description ? { description: spec.description } : {}) },
      }
      if (spec.content.rawSourceText === null && spec.content.payload === null) {
        throw new ConfigApplyError("invalid_spec", "content needs rawSourceText or payload.", 400, "content")
      }

      if (op.kind === "create") {
        if (spec.managedBy === "source") throw sourceManagedFailure(op.item.name, spec.source, "managedBy")
        await requirePluginArchCapability(actor, "config_object.create")
        const created = await log.run({ action: "create", target: "object", detail: `${spec.type} "${op.item.name}"` }, () => createConfigObject({
          context: actor,
          ...(op.preferredId ? { id: normalizeDenTypeId("configObject", op.preferredId) } : {}),
          objectType: spec.type,
          sourceMode: spec.origin === "import" ? "import" : "cloud",
          sourcePath: spec.sourcePath,
          value,
        }), "content")
        const localId = created.id
        if (spec.remoteApp) warnings.push(`"${op.item.name}" was installed from a remote MCP App URL on the source; install it again here to keep it updated.`)
        await applyAccess({ ctx, actor, kind: "config_object", resourceId: localId, access: raw.access, log, warnings })
        if (spec.archived) {
          await log.run({ action: "set", target: "archived", detail: "true" }, () =>
            setConfigObjectLifecycle({ context: actor, configObjectId: normalizeDenTypeId("configObject", localId), action: "archive" }))
        }
        return { localId, warnings }
      }

      // update: only what the plan changes.
      const configObjectId = normalizeDenTypeId("configObject", op.targetId)
      const [row] = await loadConfigObjects(ctx.db, ctx.organizationId, [configObjectId])
      if (!row) throw new ConfigApplyError("config_object_not_found", `"${op.previous.name}" no longer exists.`, 404)
      const sourceManaged = row.sourceMode === "connector" || row.connectorInstanceId !== null
      if (touches(op.changes, "type") && row.objectType !== spec.type) {
        throw new ConfigApplyError("type_changed", `"${row.title}" is a ${row.objectType}; an import can't turn it into a ${spec.type}. Create a new item instead.`, 409, "type")
      }
      const contentChanged = touches(op.changes, "content")
      const lifecycleChanged = touches(op.changes, "archived") && (row.status === "archived") !== spec.archived
      if (sourceManaged && (contentChanged || lifecycleChanged)) {
        const [instance] = row.connectorInstanceId
          ? await ctx.db.select({ name: ConnectorInstanceTable.name }).from(ConnectorInstanceTable).where(eq(ConnectorInstanceTable.id, row.connectorInstanceId)).limit(1)
          : []
        throw sourceManagedFailure(row.title, instance?.name ?? null, contentChanged ? "content" : "archived")
      }
      if (contentChanged) {
        await log.run({ action: "create", target: "content", detail: "new version" }, () =>
          createConfigObjectVersion({ context: actor, configObjectId, value }), "content")
      }
      if (lifecycleChanged) {
        await log.run({ action: "set", target: "archived", detail: String(spec.archived) }, () =>
          setConfigObjectLifecycle({ context: actor, configObjectId, action: spec.archived ? "archive" : "restore" }))
      }
      if (touches(op.changes, "access")) {
        await applyAccess({ ctx, actor, kind: "config_object", resourceId: configObjectId, access: raw.access, log, warnings })
      }
      return { localId: configObjectId, warnings }
    })
  },
})
