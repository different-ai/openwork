/**
 * `desktop-policies`: desktop policies and who they apply to.
 *
 * Exported per policy: name, whether it is the default policy, enabled,
 * priority, the normalized policy document (settings, access limits,
 * execution restrictions, onboarding prompts) and its assignments (roles,
 * teams, people by email). Nothing in a policy is secret.
 *
 * The default policy exists in every organization and matches by the natural
 * key "default". As in the dashboard, only its document can change: its name,
 * priority and assignments are fixed and it can't be disabled or deleted.
 *
 * Applies through the same handlers as POST/PATCH/DELETE /v1/desktop-policies
 * (`createDesktopPolicy`, `updateDesktopPolicy`, `deleteDesktopPolicy`),
 * including the Enterprise plan check.
 */
import { and, eq, inArray, isNull } from "@openwork-ee/den-db/drizzle"
import { DesktopPolicyMemberTable, DesktopPolicyTable } from "@openwork-ee/den-db/schema"
import { normalizeDenTypeId } from "@openwork-ee/utils/typeid"
import {
  desktopPolicyDocumentWriteSchema,
  normalizeDefaultDesktopPolicyDocument,
  normalizeDesktopPolicyDocument,
} from "@openwork/types/den/desktop-policies"
import { z } from "zod"
import { ensureDefaultDesktopPolicyForOrganization } from "../../desktop-policies.js"
import {
  createDesktopPolicy,
  deleteDesktopPolicy,
  updateDesktopPolicy,
  type DesktopPolicyWriteInput,
} from "../../routes/org/desktop-policies.js"
import { defineConfigArea, type ConfigApplyResult, type ConfigItem } from "../area.js"
import {
  ConfigApplyError,
  audienceRefs,
  configRouteContext,
  expectRouteOk,
  isJsonObject,
  loadMemberEmails,
  loadTeamNames,
  resolvedRefIds,
  specAudienceSchema,
  specObject,
  stringField,
} from "./route-support.js"

const AREA = "desktop-policies"
const ROLES = ["owner", "admin", "member"] as const
type AssignmentRole = (typeof ROLES)[number]

function isAssignmentRole(value: unknown): value is AssignmentRole {
  return value === "owner" || value === "admin" || value === "member"
}

const specSchema = z.object({
  isDefault: z.boolean(),
  enabled: z.boolean(),
  priority: z.number().int().min(0).max(1_000_000),
  policy: desktopPolicyDocumentWriteSchema.strict(),
  assignments: specAudienceSchema.extend({ roles: z.array(z.enum(ROLES)).max(10) }).strict(),
}).strict()

const applySpecSchema = z.object({
  isDefault: z.boolean(),
  enabled: z.boolean(),
  priority: z.number().int().min(0).max(1_000_000),
  policy: desktopPolicyDocumentWriteSchema,
  assignments: z.object({ roles: z.array(z.enum(ROLES)) }).passthrough(),
}).passthrough()

export const desktopPoliciesArea = defineConfigArea({
  key: AREA,
  label: "Desktop policies",
  path: ["Desktop policies"],
  specVersion: 1,
  specSchema,
  dependsOn: ["members.teams", "members.people"],
  deployments: ["cloud", "self_hosted"],
  viewPermission: "desktop_policies.view",
  managePermission: "desktop_policies.manage",
  tables: ["desktop_policy", "desktop_policy_member"],
  naturalKeys: [{
    label: "default policy",
    get: (item) => item.spec.isDefault === true ? "default" : null,
  }],
  secretFields: [],
  orderedArrays: ["policy.onboardingPrompts", "policy.onboardingPromptDescriptions"],
  transactional: false,
  protectedFromDelete: (item) => item.spec.isDefault === true ? "The default desktop policy can't be deleted." : null,

  async exportItems(ctx) {
    const organizationId = normalizeDenTypeId("organization", ctx.organizationId)
    const policies = await ctx.db
      .select()
      .from(DesktopPolicyTable)
      .where(and(eq(DesktopPolicyTable.organizationId, organizationId), isNull(DesktopPolicyTable.deletedAt)))
    if (policies.length === 0) return []
    const assignments = await ctx.db
      .select()
      .from(DesktopPolicyMemberTable)
      .where(inArray(DesktopPolicyMemberTable.desktopPolicyId, policies.map((policy) => policy.id)))
    const [teamNames, memberEmails] = await Promise.all([
      loadTeamNames(ctx.db, organizationId, assignments.flatMap((row) => row.teamId ? [row.teamId] : [])),
      loadMemberEmails(ctx.db, organizationId, assignments.flatMap((row) => row.orgMemberId ? [row.orgMemberId] : [])),
    ])

    const items: ConfigItem[] = policies.map((policy) => {
      const isDefault = policy.isDefault === true
      const rows = assignments.filter((row) => row.desktopPolicyId === policy.id)
      return {
        id: policy.id,
        key: policy.externalKey,
        name: policy.policyName,
        spec: {
          isDefault,
          enabled: isDefault ? true : policy.isEnabled === true,
          priority: policy.priority,
          policy: isDefault ? normalizeDefaultDesktopPolicyDocument(policy.policy) : normalizeDesktopPolicyDocument(policy.policy),
          assignments: {
            roles: [...new Set(rows.flatMap((row) => isAssignmentRole(row.role) ? [row.role] : []))].sort(),
            ...audienceRefs({
              teamIds: rows.flatMap((row) => row.teamId ? [row.teamId] : []),
              memberIds: rows.flatMap((row) => row.orgMemberId ? [row.orgMemberId] : []),
              teamNames,
              memberEmails,
            }),
          },
        },
      }
    })
    return items.sort((left, right) => Number(right.spec.isDefault) - Number(left.spec.isDefault) || left.name.localeCompare(right.name) || left.id.localeCompare(right.id))
  },

  async apply(ctx, op): Promise<ConfigApplyResult> {
    const { c, payload } = await configRouteContext(ctx)

    if (op.kind === "delete") {
      const response = await deleteDesktopPolicy(c, payload, op.targetId)
      if (response.status === 404) return { localId: op.targetId, warnings: ["The policy was already removed."] }
      await expectRouteOk(response, `Remove "${op.previous.name}"`)
      return { localId: op.targetId }
    }

    const raw = specObject(op.item.spec)
    const parsed = applySpecSchema.safeParse(raw)
    if (!parsed.success) throw new ConfigApplyError("invalid_spec", parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; "))
    const spec = parsed.data
    const assignments = isJsonObject(raw.assignments) ? raw.assignments : {}
    const warnings: string[] = []
    const input: DesktopPolicyWriteInput = {
      policyName: op.item.name,
      policy: spec.policy,
      priority: spec.priority,
      isEnabled: spec.enabled,
      roles: spec.assignments.roles,
      memberIds: resolvedRefIds(assignments.members, "assignments.members").map((id) => normalizeDenTypeId("member", id)),
      teamIds: resolvedRefIds(assignments.teams, "assignments.teams").map((id) => normalizeDenTypeId("team", id)),
    }

    let targetId = op.kind === "update" ? op.targetId : null
    if (op.kind === "create" && spec.isDefault) {
      // Every organization has exactly one default policy: an unmatched one in a blob updates it.
      targetId = await ensureDefaultDesktopPolicyForOrganization({ organizationId: payload.organization.id, createdByOrgMemberId: payload.currentMember.id })
      warnings.push("Applied to this organization's existing default policy.")
    }
    if (targetId) {
      const [existing] = await ctx.db.select().from(DesktopPolicyTable).where(and(
        eq(DesktopPolicyTable.id, normalizeDenTypeId("desktopPolicy", targetId)),
        eq(DesktopPolicyTable.organizationId, payload.organization.id),
      )).limit(1)
      if (!existing) throw new ConfigApplyError("desktop_policy_not_found", `The policy "${op.item.name}" no longer exists.`, 404)
      if (existing.isDefault === true && (spec.assignments.roles.length > 0 || input.memberIds.length > 0 || input.teamIds.length > 0)) {
        warnings.push("The default policy applies to everyone; its assignments were not changed.")
      }
      if (existing.isDefault !== true && spec.isDefault) warnings.push("Only the organization's own default policy can be the default; this policy stays a custom one.")
      if ((op.item.key ?? null) !== (existing.externalKey ?? null) && op.kind === "update") warnings.push("A policy's key can't change; the existing key was kept.")
      // Full replacement, like the keyed PUT: omitted onboarding prompts are not kept.
      await expectRouteOk(await updateDesktopPolicy(c, payload, existing.id, input, true), `Update "${op.item.name}"`)
      return { localId: existing.id, ...(warnings.length > 0 ? { warnings } : {}) }
    }

    if (op.kind !== "create") throw new ConfigApplyError("invalid_op", "Unexpected apply operation.")
    const created = await expectRouteOk(await createDesktopPolicy(
      c, payload, input, op.item.key ?? undefined,
      op.preferredId ? normalizeDenTypeId("desktopPolicy", op.preferredId) : undefined,
    ), `Create "${op.item.name}"`)
    return { localId: stringField(created, "desktopPolicy", "id"), ...(warnings.length > 0 ? { warnings } : {}) }
  },
})
