/**
 * `plugins.plugins`: plugins (Plugins › Plugins), what they contain, who can
 * use them, which collections list them and which MCP connection serves each
 * MCP server they declare.
 *
 * Exported per plugin: description, whether it is archived, its components
 * (`{ $ref: "plugins.skills/<id>" }`), access by role (everyone, teams,
 * people by email), its collections (`{ $ref:
 * "settings.advanced.collections/<id>" }`; this area owns
 * `marketplace_plugin`) and its MCP requirement bindings (component + server
 * name → `{ $ref: "connectors.mcp/<id>" }`). Nothing here is secret: the
 * connections' credentials stay with `connectors.mcp`.
 *
 * Informational only: the GitHub repository / format it was imported from,
 * `managedBy: "source"` when a source in Plugins › Sources maps into it, and
 * `builtIn` for the plugins the OpenWork Marketplace seeds into every
 * organization (matched by name, never deleted by an import).
 *
 * Which plugins: org-shared ones (see plugins-support.ts); personal plugins
 * (only their creator can reach them, e.g. each member's "Workflows") are not
 * exported and never touched. Components a source syncs into a plugin
 * (`membership_source = connector`) are left out: the source owns them, so a
 * source-managed plugin is exported as its shell (description, access,
 * collections, bindings) and the sync fills it.
 *
 * Applies through the plugin-system store, as the plugin routes do:
 * `createPlugin`, `updatePlugin`, `setPluginLifecycle`,
 * `attachConfigObjectToPlugin` / `removeConfigObjectFromPlugin`,
 * `attachPluginToMarketplace` / `removePluginFromMarketplace`, the access-grant
 * calls, and the binding upsert + access re-sync the plugin bundle route uses.
 * A delete archives the plugin (the dashboard has no hard delete).
 */
import { and, eq, inArray, isNull, ne } from "@openwork-ee/den-db/drizzle"
import {
  ConfigObjectTable,
  ExternalMcpConnectionTable,
  MarketplacePluginTable,
  MarketplaceTable,
  PluginConfigObjectTable,
  PluginMcpRequirementBindingTable,
  externalMcpAuthTypeValues,
} from "@openwork-ee/den-db/schema"
import { denTypeIdPrefixes, normalizeDenTypeId } from "@openwork-ee/utils/typeid"
import { isAuthoredMcpAppVersion } from "@openwork/types/mcp-app"
import { z } from "zod"
import { latestConfigObjectVersions } from "../../config-object-versions.js"
import { deletePluginMcpRequirementBindingsByIds, upsertPluginMcpRequirementBinding } from "../../mcp/plugin-mcp-requirement-bindings.js"
import { pluginArchHasPermission, requirePluginArchCapability, type PluginArchActorContext } from "../../routes/org/plugin-system/access.js"
import {
  attachConfigObjectToPlugin,
  attachPluginToMarketplace,
  createPlugin,
  removeConfigObjectFromPlugin,
  removePluginFromMarketplace,
  setPluginLifecycle,
  syncPluginMcpRequirementBindingAccess,
  updatePlugin,
} from "../../routes/org/plugin-system/store.js"
import { defineConfigArea, type ConfigAreaContext, type ConfigItem } from "../area.js"
import {
  accessByRoleSchema,
  accessSpec,
  applyAccess,
  exportedRefIds,
  jaccard,
  loadAudienceNames,
  loadGrants,
  loadSharedPlugins,
  nameSimilarity,
  normalizeText,
  parseSpec,
  pluginArchActor,
  resolvedRefId,
  textOverlap,
} from "./plugins-support.js"
import {
  ConfigApplyError,
  applyWithSteps,
  isJsonObject,
  resolvedRefIds,
  specObject,
  specRefSchema,
  touches,
  type ConfigStepLog,
  type JsonObject,
} from "./route-support.js"

const AREA = "plugins.plugins"

const mcpConnectionSchema = z.object({
  /** The MCP component (a `plugins.skills` item of type mcp) declaring the server. */
  component: specRefSchema,
  serverName: z.string().trim().min(1).max(255),
  connection: specRefSchema,
  requiredAuthType: z.enum(externalMcpAuthTypeValues).nullable().default(null),
  /** The connection was created for this plugin and is removed with it. */
  ownedByPlugin: z.boolean().default(false),
}).strict()

const emptyAccess = { orgWide: null, teams: { viewer: [], editor: [], manager: [] }, members: { viewer: [], editor: [], manager: [] } }

const specSchema = z.object({
  description: z.string().max(65535).nullable().default(null),
  archived: z.boolean().default(false),
  components: z.array(specRefSchema).max(1000).default([]),
  access: accessByRoleSchema.default(emptyAccess),
  collections: z.array(specRefSchema).max(500).default([]),
  mcpConnections: z.array(mcpConnectionSchema).max(500).default([]),
  // Informational (see informationalFields).
  sourceRepositoryUrl: z.string().max(1024).nullable().default(null),
  sourceFormat: z.string().max(64).nullable().default(null),
  managedBy: z.enum(["manual", "source"]).default("manual"),
  builtIn: z.boolean().default(false),
}).strict()

const applySpecSchema = z.object({
  description: z.string().nullable().default(null),
  archived: z.boolean().default(false),
  sourceRepositoryUrl: z.string().nullable().default(null),
  sourceFormat: z.string().nullable().default(null),
}).passthrough()

type Binding = { componentId: string; serverName: string; connectionId: string; requiredAuthType: (typeof externalMcpAuthTypeValues)[number] | null; ownedByPlugin: boolean; label: string }

function bindingKey(componentId: string, serverName: string): string {
  return `${componentId}\n${serverName}`
}

/** Bindings of a resolved spec (refs carry local ids). */
function resolvedBindings(value: unknown): Binding[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((entry, index): Binding[] => {
    if (!isJsonObject(entry) || typeof entry.serverName !== "string") return []
    const componentId = resolvedRefId(entry.component, `mcpConnections[${index}].component`)
    const connectionId = resolvedRefId(entry.connection, `mcpConnections[${index}].connection`)
    if (!componentId || !connectionId) return []
    const auth = entry.requiredAuthType
    return [{
      componentId,
      serverName: entry.serverName.trim(),
      connectionId,
      requiredAuthType: auth === "oauth" || auth === "apikey" || auth === "none" ? auth : null,
      ownedByPlugin: entry.ownedByPlugin === true,
      label: entry.serverName.trim(),
    }]
  })
}

/** Bindings of an exported (target) spec: ids are in the refs. */
function exportedBindings(value: unknown): Binding[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((entry): Binding[] => {
    if (!isJsonObject(entry) || typeof entry.serverName !== "string") return []
    const [componentId] = exportedRefIds([entry.component])
    const [connectionId] = exportedRefIds([entry.connection])
    if (!componentId || !connectionId) return []
    const auth = entry.requiredAuthType
    return [{
      componentId,
      serverName: entry.serverName,
      connectionId,
      requiredAuthType: auth === "oauth" || auth === "apikey" || auth === "none" ? auth : null,
      ownedByPlugin: entry.ownedByPlugin === true,
      label: entry.serverName,
    }]
  })
}

function refNames(value: unknown): Map<string, string> {
  const out = new Map<string, string>()
  if (!Array.isArray(value)) return out
  for (const entry of value) {
    if (!isJsonObject(entry)) continue
    const id = typeof entry.id === "string" ? entry.id : typeof entry.$ref === "string" ? entry.$ref.slice(entry.$ref.indexOf("/") + 1) : null
    if (id) out.set(id, typeof entry.name === "string" && entry.name ? entry.name : id)
  }
  return out
}

async function readPlugins(ctx: ConfigAreaContext, ids: readonly string[] | null): Promise<ConfigItem[]> {
  const organizationId = normalizeDenTypeId("organization", ctx.organizationId)
  const { rows: allRows, shared } = await loadSharedPlugins(ctx.db, organizationId)
  const wanted = ids ? new Set(ids) : null
  const rows = allRows.filter((row) => wanted ? wanted.has(row.id) : shared.ids.has(row.id))
  if (rows.length === 0) return []
  const pluginIds = rows.map((row) => row.id)

  const [memberships, grants, collections, bindings] = await Promise.all([
    ctx.db.select({ pluginId: PluginConfigObjectTable.pluginId, object: ConfigObjectTable })
      .from(PluginConfigObjectTable)
      .innerJoin(ConfigObjectTable, eq(ConfigObjectTable.id, PluginConfigObjectTable.configObjectId))
      .where(and(
        eq(PluginConfigObjectTable.organizationId, organizationId),
        inArray(PluginConfigObjectTable.pluginId, pluginIds),
        isNull(PluginConfigObjectTable.removedAt),
        ne(PluginConfigObjectTable.membershipSource, "connector"),
        isNull(ConfigObjectTable.deletedAt),
        ne(ConfigObjectTable.status, "deleted"),
        // Workflows and scripts are not plugins.skills items (Library › Workflows).
        inArray(ConfigObjectTable.objectType, ["skill", "agent", "command", "tool", "mcp", "hook", "context", "custom", "app"]),
      )),
    loadGrants(ctx.db, "plugin", organizationId, pluginIds),
    ctx.db.select({ pluginId: MarketplacePluginTable.pluginId, marketplaceId: MarketplaceTable.id, name: MarketplaceTable.name })
      .from(MarketplacePluginTable)
      .innerJoin(MarketplaceTable, eq(MarketplaceTable.id, MarketplacePluginTable.marketplaceId))
      .where(and(
        eq(MarketplacePluginTable.organizationId, organizationId),
        inArray(MarketplacePluginTable.pluginId, pluginIds),
        isNull(MarketplacePluginTable.removedAt),
        isNull(MarketplaceTable.deletedAt),
        inArray(MarketplaceTable.status, ["active", "archived"]),
      )),
    ctx.db.select({ binding: PluginMcpRequirementBindingTable, connectionName: ExternalMcpConnectionTable.name })
      .from(PluginMcpRequirementBindingTable)
      .innerJoin(ExternalMcpConnectionTable, eq(ExternalMcpConnectionTable.id, PluginMcpRequirementBindingTable.externalMcpConnectionId))
      .where(and(
        eq(PluginMcpRequirementBindingTable.organizationId, organizationId),
        inArray(PluginMcpRequirementBindingTable.pluginId, pluginIds),
        // connectors.mcp carries external MCP connections only.
        eq(ExternalMcpConnectionTable.kind, "external_mcp"),
      )),
  ])
  // Authored MCP Apps are not plugins.skills items either.
  const appIds = memberships.filter((entry) => entry.object.objectType === "app").map((entry) => entry.object.id)
  const appVersions = appIds.length > 0 ? await latestConfigObjectVersions(appIds, organizationId) : new Map()
  const components = memberships.filter((entry) => {
    const version = appVersions.get(entry.object.id)
    return !(entry.object.objectType === "app" && version && isAuthoredMcpAppVersion(version))
  })
  const componentTitles = new Map(memberships.map((entry) => [entry.object.id, entry.object.title]))
  const names = await loadAudienceNames(ctx.db, organizationId, grants)

  const items = rows.map((row): ConfigItem => {
    const ownComponents = components.filter((entry) => entry.pluginId === row.id)
      .sort((left, right) => left.object.id.localeCompare(right.object.id))
      .map((entry) => ({ $ref: `plugins.skills/${entry.object.id}`, name: entry.object.title }))
    const ownCollections = collections.filter((entry) => entry.pluginId === row.id)
      .sort((left, right) => left.marketplaceId.localeCompare(right.marketplaceId))
      .map((entry) => ({ $ref: `settings.advanced.collections/${entry.marketplaceId}`, name: entry.name }))
    const ownBindings = bindings.filter((entry) => entry.binding.pluginId === row.id)
      .sort((left, right) => left.binding.configObjectId.localeCompare(right.binding.configObjectId) || left.binding.serverName.localeCompare(right.binding.serverName))
      .map(({ binding, connectionName }) => {
        const title = componentTitles.get(binding.configObjectId)
        return {
          component: title ? { $ref: `plugins.skills/${binding.configObjectId}`, name: title } : { $ref: `plugins.skills/${binding.configObjectId}` },
          serverName: binding.serverName,
          connection: { $ref: `connectors.mcp/${binding.externalMcpConnectionId}`, name: connectionName },
          requiredAuthType: binding.requiredAuthType ?? null,
          ownedByPlugin: binding.connectionOwnedByPlugin,
        }
      })
    return {
      id: row.id,
      key: null,
      name: row.name,
      spec: {
        description: row.description ?? null,
        archived: row.status === "archived",
        components: ownComponents,
        access: accessSpec(grants.filter((grant) => grant.resourceId === row.id), names),
        collections: ownCollections,
        mcpConnections: ownBindings,
        sourceRepositoryUrl: row.sourceRepositoryUrl ?? null,
        sourceFormat: row.sourceFormat ?? null,
        managedBy: shared.sourceMapped.has(row.id) ? "source" : "manual",
        builtIn: shared.builtIn.has(row.id),
      },
    }
  })
  return items.sort((left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id))
}

async function requireConnectionsManage(actor: PluginArchActorContext) {
  if (!(await pluginArchHasPermission(actor, "connections.manage"))) {
    throw new ConfigApplyError("forbidden", "Choosing which connection serves a plugin's MCP server needs the Manage connections permission.", 403, "mcpConnections")
  }
}

async function writeBinding(input: { ctx: ConfigAreaContext; actor: PluginArchActorContext; pluginId: string; binding: Binding; log: ConfigStepLog; action: "add" | "set" }) {
  const organizationId = normalizeDenTypeId("organization", input.ctx.organizationId)
  const connectionId = normalizeDenTypeId("externalMcpConnection", input.binding.connectionId)
  await input.log.run({ action: input.action, target: "mcpConnections", detail: input.binding.label }, async () => {
    const [connection] = await input.ctx.db.select({ id: ExternalMcpConnectionTable.id })
      .from(ExternalMcpConnectionTable)
      .where(and(eq(ExternalMcpConnectionTable.organizationId, organizationId), eq(ExternalMcpConnectionTable.id, connectionId)))
      .limit(1)
    if (!connection) throw new ConfigApplyError("connection_not_found", `The connection for MCP server "${input.binding.serverName}" does not exist here.`, 404, "mcpConnections")
    const row = await upsertPluginMcpRequirementBinding({
      configObjectId: normalizeDenTypeId("configObject", input.binding.componentId),
      createdByOrgMembershipId: input.actor.organizationContext.currentMember.id,
      externalMcpConnectionId: connectionId,
      organizationId,
      pluginId: normalizeDenTypeId("plugin", input.pluginId),
      serverName: input.binding.serverName,
      requiredAuthType: input.binding.requiredAuthType,
      connectionOwnedByPlugin: input.binding.ownedByPlugin,
    })
    await syncPluginMcpRequirementBindingAccess(row)
  })
}

async function removeBinding(input: { ctx: ConfigAreaContext; pluginId: string; binding: Binding; log: ConfigStepLog }) {
  const organizationId = normalizeDenTypeId("organization", input.ctx.organizationId)
  await input.log.run({ action: "remove", target: "mcpConnections", detail: input.binding.label }, async () => {
    const rows = await input.ctx.db.select({ id: PluginMcpRequirementBindingTable.id })
      .from(PluginMcpRequirementBindingTable)
      .where(and(
        eq(PluginMcpRequirementBindingTable.organizationId, organizationId),
        eq(PluginMcpRequirementBindingTable.pluginId, normalizeDenTypeId("plugin", input.pluginId)),
        eq(PluginMcpRequirementBindingTable.configObjectId, normalizeDenTypeId("configObject", input.binding.componentId)),
        eq(PluginMcpRequirementBindingTable.serverName, input.binding.serverName),
      ))
    await deletePluginMcpRequirementBindingsByIds({ bindingIds: rows.map((row) => row.id) })
  })
}

/** Adds and removes set members: components or collections. `previous` are target-local ids. */
async function applySet(input: {
  target: "components" | "collections"
  desired: readonly string[]
  previous: readonly string[]
  names: Map<string, string>
  log: ConfigStepLog
  add: (id: string) => Promise<unknown>
  remove: (id: string) => Promise<unknown>
}) {
  const previous = new Set(input.previous)
  const desired = new Set(input.desired)
  for (const id of desired) {
    if (previous.has(id)) continue
    await input.log.run({ action: "add", target: input.target, detail: input.names.get(id) ?? id }, () => input.add(id))
  }
  for (const id of previous) {
    if (desired.has(id)) continue
    await input.log.run({ action: "remove", target: input.target, detail: input.names.get(id) ?? id }, () => input.remove(id))
  }
}

async function removableCollections(ctx: ConfigAreaContext, pluginId: string, marketplaceIds: readonly string[], warnings: string[]): Promise<Set<string>> {
  if (marketplaceIds.length === 0) return new Set()
  const rows = await ctx.db.select({ marketplaceId: MarketplacePluginTable.marketplaceId, membershipSource: MarketplacePluginTable.membershipSource })
    .from(MarketplacePluginTable)
    .where(and(
      eq(MarketplacePluginTable.pluginId, normalizeDenTypeId("plugin", pluginId)),
      inArray(MarketplacePluginTable.marketplaceId, marketplaceIds.map((id) => normalizeDenTypeId("marketplace", id))),
      isNull(MarketplacePluginTable.removedAt),
    ))
  const out = new Set<string>()
  for (const row of rows) {
    if (row.membershipSource === "connector" || row.membershipSource === "system") {
      warnings.push(`Kept in a collection that ${row.membershipSource === "system" ? "OpenWork" : "a source"} manages.`)
      continue
    }
    out.add(row.marketplaceId)
  }
  return out
}

export const pluginsPluginsArea = defineConfigArea({
  key: AREA,
  label: "Plugins",
  path: ["Plugins", "Plugins"],
  idPrefix: denTypeIdPrefixes.plugin,
  specVersion: 1,
  specSchema,
  dependsOn: ["members.teams", "members.people", "plugins.skills", "connectors.mcp", "settings.advanced.collections"],
  deployments: ["cloud", "self_hosted"],
  viewPermission: "sharing.manage_all",
  managePermission: "sharing.manage_all",
  tables: ["plugin", "plugin_config_object", "plugin_access_grant", "plugin_mcp_requirement_binding", "marketplace_plugin"],
  naturalKeys: [{
    // Built-in plugins have one copy per organization, named the same everywhere.
    label: "built-in plugin name",
    get: (item) => item.spec.builtIn === true ? `builtin:${normalizeText(item.name)}` : null,
  }],
  similarity: (blob, target) => {
    const reasons: string[] = []
    const name = nameSimilarity(blob.name, target.name)
    if (name === 1) reasons.push("same name")
    else if (name > 0) reasons.push(`similar name (${Math.round(name * 100)}%)`)
    const description = textOverlap(
      typeof blob.spec.description === "string" ? blob.spec.description : null,
      typeof target.spec.description === "string" ? target.spec.description : null,
    )
    if (description === 1) reasons.push("same description")
    const componentNames = (spec: ConfigItem["spec"]) => new Set([...refNames(spec.components).values()].map(normalizeText))
    const left = componentNames(blob.spec)
    const right = componentNames(target.spec)
    const components = left.size === 0 && right.size === 0 ? 0 : jaccard(left, right)
    if (components > 0) reasons.push(`${Math.round(components * 100)}% of the components share names`)
    const repository = typeof blob.spec.sourceRepositoryUrl === "string" && blob.spec.sourceRepositoryUrl === target.spec.sourceRepositoryUrl
    if (repository) reasons.push("same source repository")
    const score = 0.45 * name + 0.15 * description + 0.3 * components + (repository ? 0.1 : 0)
    return { score: Math.min(1, score), reasons }
  },
  secretFields: [],
  arrayKeys: { components: "$ref", collections: "$ref" },
  informationalFields: ["sourceRepositoryUrl", "sourceFormat", "managedBy", "builtIn"],
  transactional: false,
  protectedFromDelete: (item) => {
    if (item.spec.builtIn === true) return `"${item.name}" is built into the OpenWork Marketplace.`
    if (item.spec.managedBy === "source") return `"${item.name}" is filled by a source in Plugins › Sources; remove it there.`
    return null
  },

  irreversible: (op) => {
    if (op.kind !== "update" || !touches(op.changes, "mcpConnections")) return []
    return [`Changing which connection serves an MCP server of "${op.previous.name}" moves members' access to the new connection; their sign-ins to the old one are not carried over.`]
  },

  async exportItems(ctx) {
    return readPlugins(ctx, null)
  },

  async readItems(ctx, ids) {
    return readPlugins(ctx, ids)
  },

  async apply(ctx, op) {
    return applyWithSteps(async (log) => {
      const actor = await pluginArchActor(ctx)
      const warnings: string[] = []

      if (op.kind === "delete") {
        await log.run({ action: "set", target: "archived", detail: "true" }, () =>
          setPluginLifecycle({ context: actor, pluginId: normalizeDenTypeId("plugin", op.targetId), action: "archive" }))
        return { localId: op.targetId, warnings: [`"${op.previous.name}" was archived: plugins are archived, not deleted.`] }
      }

      const raw: JsonObject = specObject(op.item.spec)
      const spec = parseSpec(applySpecSchema, raw)
      const name = op.item.name.trim()
      if (!name) throw new ConfigApplyError("invalid_spec", "A plugin needs a name.", 400, "name")
      const desiredComponents = resolvedRefIds(raw.components, "components")
      const desiredCollections = resolvedRefIds(raw.collections, "collections")
      const desiredBindings = resolvedBindings(raw.mcpConnections)
      const componentNames = refNames(raw.components)
      const collectionNames = refNames(raw.collections)

      let pluginId: string
      if (op.kind === "create") {
        await requirePluginArchCapability(actor, "plugin.create")
        const created = await log.run({ action: "create", target: "plugin", detail: name }, () => createPlugin({
          context: actor,
          ...(op.preferredId ? { id: normalizeDenTypeId("plugin", op.preferredId) } : {}),
          name,
          description: spec.description,
          sourceFormat: spec.sourceFormat,
          sourceRepositoryUrl: spec.sourceRepositoryUrl,
        }), "name")
        pluginId = created.id
        const id = normalizeDenTypeId("plugin", pluginId)
        await applySet({
          target: "components", desired: desiredComponents, previous: [], names: componentNames, log,
          add: (objectId) => attachConfigObjectToPlugin({ context: actor, pluginId: id, configObjectId: normalizeDenTypeId("configObject", objectId) }),
          remove: async () => undefined,
        })
        await applyAccess({ ctx, actor, kind: "plugin", resourceId: pluginId, access: raw.access, log, warnings })
        await applySet({
          target: "collections", desired: desiredCollections, previous: [], names: collectionNames, log,
          add: (marketplaceId) => attachPluginToMarketplace({ context: actor, pluginId: id, marketplaceId: normalizeDenTypeId("marketplace", marketplaceId) }),
          remove: async () => undefined,
        })
        if (desiredBindings.length > 0) await requireConnectionsManage(actor)
        for (const binding of desiredBindings) await writeBinding({ ctx, actor, pluginId, binding, log, action: "add" })
        if (spec.archived) {
          await log.run({ action: "set", target: "archived", detail: "true" }, () => setPluginLifecycle({ context: actor, pluginId: id, action: "archive" }))
        }
        return { localId: pluginId, warnings }
      }

      // update: only the parts the plan changes.
      pluginId = normalizeDenTypeId("plugin", op.targetId)
      const id = normalizeDenTypeId("plugin", pluginId)
      const renamed = name !== op.previous.name
      if (renamed || touches(op.changes, "description")) {
        await log.run(
          renamed && touches(op.changes, "description") ? { action: "update", target: "plugin", detail: "name and description" }
            : renamed ? { action: "set", target: "name", detail: name }
              : { action: "set", target: "description" },
          () => updatePlugin({ context: actor, pluginId: id, name, description: spec.description }),
          renamed ? "name" : "description",
        )
      }
      if (touches(op.changes, "archived") && op.previous.spec.archived !== spec.archived) {
        // Restore first so the other writes see an active plugin; archive last.
        if (!spec.archived) await log.run({ action: "set", target: "archived", detail: "false" }, () => setPluginLifecycle({ context: actor, pluginId: id, action: "restore" }))
      }
      if (touches(op.changes, "components")) {
        await applySet({
          target: "components", desired: desiredComponents, previous: exportedRefIds(op.previous.spec.components), names: new Map([...refNames(op.previous.spec.components), ...componentNames]), log,
          add: (objectId) => attachConfigObjectToPlugin({ context: actor, pluginId: id, configObjectId: normalizeDenTypeId("configObject", objectId) }),
          remove: (objectId) => removeConfigObjectFromPlugin({ context: actor, pluginId: id, configObjectId: normalizeDenTypeId("configObject", objectId) }),
        })
      }
      if (touches(op.changes, "access")) {
        await applyAccess({ ctx, actor, kind: "plugin", resourceId: pluginId, access: raw.access, log, warnings })
      }
      if (touches(op.changes, "collections")) {
        const previous = exportedRefIds(op.previous.spec.collections)
        const removable = await removableCollections(ctx, pluginId, previous.filter((marketplaceId) => !desiredCollections.includes(marketplaceId)), warnings)
        await applySet({
          target: "collections", desired: desiredCollections, previous: previous.filter((marketplaceId) => desiredCollections.includes(marketplaceId) || removable.has(marketplaceId)), names: new Map([...refNames(op.previous.spec.collections), ...collectionNames]), log,
          add: (marketplaceId) => attachPluginToMarketplace({ context: actor, pluginId: id, marketplaceId: normalizeDenTypeId("marketplace", marketplaceId) }),
          remove: (marketplaceId) => removePluginFromMarketplace({ context: actor, pluginId: id, marketplaceId: normalizeDenTypeId("marketplace", marketplaceId) }),
        })
      }
      if (touches(op.changes, "mcpConnections")) {
        await requireConnectionsManage(actor)
        const previous = new Map(exportedBindings(op.previous.spec.mcpConnections).map((binding) => [bindingKey(binding.componentId, binding.serverName), binding]))
        const desired = new Map(desiredBindings.map((binding) => [bindingKey(binding.componentId, binding.serverName), binding]))
        for (const [key, binding] of desired) {
          const before = previous.get(key)
          if (before && before.connectionId === binding.connectionId && before.requiredAuthType === binding.requiredAuthType && before.ownedByPlugin === binding.ownedByPlugin) continue
          await writeBinding({ ctx, actor, pluginId, binding, log, action: before ? "set" : "add" })
        }
        for (const [key, binding] of previous) {
          if (!desired.has(key)) await removeBinding({ ctx, pluginId, binding, log })
        }
      }
      if (touches(op.changes, "archived") && op.previous.spec.archived !== spec.archived && spec.archived) {
        await log.run({ action: "set", target: "archived", detail: "true" }, () => setPluginLifecycle({ context: actor, pluginId: id, action: "archive" }))
      }
      return { localId: pluginId, warnings }
    })
  },
})
