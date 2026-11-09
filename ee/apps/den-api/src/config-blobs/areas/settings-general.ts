/**
 * Config-blob area `settings.general`: one item holding the organization's
 * general settings that can move between organizations.
 *
 * - Carried: allowed email domains, allowed desktop versions, which kinds of
 *   Automations are allowed, and the legacy `desktopAppRestrictions` (read
 *   only: Desktop policies replaced it and nothing writes it any more).
 * - Never carried: name, slug, SSO requirements and session settings. They are
 *   the target organization's identity and sign-in policy (decision D5).
 * - The item id is the organization id; it matches across organizations by
 *   its natural key (there is always exactly one). A "create" therefore
 *   updates the target's settings, and delete is refused.
 * - Apply goes through PATCH /v1/org's own function (routes/org/core.ts
 *   updateOrganizationAction: domain validation, the plan check for version
 *   pinning) and the Automation settings service.
 */
import { eq } from "@openwork-ee/den-db/drizzle"
import { OrganizationTable } from "@openwork-ee/den-db/schema"
import { normalizeDenTypeId } from "@openwork-ee/utils/typeid"
import { readOrganizationAutomationSettings } from "@openwork/types/den/automation-settings"
import { desktopAppRestrictionsSchema, normalizeDesktopAppRestrictions } from "@openwork/types/den/desktop-app-restrictions"
import type { PermissionKey } from "@openwork/types/den/permissions"
import { z } from "zod"
import { normalizeOrganizationMetadata } from "../../organization-limits.js"
import { normalizeAllowedEmailDomains } from "../../orgs.js"
import { saveOrganizationAutomationSettings } from "../../routes/org/automation-settings.js"
import { updateOrganizationAction } from "../../routes/org/core.js"
import { permissionDeniedMessage } from "../../permissions/effective.js"
import { resolvePermissionsForMember } from "../../permissions/resolve.js"
import { defineConfigArea, type ConfigAreaContext, type ConfigItem } from "../area.js"
import { ConfigApplyError, applyWithSteps, configRouteContext, expectRouteOk, specObject, touches } from "./route-support.js"

const AREA = "settings.general"
const ITEM_NAME = "General settings"
const NATURAL_KEY = "organization"

const generalSpecSchema = z.object({
  /** Null: anyone can be invited. */
  allowedEmailDomains: z.array(z.string().min(1).max(255)).max(100).nullable(),
  /** Null: every desktop version may connect. */
  allowedDesktopVersions: z.array(z.string().min(1).max(32)).max(200).nullable(),
  automations: z.object({ desktop: z.boolean(), cloud: z.boolean() }).strict(),
  /** Legacy, read only. Replaced by Desktop policies. */
  desktopAppRestrictions: desktopAppRestrictionsSchema.strict(),
}).strict()

type GeneralSpec = z.infer<typeof generalSpecSchema>

function sortedOrNull(values: readonly string[] | null | undefined): string[] | null {
  return values ? [...values].sort() : null
}

function sameList(left: readonly string[] | null, right: readonly string[] | null): boolean {
  if (left === null || right === null) return left === right
  return JSON.stringify(sortedOrNull(left)) === JSON.stringify(sortedOrNull(right))
}

/** The route's own permission marker (orgPermissionRoute), which the in-process call does not run. */
async function requireActorPermission(ctx: ConfigAreaContext, key: PermissionKey) {
  const held = await resolvePermissionsForMember({
    organizationId: normalizeDenTypeId("organization", ctx.organizationId),
    memberId: normalizeDenTypeId("member", ctx.actor.memberId),
  })
  if (!held.has(key)) throw new ConfigApplyError("forbidden", permissionDeniedMessage(key), 403)
}

async function readSpec(ctx: ConfigAreaContext): Promise<GeneralSpec> {
  const [row] = await ctx.db
    .select({ allowedEmailDomains: OrganizationTable.allowedEmailDomains, metadata: OrganizationTable.metadata, desktopAppRestrictions: OrganizationTable.desktopAppRestrictions })
    .from(OrganizationTable)
    .where(eq(OrganizationTable.id, normalizeDenTypeId("organization", ctx.organizationId)))
    .limit(1)
  if (!row) throw new ConfigApplyError("organization_not_found", "The organization no longer exists.", 404)
  const metadata = normalizeOrganizationMetadata(row.metadata).metadata
  const storedDomains = Array.isArray(row.allowedEmailDomains) ? row.allowedEmailDomains.filter((entry) => typeof entry === "string") : null
  return {
    allowedEmailDomains: sortedOrNull(normalizeAllowedEmailDomains(storedDomains).domains),
    allowedDesktopVersions: sortedOrNull(metadata.allowedDesktopVersions),
    automations: readOrganizationAutomationSettings(row.metadata),
    desktopAppRestrictions: normalizeDesktopAppRestrictions(row.desktopAppRestrictions),
  }
}

export const settingsGeneralArea = defineConfigArea({
  key: AREA,
  label: "General",
  path: ["Settings", "General"],
  specVersion: 1,
  specSchema: generalSpecSchema,
  dependsOn: [],
  deployments: ["cloud", "self_hosted"],
  viewPermission: "organization.update",
  managePermission: "organization.update",
  // organization: allowed_email_domains, desktop_app_restrictions and metadata (allowedDesktopVersions, automations).
  tables: ["organization"],
  naturalKeys: [{ label: "organization", get: () => NATURAL_KEY }],
  secretFields: [],
  // updateOrganizationSettings / updateOrganizationMetadata open their own transactions on the global db.
  transactional: false,
  protectedFromDelete: () => "Organization settings can't be deleted.",

  async exportItems(ctx): Promise<ConfigItem[]> {
    return [{ id: ctx.organizationId, name: ITEM_NAME, spec: await readSpec(ctx) }]
  },

  async readItems(ctx, ids): Promise<ConfigItem[]> {
    return ids.includes(ctx.organizationId) ? [{ id: ctx.organizationId, name: ITEM_NAME, spec: await readSpec(ctx) }] : []
  },

  async apply(ctx, op) {
    return applyWithSteps(async (log) => {
      await requireActorPermission(ctx, "organization.update")
      if (op.kind === "delete") throw new ConfigApplyError("not_deletable", "Organization settings can't be deleted.", 400)
      const next = generalSpecSchema.parse(specObject(op.item.spec))
      const current = await readSpec(ctx)
      const warnings: string[] = []
      const localId = ctx.organizationId
      // A create (the one settings item matched nothing) compares every field with the target.
      const inScope = (path: string) => op.kind === "create" || touches(op.changes, path)

      const domainsChange = inScope("allowedEmailDomains") && !sameList(current.allowedEmailDomains, next.allowedEmailDomains)
      const versionsChange = inScope("allowedDesktopVersions") && !sameList(current.allowedDesktopVersions, next.allowedDesktopVersions)
      if (domainsChange || versionsChange) {
        const { c, payload } = await configRouteContext(ctx)
        // PATCH /v1/org with only the changed setting: the other one is not resent.
        if (domainsChange) {
          await log.run({ action: "set", target: "allowedEmailDomains", detail: next.allowedEmailDomains?.join(", ") ?? "anyone" }, async () => {
            await expectRouteOk(await updateOrganizationAction(c, payload, { allowedEmailDomains: next.allowedEmailDomains }), "Update allowed email domains")
          })
        }
        if (versionsChange) {
          await log.run({ action: "set", target: "allowedDesktopVersions", detail: next.allowedDesktopVersions?.join(", ") ?? "every version" }, async () => {
            await expectRouteOk(await updateOrganizationAction(c, payload, { allowedDesktopVersions: next.allowedDesktopVersions }), "Update allowed desktop versions")
          })
        }
      }

      const automationChanges = {
        ...(inScope("automations.desktop") && current.automations.desktop !== next.automations.desktop ? { desktop: next.automations.desktop } : {}),
        ...(inScope("automations.cloud") && current.automations.cloud !== next.automations.cloud ? { cloud: next.automations.cloud } : {}),
      }
      if (Object.keys(automationChanges).length > 0) {
        const field = automationChanges.desktop !== undefined && automationChanges.cloud === undefined ? "automations.desktop"
          : automationChanges.cloud !== undefined && automationChanges.desktop === undefined ? "automations.cloud"
          : "automations"
        await log.run({ action: "set", target: field, detail: Object.entries(automationChanges).map(([kind, on]) => `${kind} ${on ? "on" : "off"}`).join(", ") }, async () => {
          // Only the kinds that change: turning Cloud on needs the deployment's headless runner.
          const saved = await saveOrganizationAutomationSettings(normalizeDenTypeId("organization", ctx.organizationId), automationChanges)
          if (!saved.ok) throw new ConfigApplyError(saved.error, saved.message, 409)
        }, field)
      }

      if (inScope("desktopAppRestrictions") && JSON.stringify(normalizeDesktopAppRestrictions(next.desktopAppRestrictions)) !== JSON.stringify(current.desktopAppRestrictions)) {
        warnings.push("Desktop app restrictions are a legacy setting replaced by Desktop policies; they were not changed.")
      }
      return { localId, warnings }
    })
  },
})
