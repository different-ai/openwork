/**
 * Config-blob area `members.agent-permissions`: the Agents and Browser tabs
 * of Everyone and of each team (what agents may do on members' computers).
 *
 * - One item per stored policy: Everyone's (key `everyone`) or one team's
 *   overrides (`team` references `members.teams`). Settings are exported as
 *   stored, every permission included, whatever the source's flags.
 * - Matched by scope: Everyone, or the team's name.
 * - Apply writes only the permissions an update's changes name, one
 *   `agent_permission_setting` row each, in one transaction on `ctx.db`, and
 *   appends the same `agent_permission_policy` audit change as the routes
 *   (routes/org/agent-permissions.ts → saveAgentPermissionPolicy). A
 *   permission whose feature is off on the target (computer use, app
 *   scripting and outside folders need `agentHarnessPermissions`; browser
 *   uploads need `browserUploadPermissions`) is left as stored there, with a
 *   warning, exactly as the routes preserve what the editor can't show.
 */
import { and, asc, eq, inArray } from "@openwork-ee/den-db/drizzle"
import { AgentPermissionPolicyTable, AgentPermissionSettingTable, TeamTable } from "@openwork-ee/den-db/schema"
import { createDenTypeId, denTypeIdPrefixes, normalizeDenTypeId } from "@openwork-ee/utils/typeid"
import type { FeatureMap } from "@openwork/features"
import {
  AGENT_HARNESS_PERMISSION_KEYS,
  agentPermissionDecisionLabels,
  agentPermissionDefinitions,
  agentPermissionSettingsSchema,
  normalizeAgentPermissionSetting,
  type AgentPermissionKey,
  type AgentPermissionSetting,
  type AgentPermissionSettings,
} from "@openwork/types/den/agent-permissions"
import { configRefSchema, type ConfigApplyStep } from "@openwork/types/den/config-blobs"
import { z } from "zod"
import { agentPermissionPolicyChangedEvent, type AgentPermissionAuditScope } from "../../audit/domain/agent-permissions.js"
import { appendDomainChanges } from "../../audit/domain/legacy.js"
import { currentAuditChangeCapture } from "../../audit/request-capture.js"
import { defineConfigArea, type ConfigAreaContext, type ConfigItem } from "../area.js"
import {
  applyFailure,
  asItemError,
  changesScope,
  EVERYONE_SCOPE,
  requireActorPermission,
  resolveItemScope,
  sameScope,
  scopeLabel,
  scopeNaturalKey,
  scopeUniqueKey,
  previousScopeSpec,
  type TeamScope,
} from "./members-scope-support.js"
import { specObject, teamRef } from "./route-support.js"

const AREA = "members.agent-permissions"

const specSchema = z.object({
  /** null: Everyone. Otherwise the team whose overrides these are. */
  team: configRefSchema.nullable().default(null),
  /** Stored settings per permission; a permission left out allows (Everyone) or inherits Everyone's (a team). */
  settings: agentPermissionSettingsSchema.default({}),
}).strict()

const applySettingsSchema = z.object({ settings: agentPermissionSettingsSchema.default({}) }).passthrough()

type PolicyId = ReturnType<typeof createDenTypeId<"agentPermissionPolicy">>

/** JSON columns arrive as strings on engines like MariaDB (as in agent-permissions.ts). */
function jsonList(value: unknown): unknown {
  if (typeof value !== "string") return value
  try {
    return JSON.parse(value)
  } catch {
    return []
  }
}

function definitionOf(key: string) {
  return agentPermissionDefinitions.find((entry) => entry.key === key) ?? null
}

/** Permissions the target can't edit because their feature is off there. */
export function gatedAgentPermissionKeys(features: Pick<FeatureMap, "agentHarnessPermissions" | "browserUploadPermissions">): Map<AgentPermissionKey, string> {
  const gated = new Map<AgentPermissionKey, string>()
  if (!features.agentHarnessPermissions) for (const key of AGENT_HARNESS_PERMISSION_KEYS) gated.set(key, "agentHarnessPermissions")
  if (!features.browserUploadPermissions) gated.set("browserUploads", "browserUploadPermissions")
  return gated
}

type Database = Pick<ConfigAreaContext["db"], "select">

async function readSettings(database: Database, policyIds: string[]): Promise<Map<string, AgentPermissionSettings>> {
  const out = new Map<string, AgentPermissionSettings>()
  if (policyIds.length === 0) return out
  const rows = await database
    .select()
    .from(AgentPermissionSettingTable)
    .where(inArray(AgentPermissionSettingTable.policyId, policyIds.map((id) => normalizeDenTypeId("agentPermissionPolicy", id))))
  for (const row of rows) {
    const definition = definitionOf(row.permissionKey)
    if (!definition) continue
    const setting = normalizeAgentPermissionSetting(definition, { decision: row.decision, allow: jsonList(row.allowPatterns), block: jsonList(row.blockPatterns) })
    if (!setting) continue
    const settings = out.get(row.policyId) ?? {}
    settings[definition.key] = setting
    out.set(row.policyId, settings)
  }
  return out
}

/** Settings in definition order, so exports are stable. */
function orderedSettings(settings: AgentPermissionSettings): AgentPermissionSettings {
  const out: AgentPermissionSettings = {}
  for (const definition of agentPermissionDefinitions) {
    const setting = settings[definition.key]
    if (setting) out[definition.key] = setting
  }
  return out
}

async function readPolicies(ctx: ConfigAreaContext, ids?: string[]): Promise<ConfigItem[]> {
  const organizationId = normalizeDenTypeId("organization", ctx.organizationId)
  const policyIds = ids?.flatMap((id) => {
    try {
      return [normalizeDenTypeId("agentPermissionPolicy", id)]
    } catch {
      return []
    }
  })
  if (policyIds && policyIds.length === 0) return []
  const policies = await ctx.db
    .select({ id: AgentPermissionPolicyTable.id, teamId: AgentPermissionPolicyTable.teamId, scopeKey: AgentPermissionPolicyTable.scopeKey, teamName: TeamTable.name })
    .from(AgentPermissionPolicyTable)
    .leftJoin(TeamTable, eq(AgentPermissionPolicyTable.teamId, TeamTable.id))
    .where(and(
      eq(AgentPermissionPolicyTable.organizationId, organizationId),
      ...(policyIds ? [inArray(AgentPermissionPolicyTable.id, policyIds)] : []),
    ))
    .orderBy(asc(AgentPermissionPolicyTable.scopeKey), asc(AgentPermissionPolicyTable.id))
  const settings = await readSettings(ctx.db, policies.map((policy) => policy.id))
  const items = policies.flatMap((policy): ConfigItem[] => {
    const spec = { settings: orderedSettings(settings.get(policy.id) ?? {}) }
    if (policy.scopeKey === EVERYONE_SCOPE) return [{ id: policy.id, key: EVERYONE_SCOPE, name: "Everyone", spec: { team: null, ...spec } }]
    // A team that no longer exists has no tab to show its overrides on.
    if (!policy.teamId || policy.teamName === null) return []
    return [{ id: policy.id, key: null, name: policy.teamName, spec: { team: teamRef(policy.teamId, policy.teamName), ...spec } }]
  })
  // Everyone first, then teams by name.
  return items.sort((left, right) => (left.key === EVERYONE_SCOPE ? -1 : right.key === EVERYONE_SCOPE ? 1 : left.name.localeCompare(right.name) || left.id.localeCompare(right.id)))
}

function describeSetting(key: AgentPermissionKey, setting: AgentPermissionSetting | null): string {
  const definition = definitionOf(key)
  const label = definition?.label ?? key
  if (!setting) return `${label}: not set`
  const parts = [setting.decision ? agentPermissionDecisionLabels[setting.decision] : null]
  if (setting.allow?.length) parts.push(`${setting.allow.length} always allowed`)
  if (setting.block?.length) parts.push(`${setting.block.length} always blocked`)
  return `${label}: ${parts.filter((part) => part !== null).join(", ") || "set"}`
}

function sameSetting(left: AgentPermissionSetting | undefined, right: AgentPermissionSetting | null): boolean {
  const a = left ?? null
  if (a === null || right === null) return a === right
  const list = (value: string[] | undefined) => JSON.stringify([...(value ?? [])].sort())
  return (a.decision ?? null) === (right.decision ?? null) && list(a.allow) === list(right.allow) && list(a.block) === list(right.block)
}

/**
 * Writes the named permissions of one scope (null clears one), leaving every
 * other stored permission row untouched. Creates the policy when the first
 * permission is set and removes it when the last one is cleared, as
 * saveAgentPermissionPolicy does.
 */
async function writeScopeSettings(ctx: ConfigAreaContext, input: {
  scope: TeamScope
  desired: Map<AgentPermissionKey, AgentPermissionSetting | null>
  /** Create: the policy must not exist yet; reuse this id for it when free. */
  create?: { preferredId?: string }
  /** Update / delete: the policy being written. */
  policyId?: string
}): Promise<{ policyId: string | null; steps: ConfigApplyStep[] }> {
  const organizationId = normalizeDenTypeId("organization", ctx.organizationId)
  const memberId = normalizeDenTypeId("member", ctx.actor.memberId)
  const scopeKey = input.scope.kind === "everyone" ? EVERYONE_SCOPE : input.scope.teamId
  const label = scopeLabel(input.scope)
  const steps: ConfigApplyStep[] = []
  const capture = currentAuditChangeCapture(ctx.organizationId)
  try {
    return await ctx.db.transaction(async (tx) => {
      const [existing] = await tx
        .select({ id: AgentPermissionPolicyTable.id })
        .from(AgentPermissionPolicyTable)
        .where(and(eq(AgentPermissionPolicyTable.organizationId, organizationId), eq(AgentPermissionPolicyTable.scopeKey, scopeKey)))
        .limit(1)
        .for("update")
      if (input.create && existing) {
        applyFailure({ code: "agent_permissions_exist", message: `${label} already has agent permissions here; match this item to them instead of creating new ones.`, field: "team", status: 409 })
      }
      if (input.policyId && existing?.id !== normalizeDenTypeId("agentPermissionPolicy", input.policyId)) {
        applyFailure({ code: "agent_permissions_not_found", message: `${label}'s agent permissions changed since the plan; analyze again.`, status: 409 })
      }
      const beforeSettings = existing ? (await readSettings(tx, [existing.id])).get(existing.id) ?? {} : {}
      const afterSettings: AgentPermissionSettings = { ...beforeSettings }
      const now = new Date()
      let policyId: PolicyId | null = existing?.id ?? null

      for (const [key, value] of input.desired) {
        const definition = definitionOf(key)
        if (!definition) continue
        const next = value ? normalizeAgentPermissionSetting(definition, value) : null
        if (sameSetting(beforeSettings[key], next)) continue
        const step: ConfigApplyStep = { action: next ? (beforeSettings[key] ? "update" : "set") : "remove", target: key, detail: describeSetting(key, next) }
        if (!next) {
          if (policyId) await tx.delete(AgentPermissionSettingTable).where(and(eq(AgentPermissionSettingTable.policyId, policyId), eq(AgentPermissionSettingTable.permissionKey, key)))
          delete afterSettings[key]
        } else if (beforeSettings[key] && policyId) {
          await tx
            .update(AgentPermissionSettingTable)
            .set({ decision: next.decision ?? null, allowPatterns: next.allow ?? [], blockPatterns: next.block ?? [], updatedAt: now })
            .where(and(eq(AgentPermissionSettingTable.policyId, policyId), eq(AgentPermissionSettingTable.permissionKey, key)))
          afterSettings[key] = next
        } else {
          if (!policyId) {
            const preferred = preferredPolicyId(input.create?.preferredId)
            policyId = preferred ?? createDenTypeId("agentPermissionPolicy")
            await tx.insert(AgentPermissionPolicyTable).values({
              id: policyId,
              organizationId,
              teamId: input.scope.kind === "team" ? normalizeDenTypeId("team", input.scope.teamId) : null,
              scopeKey,
              updatedByOrgMemberId: memberId,
              createdAt: now,
              updatedAt: now,
            })
            steps.push({ action: "create", target: "policy", detail: `${label}'s agent permissions` })
          }
          await tx.insert(AgentPermissionSettingTable).values({
            id: createDenTypeId("agentPermissionSetting"),
            organizationId,
            policyId,
            permissionKey: key,
            decision: next.decision ?? null,
            allowPatterns: next.allow ?? [],
            blockPatterns: next.block ?? [],
            updatedAt: now,
          })
          afterSettings[key] = next
        }
        steps.push(step)
      }

      if (steps.length === 0 && input.create && !policyId) {
        // Nothing settable here (empty, or only permissions whose feature is off): keep the scope's
        // policy row so the item has a local id; it reads as no overrides.
        policyId = preferredPolicyId(input.create.preferredId) ?? createDenTypeId("agentPermissionPolicy")
        await tx.insert(AgentPermissionPolicyTable).values({
          id: policyId,
          organizationId,
          teamId: input.scope.kind === "team" ? normalizeDenTypeId("team", input.scope.teamId) : null,
          scopeKey,
          updatedByOrgMemberId: memberId,
          createdAt: now,
          updatedAt: now,
        })
        return { policyId, steps: [{ action: "create", target: "policy", detail: `${label}'s agent permissions (none set)` }] }
      }
      if (steps.length === 0) return { policyId, steps }
      const startedWith = existing?.id ?? null
      if (policyId && Object.keys(afterSettings).length === 0) {
        await tx.delete(AgentPermissionSettingTable).where(eq(AgentPermissionSettingTable.policyId, policyId))
        await tx.delete(AgentPermissionPolicyTable).where(eq(AgentPermissionPolicyTable.id, policyId))
        steps.push({ action: "delete", target: "policy", detail: `${label} has no agent permissions left` })
        policyId = null
      } else if (policyId && startedWith) {
        await tx.update(AgentPermissionPolicyTable).set({ updatedByOrgMemberId: memberId, updatedAt: now }).where(eq(AgentPermissionPolicyTable.id, policyId))
      }
      const auditScope: AgentPermissionAuditScope = input.scope.kind === "team" ? { kind: "team", teamId: input.scope.teamId, teamName: input.scope.teamName } : { kind: "everyone" }
      await appendDomainChanges(tx, capture, [agentPermissionPolicyChangedEvent(organizationId, auditScope, { policyId: startedWith, settings: beforeSettings }, { policyId, settings: afterSettings })])
      return { policyId, steps }
    })
  } catch (error) {
    // The transaction rolled back: nothing of this item was written.
    throw asItemError(error, [])
  }
}

function preferredPolicyId(id: string | undefined) {
  if (!id) return undefined
  try {
    return normalizeDenTypeId("agentPermissionPolicy", id)
  } catch {
    return undefined
  }
}

/** Permission keys an update's changes name (`settings.<key>…`); every key when the whole settings object changed. */
function changedKeys(changes: readonly { path: string }[]): Set<AgentPermissionKey> {
  const keys = new Set<AgentPermissionKey>()
  for (const change of changes) {
    if (change.path === "settings" || change.path === "(spec)") {
      for (const definition of agentPermissionDefinitions) keys.add(definition.key)
      continue
    }
    if (!change.path.startsWith("settings.")) continue
    const segment = change.path.slice("settings.".length).split(/[.[]/)[0] ?? ""
    const definition = definitionOf(segment)
    if (definition) keys.add(definition.key)
  }
  return keys
}

function parseSettings(spec: { [key: string]: unknown }): AgentPermissionSettings {
  const parsed = applySettingsSchema.safeParse(spec)
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    applyFailure({ code: "invalid_spec", message: issue?.message ?? "The agent permissions are not valid.", field: issue ? issue.path.join(".") : "settings" })
  }
  return parsed.data.settings
}

export const membersAgentPermissionsArea = defineConfigArea({
  key: AREA,
  label: "Agent permissions",
  path: ["Members", "Teams", "Agents"],
  idPrefix: denTypeIdPrefixes.agentPermissionPolicy,
  specVersion: 1,
  specSchema,
  dependsOn: ["members.teams"],
  deployments: ["cloud", "self_hosted"],
  viewPermission: "agent_permissions.view",
  managePermission: "agent_permissions.manage",
  tables: ["agent_permission_policy", "agent_permission_setting"],
  naturalKeys: [{ label: "scope", get: scopeNaturalKey }],
  uniqueFields: [{ label: "scope", get: scopeUniqueKey }],
  // The name is Everyone or the team's: renaming the team is a members.teams change.
  informationalName: true,
  secretFields: [],
  // Every write goes through ctx.db in one transaction (with the audit change).
  transactional: true,
  irreversible: () => [],

  exportItems: (ctx) => readPolicies(ctx),
  readItems: (ctx, ids) => readPolicies(ctx, ids),

  async apply(ctx, op) {
    try {
      await requireActorPermission(ctx, "agent_permissions.manage")
    } catch (error) {
      throw asItemError(error, [])
    }
    const gated = gatedAgentPermissionKeys(ctx.features)
    const warnings: string[] = []

    if (op.kind === "delete") {
      const scope = await resolveItemScope(ctx, previousScopeSpec(op.previous))
      const desired = new Map<AgentPermissionKey, AgentPermissionSetting | null>()
      for (const definition of agentPermissionDefinitions) {
        const flag = gated.get(definition.key)
        if (flag) {
          if (op.previous.spec.settings && isSet(op.previous.spec.settings, definition.key)) warnings.push(`${definition.label} was kept: ${flag} is off here.`)
          continue
        }
        desired.set(definition.key, null)
      }
      const result = await writeScopeSettings(ctx, { scope, desired, policyId: op.targetId })
      return { localId: op.targetId, steps: result.steps, warnings }
    }

    const spec = specObject(op.item.spec)
    const settings = parseSettings(spec)
    const scope = await resolveItemScope(ctx, spec)

    const pick = (keys: Iterable<AgentPermissionKey>) => {
      const desired = new Map<AgentPermissionKey, AgentPermissionSetting | null>()
      for (const key of keys) {
        const flag = gated.get(key)
        if (flag) {
          if (settings[key]) warnings.push(`${definitionOf(key)?.label ?? key} was skipped: ${flag} is off here.`)
          continue
        }
        desired.set(key, settings[key] ?? null)
      }
      return desired
    }

    if (op.kind === "create") {
      const result = await writeScopeSettings(ctx, {
        scope,
        desired: pick(agentPermissionDefinitions.map((definition) => definition.key)),
        create: { preferredId: op.preferredId },
      })
      if (!result.policyId) applyFailure({ code: "unexpected_state", message: `${scopeLabel(scope)}'s agent permissions were not created.` }, result.steps)
      return { localId: result.policyId, steps: result.steps, warnings }
    }

    if (changesScope(op.changes) || !sameScope(scope, previousScopeSpec(op.previous))) {
      applyFailure({ code: "scope_changed", message: "Agent permissions can't move to another team; remove them there and add them to the other team.", field: "team" })
    }
    const result = await writeScopeSettings(ctx, { scope, desired: pick(changedKeys(op.changes)), policyId: op.targetId })
    return { localId: result.policyId ?? op.targetId, steps: result.steps, warnings }
  },
})

function isSet(settings: unknown, key: string): boolean {
  return typeof settings === "object" && settings !== null && !Array.isArray(settings) && key in settings
}
