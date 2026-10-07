import { and, eq, isNull } from "@openwork-ee/den-db/drizzle"
import { appendPermissionSetRules, readPermissionSetRules } from "@openwork-ee/den-db/permission-rules"
import { lockPermissionSet, type PermissionDatabase } from "@openwork-ee/den-db/permissions"
import { PermissionSetTable, PermissionSetTeamTable, permissionRuleActionValues } from "@openwork-ee/den-db/schema"
import { normalizeDenTypeId } from "@openwork-ee/utils/typeid"
import { POLICY_RULES_MAX, policyRuleSchema } from "@openwork/types/den/desktop-policies"
import type { Hono } from "hono"
import { describeRoute } from "hono-openapi"
import { z } from "zod"
import { ORGANIZATION_AUDIT_ACTIONS } from "../../audit-events.js"
import { appendDomainChanges, finishLegacyAuditAction } from "../../audit/domain/legacy.js"
import { permissionSetRulesChangedEvent } from "../../audit/domain/permissions.js"
import { auditChangeCapture, fenceAuditChanges } from "../../audit/request-capture.js"
import { db } from "../../db.js"
import { requireFeature } from "../../features.js"
import { jsonValidator, orgMemberRoute, paramValidator, requireOrgPermission } from "../../middleware/index.js"
import { forbiddenSchema, invalidRequestSchema, jsonResponse, unauthorizedSchema } from "../../openapi.js"
import type { OrgRouteVariables } from "./shared.js"
import { idParamSchema, memberPermissionsForRequest } from "./shared.js"

/**
 * Permission rules: OpenCode permission rules for what members' apps and
 * agents may do (commands, websites, local skills and local MCP servers),
 * kept per permission set next to its permissions. Members' apps receive the
 * rules of every set that applies to them from GET /v1/me/desktop-config.
 *
 * Guard order as in permissions.ts: orgMemberRoute(), requireFeature, then
 * requireOrgPermission, so a disabled feature answers 404 before any 403.
 */

type OrganizationId = typeof PermissionSetTable.$inferSelect.organizationId
type PermissionSetId = typeof PermissionSetTable.$inferSelect.id

const permissionSetParamsSchema = idParamSchema("permissionSetId", "permissionSet")

const permissionRuleEntrySchema = z.object({
  resource: policyRuleSchema.shape.resource,
  effect: policyRuleSchema.shape.effect,
})

const updatePermissionSetRulesBodySchema = z.object({
  action: z.enum(permissionRuleActionValues).describe("The OpenCode permission action these rules are for: shell (commands), webfetch (websites), skill (local skills) or mcp (local MCP servers)."),
  rules: z.array(permissionRuleEntrySchema).max(POLICY_RULES_MAX)
    .describe("The action's whole rule list, checked from first to last; the last rule whose pattern matches decides. An empty list removes the action's rules."),
}).meta({ ref: "UpdatePermissionSetRulesBody" })

const permissionSetRulesResponseSchema = z.object({
  rules: z.array(policyRuleSchema).describe("Each action's rules in order: shell, webfetch, skill, then mcp."),
}).meta({ ref: "PermissionSetRules" })

const notFoundSchema = z.object({
  error: z.enum(["permission_set_not_found", "organization_not_found", "feature_disabled"]),
}).passthrough().meta({ ref: "PermissionRulesNotFoundError" })

const archivedSchema = z.object({
  error: z.literal("permission_set_archived"),
  message: z.string(),
}).meta({ ref: "PermissionRulesConflictError" })

async function readSet(database: PermissionDatabase, organizationId: OrganizationId, permissionSetId: PermissionSetId) {
  const [row] = await database.select().from(PermissionSetTable)
    .where(and(eq(PermissionSetTable.id, permissionSetId), eq(PermissionSetTable.organizationId, organizationId)))
    .limit(1)
  return row ?? null
}

async function activeTeamId(database: PermissionDatabase, organizationId: OrganizationId, permissionSetId: PermissionSetId) {
  const [link] = await database.select({ teamId: PermissionSetTeamTable.teamId }).from(PermissionSetTeamTable)
    .where(and(
      eq(PermissionSetTeamTable.organizationId, organizationId),
      eq(PermissionSetTeamTable.permissionSetId, permissionSetId),
      isNull(PermissionSetTeamTable.removedAt),
    ))
    .limit(1)
  return link?.teamId ?? null
}

async function currentRules(database: PermissionDatabase, permissionSetId: PermissionSetId) {
  return (await readPermissionSetRules(database, [permissionSetId])).get(permissionSetId) ?? []
}

export function registerOrgPermissionRuleRoutes<T extends { Variables: OrgRouteVariables }>(app: Hono<T>) {
  app.get(
    "/v1/permissions/sets/:permissionSetId/rules",
    describeRoute({
      tags: ["Permissions"],
      summary: "Get a set's permission rules",
      description: "Returns the OpenCode permission rules in one permission set: what members it applies to may run (shell), open (webfetch), and use as local skills (skill) or local MCP servers (mcp). Requires permissions.view and the Permissions and Permission rules features.",
      responses: {
        200: jsonResponse("The set's rules.", permissionSetRulesResponseSchema),
        401: jsonResponse("The caller must be signed in.", unauthorizedSchema),
        403: jsonResponse("The caller lacks permissions.view.", forbiddenSchema),
        404: jsonResponse("The permission set or organization was not found, or a feature is turned off.", notFoundSchema),
      },
    }),
    orgMemberRoute(),
    requireFeature("permissions"),
    requireFeature("permissionRules"),
    requireOrgPermission("permissions.view"),
    paramValidator(permissionSetParamsSchema),
    async (c) => {
      const organizationId = c.get("organizationContext").organization.id
      const permissionSetId = normalizeDenTypeId("permissionSet", c.req.valid("param").permissionSetId)
      const set = await readSet(db, organizationId, permissionSetId)
      if (!set) return c.json({ error: "permission_set_not_found" as const }, 404)
      return c.json({ rules: await currentRules(db, set.id) })
    },
  )

  app.put(
    "/v1/permissions/sets/:permissionSetId/rules",
    describeRoute({
      tags: ["Permissions"],
      summary: "Change a set's permission rules",
      description: "Replaces one action's OpenCode permission rules in a set. Every change is kept in the set's rule history and audited. Only the owner and admins can change rules in Admin permissions, and archived sets can't be changed. Returns the set's rules. Requires permissions.manage, a recent sign-in, and the Permissions and Permission rules features.",
      responses: {
        200: jsonResponse("Rules updated; the set's rules are returned.", permissionSetRulesResponseSchema),
        400: jsonResponse("The body was invalid.", invalidRequestSchema),
        401: jsonResponse("The caller must be signed in.", unauthorizedSchema),
        403: jsonResponse("The caller lacks permissions.manage, needs a recent sign-in, or tried to change Admin permissions without being the owner or an admin.", forbiddenSchema),
        404: jsonResponse("The permission set or organization was not found, or a feature is turned off.", notFoundSchema),
        409: jsonResponse("The permission set is archived.", archivedSchema),
      },
    }),
    orgMemberRoute(),
    requireFeature("permissions"),
    requireFeature("permissionRules"),
    requireOrgPermission("permissions.manage"),
    paramValidator(permissionSetParamsSchema),
    jsonValidator(updatePermissionSetRulesBodySchema),
    async (c) => {
      const payload = c.get("organizationContext")
      const organizationId = payload.organization.id
      const permissionSetId = normalizeDenTypeId("permissionSet", c.req.valid("param").permissionSetId)
      const { action, rules } = c.req.valid("json")
      const editor = await memberPermissionsForRequest(c)
      if (!editor) return c.json({ error: "organization_not_found" as const }, 404)
      const capture = auditChangeCapture(c)

      const result = await db.transaction(async (tx) => {
        await fenceAuditChanges(tx, capture)
        if (!(await lockPermissionSet(tx, organizationId, permissionSetId))) return { ok: false as const, error: "permission_set_not_found" as const }
        const set = await readSet(tx, organizationId, permissionSetId)
        if (!set) return { ok: false as const, error: "permission_set_not_found" as const }
        if (set.archivedAt) return { ok: false as const, error: "permission_set_archived" as const }
        if (set.defaultKey === "admin" && !editor.isOwner && !editor.isAdmin) return { ok: false as const, error: "admin_rules_forbidden" as const }

        const before = (await currentRules(tx, set.id)).filter((rule) => rule.action === action).map(({ resource, effect }) => ({ resource, effect }))
        const after = rules.map(({ resource, effect }) => ({ resource, effect }))
        if (JSON.stringify(before) === JSON.stringify(after)) return { ok: true as const, set, changed: false, auditEventIds: [] }

        await appendPermissionSetRules(tx, { organizationId, permissionSetId: set.id, action, rules: after, source: "user", changedByOrgMembershipId: payload.currentMember.id })
        const teamId = await activeTeamId(tx, organizationId, set.id)
        const auditEventIds = await appendDomainChanges(tx, capture, [permissionSetRulesChangedEvent(organizationId, set, teamId, { action, before, after })])
        return { ok: true as const, set, changed: true, auditEventIds }
      })

      if (!result.ok) {
        if (result.error === "permission_set_not_found") return c.json({ error: "permission_set_not_found" as const }, 404)
        if (result.error === "permission_set_archived") {
          return c.json({ error: "permission_set_archived" as const, message: "This permission set was deleted and can't be changed." }, 409)
        }
        return c.json({ error: "forbidden" as const, message: "Only the owner and admins can change Admin permissions." }, 403)
      }

      if (result.changed) {
        await finishLegacyAuditAction(capture, {
          organizationId,
          actorUserId: payload.currentMember.userId,
          action: ORGANIZATION_AUDIT_ACTIONS.permissionSetRulesChanged,
          payload: { permissionSetId: result.set.id, permissionSetName: result.set.name, action, ruleCount: rules.length },
        }, result.auditEventIds)
      }

      return c.json({ rules: await currentRules(db, result.set.id) })
    },
  )
}
