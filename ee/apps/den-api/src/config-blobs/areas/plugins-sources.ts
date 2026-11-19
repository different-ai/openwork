/**
 * `plugins.sources`: sync sources (Plugins › Sources), today GitHub
 * repositories that keep plugins and skills in sync with a branch.
 *
 * Exported per source (`connector_instance`, name unique per organization):
 * the repository, status, whether new plugins are imported automatically,
 * its targets (`connector_target`, keyed by repository: branch, ref and
 * repository id) with their mappings (`connector_mapping`, keyed by object
 * type + selector: path selector, target plugin `{ $ref:
 * "plugins.plugins/<id>" }`, auto-add, mapping options) and who can manage
 * it, by role.
 *
 * The GitHub App installation (`connector_account`) belongs to the instance
 * that installed it: it is exported as reference information only (`account`,
 * informational) and never created by an import. Creating a source needs an
 * active account with the same installation id in the target organization
 * (`connector_instance.connector_account_id` is required); without one the
 * item fails with `needs_setup` ("connect GitHub first"). Runtime sync state
 * (sync events, source bindings, tombstones, reconcile rows, discovery
 * caches, cursors) is never exported.
 *
 * Applying a new source, or changing its targets or mappings, queues a sync of
 * the changed targets (the worker then calls GitHub and imports files as
 * skills into the mapped plugins): `externalEffects`.
 *
 * Applies through the plugin-system store, as the connector routes do:
 * `createConnectorInstance`, `updateConnectorInstance`,
 * `setConnectorInstanceAutoImport`, `setConnectorInstanceLifecycle`,
 * `createConnectorTarget` / `updateConnectorTarget`, `createConnectorMapping` /
 * `updateConnectorMapping` / `deleteConnectorMapping`,
 * `queueConnectorTargetResync`, `removeConnectorInstance` and the access-grant
 * calls.
 */
import { and, eq, inArray } from "@openwork-ee/den-db/drizzle"
import {
  ConnectorAccountTable,
  ConnectorInstanceTable,
  ConnectorMappingTable,
  ConnectorTargetTable,
  PluginTable,
  configObjectTypeValues,
  connectorMappingKindValues,
  connectorTargetKindValues,
  connectorTypeValues,
} from "@openwork-ee/den-db/schema"
import { denTypeIdPrefixes, normalizeDenTypeId } from "@openwork-ee/utils/typeid"
import { z } from "zod"
import { requirePluginArchCapability } from "../../routes/org/plugin-system/access.js"
import {
  createConnectorInstance,
  createConnectorMapping,
  createConnectorTarget,
  deleteConnectorMapping,
  queueConnectorTargetResync,
  removeConnectorInstance,
  setConnectorInstanceAutoImport,
  setConnectorInstanceLifecycle,
  updateConnectorInstance,
  updateConnectorMapping,
  updateConnectorTarget,
} from "../../routes/org/plugin-system/store.js"
import { ConfigApplyItemError, defineConfigArea, type ConfigAreaContext, type ConfigItem } from "../area.js"
import {
  accessByRoleSchema,
  accessSpec,
  applyAccess,
  loadAudienceNames,
  loadGrants,
  parseSpec,
  pluginArchActor,
  resolvedRefId,
  sameJson,
} from "./plugins-support.js"
import { ConfigApplyError, applyWithSteps, isJsonObject, ownManagerAccessPreflight, specObject, specRefSchema, touches, type ConfigStepLog, type JsonObject } from "./route-support.js"

const AREA = "plugins.sources"

/** Target settings that are configuration; everything else in target_config_json (discovery cache…) is runtime. */
const TARGET_CONFIG_KEYS = ["branch", "ref", "repositoryFullName", "repositoryId"] as const

const scalarRecordSchema = z.record(z.string(), z.union([z.string().max(2048), z.number(), z.boolean(), z.null()]))

const mappingSchema = z.object({
  /** `<objectType>:<selector>`, unique per target. */
  key: z.string().min(1).max(300),
  mappingKind: z.enum(connectorMappingKindValues).default("path"),
  selector: z.string().trim().min(1).max(255),
  objectType: z.enum(configObjectTypeValues),
  plugin: specRefSchema.nullable().default(null),
  autoAddToPlugin: z.boolean().default(false),
  config: scalarRecordSchema.nullable().default(null),
}).strict()

const targetSchema = z.object({
  /** The repository (`owner/name`), unique per source. */
  remoteId: z.string().trim().min(1).max(255),
  targetKind: z.enum(connectorTargetKindValues).default("repository_branch"),
  branch: z.string().trim().min(1).max(255).nullable().default(null),
  config: scalarRecordSchema.default({}),
  mappings: z.array(mappingSchema).max(1000).default([]),
}).strict()

const specSchema = z.object({
  connectorType: z.enum(connectorTypeValues).default("github"),
  repository: z.string().trim().min(1).max(255).nullable().default(null),
  status: z.enum(["active", "disabled", "archived"]).default("active"),
  autoImportNewPlugins: z.boolean().default(true),
  targets: z.array(targetSchema).max(100).default([]),
  access: accessByRoleSchema.default({ orgWide: null, teams: { viewer: [], editor: [], manager: [] }, members: { viewer: [], editor: [], manager: [] } }),
  /** The GitHub App installation on the source instance. Informational: re-connect it on another instance. */
  account: z.object({
    remoteId: z.string().max(255),
    displayName: z.string().max(255),
    login: z.string().max(255).nullable(),
  }).strict().nullable().default(null),
}).strict()

type MappingSpec = z.infer<typeof mappingSchema>

function mappingKey(objectType: string, selector: string): string {
  return `${objectType}:${selector.trim()}`
}

function scalarConfig(value: unknown, keys: readonly string[] | null): Record<string, string | number | boolean | null> {
  const out: Record<string, string | number | boolean | null> = {}
  if (!isJsonObject(value)) return out
  for (const key of Object.keys(value).sort()) {
    if (keys && !keys.includes(key)) continue
    const entry = value[key]
    if (typeof entry === "string" || typeof entry === "number" || typeof entry === "boolean" || entry === null) out[key] = entry
  }
  return out
}

async function readSources(ctx: ConfigAreaContext, ids: readonly string[] | null): Promise<ConfigItem[]> {
  const organizationId = normalizeDenTypeId("organization", ctx.organizationId)
  if (ids && ids.length === 0) return []
  const instances = await ctx.db.select().from(ConnectorInstanceTable).where(and(
    eq(ConnectorInstanceTable.organizationId, organizationId),
    ids ? inArray(ConnectorInstanceTable.id, ids.map((id) => normalizeDenTypeId("connectorInstance", id))) : undefined,
  ))
  if (instances.length === 0) return []
  const instanceIds = instances.map((row) => row.id)
  const [accounts, targets, mappings, grants] = await Promise.all([
    ctx.db.select().from(ConnectorAccountTable).where(and(eq(ConnectorAccountTable.organizationId, organizationId), inArray(ConnectorAccountTable.id, [...new Set(instances.map((row) => row.connectorAccountId))]))),
    ctx.db.select().from(ConnectorTargetTable).where(and(eq(ConnectorTargetTable.organizationId, organizationId), inArray(ConnectorTargetTable.connectorInstanceId, instanceIds))),
    ctx.db.select({ mapping: ConnectorMappingTable, pluginName: PluginTable.name })
      .from(ConnectorMappingTable)
      .leftJoin(PluginTable, eq(PluginTable.id, ConnectorMappingTable.pluginId))
      .where(and(eq(ConnectorMappingTable.organizationId, organizationId), inArray(ConnectorMappingTable.connectorInstanceId, instanceIds))),
    loadGrants(ctx.db, "connector_instance", organizationId, instanceIds),
  ])
  const names = await loadAudienceNames(ctx.db, organizationId, grants)
  const accountById = new Map(accounts.map((account) => [account.id, account]))

  const items = instances.map((row): ConfigItem => {
    const account = accountById.get(row.connectorAccountId)
    const config = isJsonObject(row.instanceConfigJson) ? row.instanceConfigJson : {}
    const ownTargets = targets.filter((target) => target.connectorInstanceId === row.id)
      .sort((left, right) => left.remoteId.localeCompare(right.remoteId))
      .map((target) => ({
        remoteId: target.remoteId,
        targetKind: target.targetKind,
        branch: target.externalTargetRef ?? null,
        config: scalarConfig(target.targetConfigJson, TARGET_CONFIG_KEYS),
        mappings: mappings.filter((entry) => entry.mapping.connectorTargetId === target.id)
          .map(({ mapping, pluginName }) => ({
            key: mappingKey(mapping.objectType, mapping.selector),
            mappingKind: mapping.mappingKind,
            selector: mapping.selector,
            objectType: mapping.objectType,
            plugin: mapping.pluginId ? (pluginName ? { $ref: `plugins.plugins/${mapping.pluginId}`, name: pluginName } : { $ref: `plugins.plugins/${mapping.pluginId}` }) : null,
            autoAddToPlugin: mapping.autoAddToPlugin,
            config: mapping.mappingConfigJson ? scalarConfig(mapping.mappingConfigJson, null) : null,
          }))
          .sort((left, right) => left.key.localeCompare(right.key)),
      }))
    return {
      id: row.id,
      key: null,
      name: row.name,
      spec: {
        connectorType: row.connectorType,
        repository: row.remoteId ?? null,
        // `error` is sync state, not configuration.
        status: row.status === "error" ? "active" : row.status,
        autoImportNewPlugins: typeof config.autoImportNewPlugins === "boolean" ? config.autoImportNewPlugins : true,
        targets: ownTargets,
        access: accessSpec(grants.filter((grant) => grant.resourceId === row.id), names),
        account: account ? { remoteId: account.remoteId, displayName: account.displayName, login: account.externalAccountRef ?? null } : null,
      },
    }
  })
  return items.sort((left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id))
}

/** The plain fields of an apply spec; mapping plugin refs are read separately (resolved, they carry `id`). */
const applySpecSchema = specSchema.omit({ targets: true, access: true }).extend({
  targets: z.array(targetSchema.extend({
    mappings: z.array(mappingSchema.extend({ plugin: z.unknown() }).passthrough()).default([]),
  }).passthrough()).default([]),
}).passthrough()

function mappingPluginId(mapping: { plugin?: unknown }, label: string) {
  const id = resolvedRefId(mapping.plugin, label)
  return id ? normalizeDenTypeId("plugin", id) : null
}

type ActorContext = Awaited<ReturnType<typeof pluginArchActor>>

async function createMappings(input: { actor: ActorContext; targetId: string; target: { remoteId: string; mappings: Array<Omit<MappingSpec, "plugin"> & { plugin?: unknown }> }; log: ConfigStepLog }) {
  for (const mapping of input.target.mappings) {
    const pluginId = mappingPluginId(mapping, `targets[${input.target.remoteId}].mappings[${mapping.key}].plugin`)
    await input.log.run({ action: "add", target: `targets[${input.target.remoteId}].mappings`, detail: mappingKey(mapping.objectType, mapping.selector) }, () => createConnectorMapping({
      autoAddToPlugin: mapping.autoAddToPlugin,
      ...(mapping.config ? { config: mapping.config } : {}),
      connectorTargetId: normalizeDenTypeId("connectorTarget", input.targetId),
      context: input.actor,
      mappingKind: mapping.mappingKind,
      objectType: mapping.objectType,
      pluginId,
      selector: mapping.selector,
    }), "targets")
  }
}

function targetConfigFor(target: { branch: string | null; config: Record<string, string | number | boolean | null> }, current: unknown): Record<string, unknown> {
  // Keep the runtime keys (discovery cache) of the current config; replace the configuration keys.
  const base: JsonObject = isJsonObject(current) ? { ...current } : {}
  for (const key of TARGET_CONFIG_KEYS) delete base[key]
  return { ...base, ...scalarConfig(target.config, TARGET_CONFIG_KEYS) }
}

async function queueSync(input: { actor: ActorContext; targetId: string; remoteId: string; log: ConfigStepLog }) {
  await input.log.run({ action: "create", target: `targets[${input.remoteId}].sync`, detail: "sync queued" }, () =>
    queueConnectorTargetResync({ context: input.actor, connectorTargetId: normalizeDenTypeId("connectorTarget", input.targetId) }), "targets")
}

type AccountSpec = { remoteId: string; displayName: string } | null

/** The target's active installation a new source can use: same connector type and installation id. */
async function findAccount(ctx: ConfigAreaContext, connectorType: (typeof connectorTypeValues)[number], account: AccountSpec) {
  if (!account) return null
  const [row] = await ctx.db.select().from(ConnectorAccountTable).where(and(
    eq(ConnectorAccountTable.organizationId, normalizeDenTypeId("organization", ctx.organizationId)),
    eq(ConnectorAccountTable.connectorType, connectorType),
    eq(ConnectorAccountTable.remoteId, account.remoteId),
    eq(ConnectorAccountTable.status, "active"),
  )).limit(1)
  return row ?? null
}

function needsAccountMessage(name: string, account: AccountSpec): string {
  const who = account ? `"${account.displayName}"` : "its GitHub account"
  return `"${name}" needs ${who} connected here first: connect the GitHub App in Plugins › Sources, then re-check this change (an installation belongs to the instance that made it), or skip this item.`
}

export const pluginsSourcesArea = defineConfigArea({
  key: AREA,
  label: "Sources",
  path: ["Plugins", "Sources"],
  idPrefix: denTypeIdPrefixes.connectorInstance,
  specVersion: 1,
  specSchema,
  dependsOn: ["members.teams", "members.people", "plugins.plugins"],
  deployments: ["cloud", "self_hosted"],
  viewPermission: "connectors.manage",
  managePermission: "connectors.manage",
  tables: ["connector_instance", "connector_target", "connector_mapping", "connector_instance_access_grant", "connector_account"],
  naturalKeys: [{ label: "name", get: (item) => item.name.trim().toLowerCase() || null }],
  uniqueFields: [{ label: "name", get: (item) => item.name.trim().toLowerCase() || null }],
  secretFields: [],
  arrayKeys: { targets: "remoteId", "targets[].mappings": "key" },
  informationalFields: ["account"],
  transactional: false,
  externalEffects: true,

  irreversible: (op) => {
    if (op.kind === "delete") {
      return [`Every skill, its version history and every plugin imported from "${op.previous.name}" are permanently deleted with the source.`]
    }
    const repository = typeof op.item.spec.repository === "string" ? op.item.spec.repository : op.item.name
    if (op.kind === "create" || touches(op.changes, "targets")) {
      return [`A sync of ${repository} is queued: it imports the repository's files as skills into the mapped plugins.`]
    }
    return []
  },

  async preflight(ctx, op) {
    if (op.kind !== "create") return ownManagerAccessPreflight(ctx, op)
    const parsed = z.object({ connectorType: specSchema.shape.connectorType, account: specSchema.shape.account }).safeParse(op.item.spec)
    if (!parsed.success) return null
    if (await findAccount(ctx, parsed.data.connectorType, parsed.data.account)) return null
    return { block: needsAccountMessage(op.item.name.trim(), parsed.data.account) }
  },

  async exportItems(ctx) {
    return readSources(ctx, null)
  },

  async readItems(ctx, ids) {
    return readSources(ctx, ids)
  },

  async apply(ctx, op) {
    return applyWithSteps(async (log) => {
      const actor = await pluginArchActor(ctx)
      const warnings: string[] = []
      const organizationId = normalizeDenTypeId("organization", ctx.organizationId)

      if (op.kind === "delete") {
        await log.run({ action: "delete", target: "source", detail: op.previous.name }, () =>
          removeConnectorInstance({ context: actor, connectorInstanceId: normalizeDenTypeId("connectorInstance", op.targetId) }))
        return { localId: op.targetId }
      }

      const raw = specObject(op.item.spec)
      const spec = parseSpec(applySpecSchema, raw)
      const name = op.item.name.trim()
      if (!name) throw new ConfigApplyError("invalid_spec", "A source needs a name.", 400, "name")

      if (op.kind === "create") {
        await requirePluginArchCapability(actor, "connector_instance.create")
        const account = await findAccount(ctx, spec.connectorType, spec.account)
        if (!account) {
          throw new ConfigApplyItemError({ code: "needs_setup", message: needsAccountMessage(name, spec.account), field: "account", status: 409 })
        }
        const installationId = Number(account.remoteId)
        const created = await log.run({ action: "create", target: "source", detail: name }, () => createConnectorInstance({
          connectorAccountId: account.id,
          connectorType: spec.connectorType,
          config: { autoImportNewPlugins: spec.autoImportNewPlugins, ...(Number.isSafeInteger(installationId) ? { installationId } : {}) },
          context: actor,
          ...(op.preferredId ? { id: normalizeDenTypeId("connectorInstance", op.preferredId) } : {}),
          name,
          remoteId: spec.repository,
        }), "name")
        const instanceId = normalizeDenTypeId("connectorInstance", created.id)
        const createdTargets: Array<{ id: string; remoteId: string }> = []
        for (const target of spec.targets) {
          const row = await log.run({ action: "add", target: "targets", detail: target.remoteId }, () => createConnectorTarget({
            config: targetConfigFor(target, null),
            connectorInstanceId: instanceId,
            connectorType: spec.connectorType,
            context: actor,
            externalTargetRef: target.branch,
            remoteId: target.remoteId,
            targetKind: target.targetKind,
          }))
          createdTargets.push({ id: row.id, remoteId: target.remoteId })
          await createMappings({ actor, targetId: row.id, target, log })
        }
        await applyAccess({ ctx, actor, kind: "connector_instance", resourceId: instanceId, access: raw.access, log, warnings })
        if (spec.status !== "active") {
          await log.run({ action: "set", target: "status", detail: spec.status }, () =>
            setConnectorInstanceLifecycle({ context: actor, connectorInstanceId: instanceId, action: spec.status === "archived" ? "archive" : "disable" }))
        } else {
          for (const target of createdTargets) await queueSync({ actor, targetId: target.id, remoteId: target.remoteId, log })
        }
        return { localId: instanceId, warnings }
      }

      // update: only what the plan changes.
      const instanceId = normalizeDenTypeId("connectorInstance", op.targetId)
      const [current] = await ctx.db.select().from(ConnectorInstanceTable).where(and(eq(ConnectorInstanceTable.organizationId, organizationId), eq(ConnectorInstanceTable.id, instanceId))).limit(1)
      if (!current) throw new ConfigApplyError("connector_instance_not_found", `The source "${op.previous.name}" no longer exists.`, 404)
      const renamed = name !== current.name
      const repositoryChanged = touches(op.changes, "repository") && (spec.repository ?? null) !== (current.remoteId ?? null)
      if (renamed || repositoryChanged) {
        await log.run(
          renamed ? { action: "set", target: "name", detail: name } : { action: "set", target: "repository", detail: spec.repository ?? "" },
          () => updateConnectorInstance({ context: actor, connectorInstanceId: instanceId, ...(renamed ? { name } : {}), ...(repositoryChanged ? { remoteId: spec.repository } : {}) }),
          renamed ? "name" : "repository",
        )
      }
      if (touches(op.changes, "autoImportNewPlugins")) {
        await log.run({ action: "set", target: "autoImportNewPlugins", detail: String(spec.autoImportNewPlugins) }, () =>
          setConnectorInstanceAutoImport({ context: actor, connectorInstanceId: instanceId, autoImportNewPlugins: spec.autoImportNewPlugins }))
      }
      const statusChanged = touches(op.changes, "status") && spec.status !== (current.status === "error" ? "active" : current.status)
      if (statusChanged) {
        await log.run({ action: "set", target: "status", detail: spec.status }, () =>
          setConnectorInstanceLifecycle({ context: actor, connectorInstanceId: instanceId, action: spec.status === "archived" ? "archive" : spec.status === "disabled" ? "disable" : "enable" }))
      }
      if (touches(op.changes, "targets")) {
        await applyTargets({ ctx, actor, instanceId, spec, log, warnings })
      }
      if (touches(op.changes, "access")) {
        await applyAccess({ ctx, actor, kind: "connector_instance", resourceId: instanceId, access: raw.access, log, warnings })
      }
      return { localId: instanceId, warnings }
    })
  },
})

async function applyTargets(input: {
  ctx: ConfigAreaContext
  actor: ActorContext
  instanceId: string
  spec: z.infer<typeof applySpecSchema>
  log: ConfigStepLog
  warnings: string[]
}) {
  const { ctx, actor, log } = input
  const organizationId = normalizeDenTypeId("organization", ctx.organizationId)
  const instanceId = normalizeDenTypeId("connectorInstance", input.instanceId)
  const [targets, mappings] = await Promise.all([
    ctx.db.select().from(ConnectorTargetTable).where(and(eq(ConnectorTargetTable.organizationId, organizationId), eq(ConnectorTargetTable.connectorInstanceId, instanceId))),
    ctx.db.select().from(ConnectorMappingTable).where(and(eq(ConnectorMappingTable.organizationId, organizationId), eq(ConnectorMappingTable.connectorInstanceId, instanceId))),
  ])
  const byRemoteId = new Map(targets.map((target) => [target.remoteId, target]))
  const changedTargets = new Map<string, string>()
  for (const target of input.spec.targets) {
    const existing = byRemoteId.get(target.remoteId)
    if (!existing) {
      const row = await log.run({ action: "add", target: "targets", detail: target.remoteId }, () => createConnectorTarget({
        config: targetConfigFor(target, null),
        connectorInstanceId: instanceId,
        connectorType: input.spec.connectorType,
        context: actor,
        externalTargetRef: target.branch,
        remoteId: target.remoteId,
        targetKind: target.targetKind,
      }))
      await createMappings({ actor, targetId: row.id, target, log })
      changedTargets.set(row.id, target.remoteId)
      continue
    }
    const nextConfig = targetConfigFor(target, existing.targetConfigJson)
    const branchChanged = (target.branch ?? null) !== (existing.externalTargetRef ?? null)
    if (branchChanged || !sameJson(scalarConfig(existing.targetConfigJson, TARGET_CONFIG_KEYS), scalarConfig(target.config, TARGET_CONFIG_KEYS))) {
      await log.run({ action: "update", target: `targets[${target.remoteId}]`, detail: branchChanged ? `branch ${target.branch ?? "(none)"}` : "settings" }, () => updateConnectorTarget({
        config: nextConfig,
        connectorTargetId: existing.id,
        context: actor,
        ...(branchChanged ? { externalTargetRef: target.branch } : {}),
      }), "targets")
      changedTargets.set(existing.id, target.remoteId)
    }
    const currentMappings = new Map(mappings.filter((mapping) => mapping.connectorTargetId === existing.id).map((mapping) => [mappingKey(mapping.objectType, mapping.selector), mapping]))
    const desiredKeys = new Set<string>()
    for (const mapping of target.mappings) {
      const key = mappingKey(mapping.objectType, mapping.selector)
      desiredKeys.add(key)
      const label = `targets[${target.remoteId}].mappings`
      const pluginId = mappingPluginId(mapping, `${label}[${key}].plugin`)
      const before = currentMappings.get(key)
      if (!before) {
        await createMappings({ actor, targetId: existing.id, target: { remoteId: target.remoteId, mappings: [mapping] }, log })
        changedTargets.set(existing.id, target.remoteId)
        continue
      }
      const configChanged = !sameJson(before.mappingConfigJson ? scalarConfig(before.mappingConfigJson, null) : null, mapping.config ?? null)
      if (before.pluginId === pluginId && before.autoAddToPlugin === mapping.autoAddToPlugin && !configChanged) continue
      await log.run({ action: "update", target: label, detail: key }, () => updateConnectorMapping({
        connectorMappingId: before.id,
        context: actor,
        pluginId,
        autoAddToPlugin: mapping.autoAddToPlugin,
        ...(configChanged ? { config: mapping.config ?? {} } : {}),
      }), "targets")
      changedTargets.set(existing.id, target.remoteId)
    }
    for (const [key, mapping] of currentMappings) {
      if (desiredKeys.has(key)) continue
      await log.run({ action: "remove", target: `targets[${target.remoteId}].mappings`, detail: key }, () =>
        deleteConnectorMapping({ context: actor, connectorMappingId: mapping.id }), "targets")
      changedTargets.set(existing.id, target.remoteId)
    }
  }
  const desiredTargets = new Set(input.spec.targets.map((target) => target.remoteId))
  for (const target of targets) {
    if (!desiredTargets.has(target.remoteId)) input.warnings.push(`The source still syncs ${target.remoteId}: a target can't be removed by an import; remove the source and add it again.`)
  }
  if (input.spec.status === "active") {
    for (const [targetId, remoteId] of changedTargets) await queueSync({ actor, targetId, remoteId, log })
  }
}

