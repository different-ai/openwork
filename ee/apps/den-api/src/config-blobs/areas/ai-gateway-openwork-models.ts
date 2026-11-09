/**
 * Config-blob area `ai-gateway.openwork-models`: the OpenWork Models settings
 * an admin can set (Manage › AI Gateway › OpenWork Models). Cloud only:
 * managed inference does not exist on self-hosted servers.
 *
 * One item (id: the organization id, matched by its natural key):
 * - `autoOffered`: whether members get the free Auto model (the "Turn off"
 *   switch for an organization without a subscription;
 *   metadata.inferenceFree.offerAllowed).
 * - `autoPinned`: the organization's Auto pin in members' model pickers
 *   (metadata.inferenceFree.defaultPinned).
 *
 * Not carried, on purpose:
 * - paid OpenWork Models on/off and tier: they follow the organization's
 *   Stripe subscription and can't be copied to another organization;
 * - `inference_org_limit_policies` / `_usage_buckets`: derived by the server
 *   from the subscription tier and member count, not set by admins;
 * - `inference_org_upstream_provider_keys`: an OpenRouter key OpenWork
 *   provisions per organization with its own management key. Admins never
 *   see or enter it, so it is not even a `$secret` placeholder.
 *
 * Apply goes through the same functions as PATCH /v1/inference and
 * PATCH /v1/inference/free/pins (routes/org/inference.ts).
 */
import { eq } from "@openwork-ee/den-db/drizzle"
import { OrganizationTable } from "@openwork-ee/den-db/schema"
import { normalizeDenTypeId } from "@openwork-ee/utils/typeid"
import type { ConfigApplyStep, ConfigFieldChange } from "@openwork/types/den/config-blobs"
import { freeInferenceDefaultPinned, freeInferenceOrganizationAllowed, inferenceSubscribed, withFreeInferenceDefaultPinned } from "@openwork/types/den/inference"
import { ManagedModelsPolicyError } from "@openwork/types/den/managed-models-policy"
import { z } from "zod"
import { allowFreeInferenceOffer, setInferenceEnabled } from "../../inference.js"
import { assertOrganizationManagedModelsAllowed, updateOrganizationMetadata } from "../../organization-metadata.js"
import { permissionDeniedMessage } from "../../permissions/effective.js"
import { resolvePermissionsForMember } from "../../permissions/resolve.js"
import { ConfigApplyItemError, defineConfigArea, type ConfigApplyOp, type ConfigAreaContext, type ConfigItem } from "../area.js"
import { ConfigApplyError, specObject } from "./route-support.js"

const AREA = "ai-gateway.openwork-models" as const
const ITEM_NAME = "OpenWork Models"
const NATURAL_KEY = "organization"

const openworkModelsSpecSchema = z.object({
  /** Members get the free Auto model. Off also revokes members' OpenWork Models keys. */
  autoOffered: z.boolean().default(true),
  /** Auto is pinned in members' model pickers by the organization. */
  autoPinned: z.boolean().default(false),
}).strict()

type OpenWorkModelsSpec = z.infer<typeof openworkModelsSpecSchema>

async function readMetadata(ctx: ConfigAreaContext): Promise<Record<string, unknown> | null> {
  const [row] = await ctx.db.select({ metadata: OrganizationTable.metadata }).from(OrganizationTable)
    .where(eq(OrganizationTable.id, normalizeDenTypeId("organization", ctx.organizationId))).limit(1)
  if (!row) throw new ConfigApplyError("organization_not_found", "The organization no longer exists.", 404)
  return row.metadata
}

function specFrom(metadata: unknown): OpenWorkModelsSpec {
  return { autoOffered: freeInferenceOrganizationAllowed(metadata), autoPinned: freeInferenceDefaultPinned(metadata) }
}

async function exportItems(ctx: ConfigAreaContext): Promise<ConfigItem[]> {
  return [{ id: ctx.organizationId, key: null, name: ITEM_NAME, spec: specFrom(await readMetadata(ctx)) }]
}

function touches(changes: ConfigFieldChange[], field: string): boolean {
  return changes.some((change) => change.path === field || change.path.startsWith(`${field}.`))
}

function failure(error: unknown, done: ConfigApplyStep[], step?: ConfigApplyStep, field?: string): ConfigApplyItemError {
  if (error instanceof ConfigApplyItemError) return error
  const code = error instanceof ConfigApplyError || error instanceof ManagedModelsPolicyError ? error.code : "apply_failed"
  const status = error instanceof ConfigApplyError || error instanceof ManagedModelsPolicyError ? error.status : undefined
  const message = error instanceof Error ? error.message : String(error)
  return new ConfigApplyItemError({ code, message, ...(field ? { field } : {}), ...(step ? { step } : {}), ...(status ? { status } : {}) }, [...done])
}

async function apply(ctx: ConfigAreaContext, op: ConfigApplyOp) {
  const done: ConfigApplyStep[] = []
  const organizationId = normalizeDenTypeId("organization", ctx.organizationId)
  try {
    if (op.kind === "delete") throw new ConfigApplyError("not_deletable", "OpenWork Models settings can't be deleted.", 400)
    const held = await resolvePermissionsForMember({ organizationId, memberId: normalizeDenTypeId("member", ctx.actor.memberId) })
    if (!held.has("inference.manage")) throw new ConfigApplyError("forbidden", permissionDeniedMessage("inference.manage"), 403)
    const next = openworkModelsSpecSchema.parse(specObject(op.item.spec))
    const metadata = await readMetadata(ctx)
    const current = specFrom(metadata)
    // A create is the target's own singleton matched by its natural key: compare with what it has.
    const wants = (field: keyof OpenWorkModelsSpec) => (op.kind === "create" || touches(op.changes, field)) && current[field] !== next[field]
    const warnings: string[] = []

    if (wants("autoOffered")) {
      const step: ConfigApplyStep = { action: "set", target: "autoOffered", detail: next.autoOffered ? "on" : "off" }
      try {
        if (next.autoOffered) {
          await assertOrganizationManagedModelsAllowed(organizationId)
          await allowFreeInferenceOffer(organizationId)
          if (!freeInferenceOrganizationAllowed(await readMetadata(ctx))) warnings.push("Auto is still off for this organization; turn it on from OpenWork Models.")
        } else {
          // Turning it off here would also turn off a paid subscription's models: leave that to the OpenWork Models page.
          if (inferenceSubscribed(metadata)) throw new ConfigApplyError("subscribed", "This organization subscribes to OpenWork Models; turning Auto off would turn off its paid models too. Do it from OpenWork Models.", 409)
          await setInferenceEnabled({ organizationId, enabled: false, source: "admin" })
        }
      } catch (error) {
        throw failure(error, done, step, "autoOffered")
      }
      done.push(step)
    }

    if (wants("autoPinned")) {
      const step: ConfigApplyStep = { action: "set", target: "autoPinned", detail: next.autoPinned ? "pinned" : "unpinned" }
      try {
        await updateOrganizationMetadata(organizationId, (value) => withFreeInferenceDefaultPinned(value, next.autoPinned))
      } catch (error) {
        throw failure(error, done, step, "autoPinned")
      }
      done.push(step)
    }
    return { localId: ctx.organizationId, warnings, steps: done }
  } catch (error) {
    throw failure(error, done)
  }
}

function irreversible(op: ConfigApplyOp): string[] {
  if (op.kind === "delete") return []
  const next = openworkModelsSpecSchema.safeParse(op.item.spec)
  if (!next.success || next.data.autoOffered) return []
  if (op.kind === "update" && !touches(op.changes, "autoOffered")) return []
  return ["Turning Auto off revokes members' OpenWork Models keys and removes the OpenWork provider from their desktops; turning it back on issues new keys."]
}

export const aiGatewayOpenWorkModelsArea = defineConfigArea({
  key: AREA,
  label: "OpenWork Models",
  path: ["AI Gateway", "OpenWork Models"],
  specVersion: 1,
  specSchema: openworkModelsSpecSchema,
  dependsOn: [],
  deployments: ["cloud"],
  viewPermission: "inference.view",
  managePermission: "inference.manage",
  // Settings live in organization.metadata (inferenceFree), owned by the organization row.
  // inference_org_limit_policies (derived from tier and member count) and
  // inference_org_upstream_provider_keys (provisioned by OpenWork) are not admin configuration.
  tables: [],
  naturalKeys: [{ label: "organization", get: () => NATURAL_KEY }],
  secretFields: [],
  // updateOrganizationMetadata / setInferenceEnabled open their own transactions on the global db.
  transactional: false,
  // Turning Auto off deletes the organization's upstream OpenRouter key.
  externalEffects: true,
  protectedFromDelete: () => "OpenWork Models settings can't be deleted.",
  irreversible,

  exportItems,
  async readItems(ctx, ids) {
    return ids.includes(ctx.organizationId) ? exportItems(ctx) : []
  },
  apply,
})
