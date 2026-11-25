import { describeFeatures, readFeatureRollouts, readOrganizationFeatureOverrides } from "@openwork-ee/den-db/organization-features"
import { normalizeDenTypeId } from "@openwork-ee/utils/typeid"
import {
  FEATURE_KEYS,
  RETIRED_FEATURE_KEYS,
  featureDefinition,
  featureLockEnvName,
  isFeatureKey,
  type FeatureKey,
  type ResolvedFeature,
} from "@openwork/features"
import { z } from "zod"
import { env } from "../../env.js"
import { updateOrganizationFeatureOverrides } from "../../features.js"
import { isAdminRouteUserId } from "../../middleware/admin.js"
import { defineConfigArea, type ConfigAreaContext, type ConfigItem, type ResolvedConfigItem } from "../area.js"
import { ConfigApplyError, applyWithSteps } from "./route-support.js"

const AREA = "settings.features"

export const PLATFORM_ADMIN_ONLY_MESSAGE = "Only platform admins can turn on preview flags."
const NEVER_OFF_MESSAGE = "Imports never turn preview flags off."

function platformAdminOnlyReason(key: FeatureKey): string {
  return `${featureDefinition(key).label} stays off here: only a platform admin can turn a preview flag on. Ask one to turn it on, then import this file again for the settings that need it.`
}

const featureSpecSchema = z.object({
  enabled: z.literal(true),
}).strict()

const labelToKey = new Map<string, FeatureKey>(FEATURE_KEYS.map((key) => [featureDefinition(key).label.trim().toLowerCase(), key]))
const retiredKeys = new Set<string>(RETIRED_FEATURE_KEYS)

function featureKeyOf(item: { id?: string; sourceId?: string; name: string }): FeatureKey | null {
  const id = item.sourceId ?? item.id
  if (id !== undefined && isFeatureKey(id)) return id
  return labelToKey.get(item.name.trim().toLowerCase()) ?? null
}

function itemLabel(item: { sourceId?: string; name: string }): string {
  return item.sourceId ?? item.name
}

async function resolveForOrganization(ctx: ConfigAreaContext): Promise<Record<FeatureKey, ResolvedFeature>> {
  const rollouts = await readFeatureRollouts(ctx.db)
  const overrides = await readOrganizationFeatureOverrides(ctx.db, normalizeDenTypeId("organization", ctx.organizationId))
  return describeFeatures({ rollouts, overrides, environment: env.features })
}

function toItem(key: FeatureKey): ConfigItem {
  return { id: key, name: featureDefinition(key).label, spec: { enabled: true } }
}

async function readOn(ctx: ConfigAreaContext, ids: readonly string[] | null): Promise<ConfigItem[]> {
  const wanted = ids ? new Set(ids) : null
  const resolved = await resolveForOrganization(ctx)
  return FEATURE_KEYS
    .filter((key) => resolved[key].enabled && (!wanted || wanted.has(key)))
    .sort()
    .map(toItem)
}

function notApplicable(key: FeatureKey, resolved: ResolvedFeature): string | null {
  const label = featureDefinition(key).label
  if (resolved.source === "unavailable") return `${label} isn't part of this deployment.`
  if (resolved.source === "killed") return `${label} is turned off everywhere on this server (kill switch).`
  if (resolved.source === "lock" && !resolved.enabled) return `${label} is locked off by this server's operator (${featureLockEnvName(key)}).`
  return null
}

function unknownKeyReason(item: ResolvedConfigItem): string {
  const label = itemLabel(item)
  return retiredKeys.has(label) ? `${label} is no longer a preview flag on this server: it shipped or was removed.` : `${label} isn't a preview flag on this server.`
}

export const settingsFeaturesArea = defineConfigArea({
  key: AREA,
  label: "Preview flags",
  path: ["Settings", "Preview flags"],
  specVersion: 1,
  specSchema: featureSpecSchema,
  dependsOn: [],
  deployments: ["cloud", "self_hosted"],
  viewPermission: "organization.update",
  managePermission: "organization.update",
  tables: ["organization_feature"],
  naturalKeys: [{ label: "preview flag key", get: (item) => featureKeyOf(item) }],
  informationalName: true,
  secretFields: [],
  transactional: false,
  externalEffects: false,

  protectedFromDelete: () => NEVER_OFF_MESSAGE,

  irreversible: (op) => {
    if (op.kind !== "create") return []
    const key = featureKeyOf(op.item)
    const label = key ? featureDefinition(key).label : itemLabel(op.item)
    return [`Turns on ${label} for everyone in this organization. Restoring this change doesn't turn it off; a platform admin can, in /admin.`]
  },

  exportItems: (ctx) => readOn(ctx, null),
  readItems: (ctx, ids) => readOn(ctx, ids),

  async preflight(ctx, op) {
    if (op.kind === "delete") return { skip: NEVER_OFF_MESSAGE }
    if (op.kind !== "create") return null
    const key = featureKeyOf(op.item)
    if (!key) return { skip: unknownKeyReason(op.item) }
    const resolved = (await resolveForOrganization(ctx))[key]
    const reason = notApplicable(key, resolved)
    if (reason) return { skip: reason }
    if (resolved.enabled) return { skip: `${featureDefinition(key).label} is already on here.` }
    if (!await isAdminRouteUserId(ctx.actor.userId)) return { skip: platformAdminOnlyReason(key) }
    return null
  },

  async apply(ctx, op) {
    return applyWithSteps(async (log) => {
      if (op.kind === "delete") throw new ConfigApplyError("feature_never_turned_off", NEVER_OFF_MESSAGE, 400)
      if (!await isAdminRouteUserId(ctx.actor.userId)) throw new ConfigApplyError("forbidden", PLATFORM_ADMIN_ONLY_MESSAGE, 403)
      featureSpecSchema.parse(op.item.spec)
      const key = featureKeyOf(op.item)
      if (!key) throw new ConfigApplyError("unknown_feature", unknownKeyReason(op.item), 400)
      if (op.kind === "update") return { localId: key }

      const resolved = (await resolveForOrganization(ctx))[key]
      const reason = notApplicable(key, resolved)
      if (reason) throw new ConfigApplyError("feature_unavailable", reason, 409)
      if (resolved.enabled) return { localId: key }
      await log.run({ action: "set", target: key, detail: "on" }, () => updateOrganizationFeatureOverrides({
        organizationId: normalizeDenTypeId("organization", ctx.organizationId),
        changes: { [key]: true },
        source: "platform",
        setByUserId: normalizeDenTypeId("user", ctx.actor.userId),
      }))
      return { localId: key }
    })
  },
})
