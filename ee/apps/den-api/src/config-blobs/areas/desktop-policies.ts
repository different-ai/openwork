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
import { denTypeIdPrefixes, normalizeDenTypeId } from "@openwork-ee/utils/typeid"
import {
  desktopPolicyDocumentWriteSchema,
  normalizeDefaultDesktopPolicyDocument,
  normalizeDesktopPolicyDocument,
} from "@openwork/types/den/desktop-policies"
import type { ConfigApplyStep, ConfigFieldChange } from "@openwork/types/den/config-blobs"
import { z } from "zod"
import { ensureDefaultDesktopPolicyForOrganization } from "../../desktop-policies.js"
import {
  createDesktopPolicy,
  deleteDesktopPolicy,
  updateDesktopPolicy,
  type DesktopPolicyWriteInput,
} from "../../routes/org/desktop-policies.js"
import { defineConfigArea, type ConfigApplyResult, type ConfigAreaContext, type ConfigItem } from "../area.js"
import {
  ConfigApplyError,
  applyWithSteps,
  audienceRefs,
  audienceSteps,
  configRouteContext,
  expectRouteOk,
  idDiff,
  isJsonObject,
  loadMemberEmails,
  loadTeamNames,
  resolvedRefIds,
  setSteps,
  specAudienceSchema,
  specObject,
  stringField,
  touches,
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
  idPrefix: denTypeIdPrefixes.desktopPolicy,
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
    return readPolicies(ctx, null)
  },

  async readItems(ctx, ids) {
    return readPolicies(ctx, ids)
  },

  async apply(ctx, op): Promise<ConfigApplyResult> {
    return applyWithSteps(async (log) => {
      const { c, payload } = await configRouteContext(ctx)

      if (op.kind === "delete") {
        const response = await deleteDesktopPolicy(c, payload, op.targetId)
        if (response.status === 404) return { localId: op.targetId, warnings: ["The policy was already removed."] }
        await log.run({ action: "delete", target: "policy", detail: op.previous.name }, () => expectRouteOk(response, `Remove "${op.previous.name}"`))
        return { localId: op.targetId }
      }

      const raw = specObject(op.item.spec)
      const parsed = applySpecSchema.safeParse(raw)
      if (!parsed.success) throw new ConfigApplyError("invalid_spec", parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; "), 400, parsed.error.issues[0]?.path.join("."))
      const spec = parsed.data
      const assignments = isJsonObject(raw.assignments) ? raw.assignments : {}
      const warnings: string[] = []
      const memberIds = resolvedRefIds(assignments.members, "assignments.members").map((id) => normalizeDenTypeId("member", id))
      const teamIds = resolvedRefIds(assignments.teams, "assignments.teams").map((id) => normalizeDenTypeId("team", id))
      const input: DesktopPolicyWriteInput = {
        policyName: op.item.name,
        policy: spec.policy,
        priority: spec.priority,
        isEnabled: spec.enabled,
        roles: spec.assignments.roles,
        memberIds,
        teamIds,
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
        const isDefault = existing.isDefault === true
        // An update writes only the parts the plan changes; the default policy matched by a create compares everything.
        const inScope = (path: string) => op.kind !== "update" || touches(op.changes, path)
        if (isDefault && inScope("assignments") && (spec.assignments.roles.length > 0 || memberIds.length > 0 || teamIds.length > 0)) {
          warnings.push("The default policy applies to everyone; its assignments were not changed.")
        }
        if (!isDefault && spec.isDefault) warnings.push("Only the organization's own default policy can be the default; this policy stays a custom one.")
        if ((op.item.key ?? null) !== (existing.externalKey ?? null) && op.kind === "update" && touches(op.changes, "key")) warnings.push("A policy's key can't change; the existing key was kept.")

        const storedPolicy = isDefault ? normalizeDefaultDesktopPolicyDocument(existing.policy) : normalizeDesktopPolicyDocument(existing.policy)
        const fieldSteps: ConfigApplyStep[] = [
          ...(!isDefault && inScope("name") && op.item.name.trim() !== existing.policyName ? [{ action: "set" as const, target: "name", detail: op.item.name.trim() }] : []),
          ...(!isDefault && inScope("enabled") && spec.enabled !== (existing.isEnabled === true) ? [{ action: "set" as const, target: "enabled", detail: String(spec.enabled) }] : []),
          ...(!isDefault && inScope("priority") && spec.priority !== existing.priority ? [{ action: "set" as const, target: "priority", detail: String(spec.priority) }] : []),
          ...(inScope("policy") && JSON.stringify(spec.policy) !== JSON.stringify(storedPolicy) ? [{ action: "update" as const, target: "policy", detail: changedPolicyFields(op.kind === "update" ? op.changes : null) }] : []),
        ]
        const [first, ...rest] = fieldSteps
        if (first) {
          // One row: the fields that do not change are sent as stored, so only the changed ones differ.
          const fieldsInput: DesktopPolicyWriteInput = {
            ...input,
            policyName: fieldSteps.some((step) => step.target === "name") ? input.policyName : existing.policyName,
            isEnabled: fieldSteps.some((step) => step.target === "enabled") ? input.isEnabled : existing.isEnabled === true,
            priority: fieldSteps.some((step) => step.target === "priority") ? input.priority : existing.priority,
            policy: fieldSteps.some((step) => step.target === "policy") ? input.policy : storedPolicy,
          }
          // Full replacement of the document, like the keyed PUT: omitted onboarding prompts are not kept.
          await log.run(first, async () => {
            await expectRouteOk(await updateDesktopPolicy(c, payload, existing.id, fieldsInput, true, { fields: true, assignments: false }), `Update "${op.item.name}"`)
          })
          log.add(...rest)
        }

        if (!isDefault && inScope("assignments")) {
          const stored = await ctx.db.select().from(DesktopPolicyMemberTable).where(eq(DesktopPolicyMemberTable.desktopPolicyId, existing.id))
          const teams = idDiff(stored.flatMap((row) => row.teamId ? [row.teamId] : []), teamIds)
          const members = idDiff(stored.flatMap((row) => row.orgMemberId ? [row.orgMemberId] : []), memberIds)
          const roles = idDiff(stored.flatMap((row) => !row.teamId && !row.orgMemberId && isAssignmentRole(row.role) ? [row.role] : []), spec.assignments.roles)
          const steps = [
            ...setSteps("assignments.roles", roles.added, roles.removed),
            ...await audienceSteps(ctx.db, payload.organization.id, "assignments", { teams, members }),
          ]
          const [firstAssignment, ...otherAssignments] = steps
          if (firstAssignment) {
            // Only the assignments that are added or removed are written (updateDesktopPolicy diffs them).
            await log.run(firstAssignment, async () => {
              await expectRouteOk(await updateDesktopPolicy(c, payload, existing.id, input, true, { fields: false, assignments: true }), `Update the assignments of "${op.item.name}"`)
            }, "assignments")
            log.add(...otherAssignments)
          }
        }
        return { localId: existing.id, warnings }
      }

      if (op.kind !== "create") throw new ConfigApplyError("invalid_op", "Unexpected apply operation.")
      const localId = await log.run({ action: "create", target: "policy", detail: op.item.name }, async () => {
        const created = await expectRouteOk(await createDesktopPolicy(
          c, payload, input, op.item.key ?? undefined,
          op.preferredId ? normalizeDenTypeId("desktopPolicy", op.preferredId) : undefined,
        ), `Create "${op.item.name}"`)
        return stringField(created, "desktopPolicy", "id")
      })
      return { localId, warnings }
    })
  },
})

/** "settings.x, accessLimits" from the plan's changes under `policy`. */
function changedPolicyFields(changes: readonly ConfigFieldChange[] | null): string | undefined {
  if (!changes) return undefined
  const fields = [...new Set(changes.filter((change) => change.path.startsWith("policy.")).map((change) => change.path.slice("policy.".length)))]
  return fields.length > 0 ? fields.join(", ") : undefined
}

async function readPolicies(ctx: ConfigAreaContext, ids: readonly string[] | null): Promise<ConfigItem[]> {
  const organizationId = normalizeDenTypeId("organization", ctx.organizationId)
  const policyIds = ids?.flatMap((id) => {
    try {
      return [normalizeDenTypeId("desktopPolicy", id)]
    } catch {
      return []
    }
  }) ?? null
  if (policyIds && policyIds.length === 0) return []
  const policies = await ctx.db
    .select()
    .from(DesktopPolicyTable)
    .where(and(eq(DesktopPolicyTable.organizationId, organizationId), isNull(DesktopPolicyTable.deletedAt), policyIds ? inArray(DesktopPolicyTable.id, policyIds) : undefined))
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
}
