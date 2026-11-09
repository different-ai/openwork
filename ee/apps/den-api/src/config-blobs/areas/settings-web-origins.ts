/**
 * Config-blob area `settings.web-origins`: approved web origins.
 *
 * One item per origin; the origin itself is the natural key. Apply calls the
 * same service functions as the routes (organization-web-origins.ts), with the
 * enclosing request's audit change capture and the legacy audit row the routes
 * write. An origin has nothing else to edit: an update that changes it removes
 * the old origin and approves the new one.
 */
import { and, asc, eq, inArray } from "@openwork-ee/den-db/drizzle"
import { OrganizationWebOriginTable } from "@openwork-ee/den-db/schema"
import { denTypeIdPrefixes, normalizeDenTypeId } from "@openwork-ee/utils/typeid"
import { ORGANIZATION_WEB_ORIGIN_LIMIT, normalizeExactHttpsOrigin } from "@openwork/types/den/organization-web-origins"
import type { PermissionKey } from "@openwork/types/den/permissions"
import { z } from "zod"
import { ORGANIZATION_AUDIT_ACTIONS } from "../../audit-events.js"
import { finishLegacyAuditAction } from "../../audit/domain/legacy.js"
import { currentAuditChangeCapture } from "../../audit/request-capture.js"
import { approveOrganizationWebOrigin, removeOrganizationWebOrigin } from "../../organization-web-origins.js"
import { permissionDeniedMessage } from "../../permissions/effective.js"
import { resolvePermissionsForMember } from "../../permissions/resolve.js"
import { defineConfigArea, type ConfigAreaContext, type ConfigItem } from "../area.js"
import { ConfigApplyError, applyWithSteps, specObject, touches } from "./route-support.js"

const AREA = "settings.web-origins"

const webOriginSpecSchema = z.object({
  /** Exact HTTPS origin: scheme, host and optional port. */
  origin: z.string().min(1).max(2048),
}).strict()

function originOf(item: { name: string; spec: { [key: string]: unknown } }): string | null {
  const value = typeof item.spec.origin === "string" ? item.spec.origin : item.name
  return normalizeExactHttpsOrigin(value)
}

function preferredOriginId(id: string | undefined) {
  if (!id) return undefined
  try {
    return normalizeDenTypeId("organizationWebOrigin", id)
  } catch {
    return undefined
  }
}

/** The route's own permission marker (orgPermissionRoute), which the in-process call does not run. */
async function requireActorPermission(ctx: ConfigAreaContext, key: PermissionKey) {
  const held = await resolvePermissionsForMember({
    organizationId: normalizeDenTypeId("organization", ctx.organizationId),
    memberId: normalizeDenTypeId("member", ctx.actor.memberId),
  })
  if (!held.has(key)) throw new ConfigApplyError("forbidden", permissionDeniedMessage(key), 403)
}

async function approve(ctx: ConfigAreaContext, origin: string, preferredId?: string) {
  const organizationId = normalizeDenTypeId("organization", ctx.organizationId)
  const capture = currentAuditChangeCapture(ctx.organizationId)
  const result = await approveOrganizationWebOrigin({
    organizationId,
    origin,
    createdByOrgMemberId: normalizeDenTypeId("member", ctx.actor.memberId),
    id: preferredOriginId(preferredId),
  }, capture)
  if (!result.ok) {
    throw result.reason === "already_approved"
      ? new ConfigApplyError("web_origin_already_approved", `${origin} is already approved.`, 409)
      : new ConfigApplyError("web_origin_limit_reached", `This organization already has ${ORGANIZATION_WEB_ORIGIN_LIMIT} approved web origins.`, 409)
  }
  await finishLegacyAuditAction(capture, {
    organizationId,
    actorUserId: normalizeDenTypeId("user", ctx.actor.userId),
    action: ORGANIZATION_AUDIT_ACTIONS.webOriginApproved,
    payload: { origin },
  }, result.auditEventIds)
  return result.webOrigin.id
}

async function remove(ctx: ConfigAreaContext, id: string, label: string) {
  const organizationId = normalizeDenTypeId("organization", ctx.organizationId)
  const capture = currentAuditChangeCapture(ctx.organizationId)
  const removed = await removeOrganizationWebOrigin({ organizationId, id: normalizeDenTypeId("organizationWebOrigin", id) }, capture)
  if (!removed) throw new ConfigApplyError("web_origin_not_found", `${label} is no longer approved.`, 404)
  await finishLegacyAuditAction(capture, {
    organizationId,
    actorUserId: normalizeDenTypeId("user", ctx.actor.userId),
    action: ORGANIZATION_AUDIT_ACTIONS.webOriginRemoved,
    payload: { origin: removed.origin },
  }, removed.auditEventIds)
}

export const settingsWebOriginsArea = defineConfigArea({
  key: AREA,
  label: "Web origins",
  path: ["Settings", "Web origins"],
  idPrefix: denTypeIdPrefixes.organizationWebOrigin,
  specVersion: 1,
  specSchema: webOriginSpecSchema,
  dependsOn: [],
  deployments: ["cloud", "self_hosted"],
  viewPermission: "web_origins.view",
  managePermission: "web_origins.manage",
  tables: ["organization_web_origin"],
  naturalKeys: [{ label: "origin", get: originOf }],
  uniqueFields: [{ label: "origin", get: originOf }],
  secretFields: [],
  // The service functions open their own transactions on the global db and clear the CORS cache.
  transactional: false,

  async exportItems(ctx) {
    return readOrigins(ctx, null)
  },

  async readItems(ctx, ids) {
    return readOrigins(ctx, ids)
  },

  async apply(ctx, op) {
    return applyWithSteps(async (log) => {
      await requireActorPermission(ctx, "web_origins.manage")
      if (op.kind === "delete") {
        await log.run({ action: "delete", target: "origin", detail: op.previous.name }, () => remove(ctx, op.targetId, op.previous.name))
        return { localId: op.targetId }
      }
      const spec = webOriginSpecSchema.parse(specObject(op.item.spec))
      const origin = normalizeExactHttpsOrigin(spec.origin)
      if (!origin) throw new ConfigApplyError("invalid_web_origin", `${spec.origin} is not an exact HTTPS origin like https://workspace.example.com.`, 400, "origin")

      if (op.kind === "create") {
        return { localId: await log.run({ action: "create", target: "origin", detail: origin }, () => approve(ctx, origin, op.preferredId)) }
      }

      // The origin is the only field: an update that changes it replaces the row.
      if (!touches(op.changes, "origin") || originOf(op.previous) === origin) return { localId: op.targetId }
      await log.run({ action: "remove", target: "origin", detail: op.previous.name }, () => remove(ctx, op.targetId, op.previous.name))
      const localId = await log.run({ action: "add", target: "origin", detail: origin }, () => approve(ctx, origin))
      return { localId, warnings: [`${op.previous.name} was replaced by ${origin}.`] }
    })
  },
})

async function readOrigins(ctx: ConfigAreaContext, ids: readonly string[] | null): Promise<ConfigItem[]> {
  const originIds = ids?.flatMap((id) => preferredOriginId(id) ?? []) ?? null
  if (originIds && originIds.length === 0) return []
  const rows = await ctx.db
    .select({ id: OrganizationWebOriginTable.id, origin: OrganizationWebOriginTable.origin })
    .from(OrganizationWebOriginTable)
    .where(and(
      eq(OrganizationWebOriginTable.organizationId, normalizeDenTypeId("organization", ctx.organizationId)),
      originIds ? inArray(OrganizationWebOriginTable.id, originIds) : undefined,
    ))
    .orderBy(asc(OrganizationWebOriginTable.origin), asc(OrganizationWebOriginTable.id))
  return rows.map((row): ConfigItem => ({ id: row.id, name: row.origin, spec: { origin: row.origin } }))
}
