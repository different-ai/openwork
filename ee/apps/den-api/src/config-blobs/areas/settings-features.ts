/**
 * Config-blob area `settings.features`: the feature flags that are on for the
 * organization.
 *
 * - One item per feature that is EFFECTIVELY ON for the organization as a
 *   whole: `resolveFeature` (packages/features/src/resolve.ts) with this
 *   deployment, its kill switches and operator locks, the stored rollouts and
 *   the organization's overrides, and no member override. So a feature is
 *   exported whether it is on for everyone, locked on by the operator or
 *   turned on for this organization in /admin. Features that are off are
 *   never exported; member overrides never are.
 * - The item id is the feature key (`configBlobs`), its name the registry
 *   label, its spec `{ enabled: true }`: the "key: true" of the request. Keys
 *   are lowerCamelCase, which the item `key` pattern rejects, so the key is
 *   the id (matched by id on any instance) and the natural key.
 * - An import only ever turns features ON, as an organization override set
 *   through `updateOrganizationFeatureOverrides`, the function /admin and
 *   `den_set_org_capability` use (feature_change records the applying user).
 *   Only a platform admin (the /v1/admin check) may: anyone else gets a block
 *   at plan time, so the admin can skip these and apply the rest.
 * - Never turned off: deletes are refused (`protectedFromDelete`), and the
 *   spec is constant, so there is nothing to update.
 * - Skipped at plan time: a key this server doesn't know (or has retired), a
 *   feature not part of this deployment, one whose kill switch is on, one the
 *   operator locked off. `permanent` features are treated like any other:
 *   permanent only says the switch stays in the product, and turning one on
 *   for an organization is what /admin does with it.
 */
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

export const PLATFORM_ADMIN_ONLY_MESSAGE = "Only platform admins can turn on features."
const NEVER_OFF_MESSAGE = "Imports never turn features off."

const featureSpecSchema = z.object({
  /** Always true: only features that are on are exported, and an import only turns features on. */
  enabled: z.literal(true),
}).strict()

const labelToKey = new Map<string, FeatureKey>(FEATURE_KEYS.map((key) => [featureDefinition(key).label.trim().toLowerCase(), key]))
const retiredKeys = new Set<string>(RETIRED_FEATURE_KEYS)

/** The feature an item names: its id when that is a feature key, else a feature whose label is the item's name. */
function featureKeyOf(item: { id?: string; sourceId?: string; name: string }): FeatureKey | null {
  const id = item.sourceId ?? item.id
  if (id !== undefined && isFeatureKey(id)) return id
  return labelToKey.get(item.name.trim().toLowerCase()) ?? null
}

/** What the item names, for messages: its id, else its name. */
function itemLabel(item: { sourceId?: string; name: string }): string {
  return item.sourceId ?? item.name
}

/** Every feature as the organization gets it, without any member's override. Read fresh, never from the cache. */
async function resolveForOrganization(ctx: ConfigAreaContext): Promise<Record<FeatureKey, ResolvedFeature>> {
  // Sequential: ctx.db may be a transaction, which runs one query at a time.
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

/** Why the feature can't be turned on for this organization here, or null when it can. */
function notApplicable(key: FeatureKey, resolved: ResolvedFeature): string | null {
  const label = featureDefinition(key).label
  if (resolved.source === "unavailable") return `${label} isn't part of this deployment.`
  if (resolved.source === "killed") return `${label} is turned off everywhere on this server (kill switch).`
  if (resolved.source === "lock" && !resolved.enabled) return `${label} is locked off by this server's operator (${featureLockEnvName(key)}).`
  return null
}

function unknownKeyReason(item: ResolvedConfigItem): string {
  const label = itemLabel(item)
  return retiredKeys.has(label) ? `${label} is no longer a feature flag on this server.` : `${label} isn't a feature on this server.`
}

export const settingsFeaturesArea = defineConfigArea({
  key: AREA,
  label: "Feature flags",
  path: ["Settings", "Feature flags"],
  // Ids are feature keys, not TypeIDs: a create never reuses a source id as a row id.
  specVersion: 1,
  specSchema: featureSpecSchema,
  dependsOn: [],
  deployments: ["cloud", "self_hosted"],
  viewPermission: "organization.update",
  managePermission: "organization.update",
  // Only the organization's overrides; rollouts, member overrides and history are the platform's.
  tables: ["organization_feature"],
  naturalKeys: [{ label: "feature key", get: (item) => featureKeyOf(item) }],
  // The label comes from the registry of the server reading it: a different label is not a change.
  informationalName: true,
  secretFields: [],
  // updateOrganizationFeatureOverrides opens its own transaction on the global db and clears the feature cache.
  transactional: false,
  externalEffects: false,

  protectedFromDelete: () => NEVER_OFF_MESSAGE,

  // A restore can't turn the feature off again (deletes are refused); a platform admin does that in /admin.
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
    if (!await isAdminRouteUserId(ctx.actor.userId)) return { block: PLATFORM_ADMIN_ONLY_MESSAGE }
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
      // Already on (for everyone, or set since the plan): nothing to write.
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
