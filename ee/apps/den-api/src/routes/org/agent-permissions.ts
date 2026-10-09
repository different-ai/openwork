import { normalizeDenTypeId, type DenTypeId } from "@openwork-ee/utils/typeid"
import {
  AGENT_PERMISSION_EVERYONE,
  agentPermissionSettingsSchema,
  type AgentPermissionSettings,
} from "@openwork/types/den/agent-permissions"
import type { Hono } from "hono"
import { describeRoute } from "hono-openapi"
import { z } from "zod"
import {
  findOrganizationTeam,
  listAgentPermissionPolicies,
  saveAgentPermissionPolicy,
} from "../../agent-permissions.js"
import { checkEntitlement } from "../../entitlements.js"
import { requireFeature } from "../../features.js"
import { jsonValidator, orgPermissionRoute, paramValidator } from "../../middleware/index.js"
import {
  emptyResponse,
  enterprisePlanRequiredSchema,
  forbiddenSchema,
  invalidRequestSchema,
  jsonResponse,
  notFoundSchema,
  unauthorizedSchema,
} from "../../openapi.js"
import { isDuplicateEntry, type ResourceActionContext, type ResourceOrganizationContext } from "./declarative.js"
import type { OrgRouteVariables } from "./shared.js"
import { hasPermission, idParamSchema, orgAccessFailureStatus, permissionFailureHeaders, requirePermission } from "./shared.js"

const agentPermissionPolicySchema = z.object({
  /** The team the policy applies to, or null for everyone. */
  teamId: z.string().nullable(),
  name: z.string(),
  /** Team members, or null for everyone. */
  memberCount: z.number().int().nullable(),
  settings: agentPermissionSettingsSchema,
  updatedAt: z.string().datetime().nullable(),
}).meta({ ref: "AgentPermissionPolicy" })

const agentPermissionPolicyListSchema = z.object({
  everyone: agentPermissionPolicySchema,
  teams: z.array(agentPermissionPolicySchema),
  /** Whether the caller can change them (desktop_policies.manage). */
  canEdit: z.boolean(),
}).meta({ ref: "AgentPermissionPolicyList" })

const agentPermissionPolicyWriteSchema = z.object({
  settings: agentPermissionSettingsSchema,
}).strict().meta({ ref: "AgentPermissionPolicyWrite" })

const agentPermissionPolicyResponseSchema = z.object({
  policy: agentPermissionPolicySchema,
}).meta({ ref: "AgentPermissionPolicyResponse" })

const teamParamsSchema = idParamSchema("teamId", "team")

function serializeDate(value: Date | null) {
  return value ? value.toISOString() : null
}

async function savePolicy(
  c: ResourceActionContext,
  payload: ResourceOrganizationContext,
  input: { teamId: DenTypeId<"team"> | null; settings: AgentPermissionSettings },
) {
  const permission = await requirePermission(c, "desktop_policies.manage")
  if (!permission.ok) return c.json(permission.response, orgAccessFailureStatus(permission.response), permissionFailureHeaders(permission.response))
  const entitlement = checkEntitlement(payload.organization.metadata, "desktopPolicies")
  if (!entitlement.ok) return c.json(entitlement.response, entitlement.status)

  const team = input.teamId ? await findOrganizationTeam(payload.organization.id, input.teamId) : null
  if (input.teamId && !team) return c.json({ error: "team_not_found" }, 404)

  const save = () => saveAgentPermissionPolicy({
    organizationId: payload.organization.id,
    teamId: input.teamId,
    settings: input.settings,
    updatedByOrgMemberId: payload.currentMember.id,
  })
  let saved: Awaited<ReturnType<typeof save>>
  try {
    saved = await save()
  } catch (error) {
    // A concurrent first save of the same scope created the policy; replace it.
    if (!isDuplicateEntry(error)) throw error
    saved = await save()
  }

  return c.json({
    policy: {
      teamId: team?.id ?? null,
      name: team?.name ?? AGENT_PERMISSION_EVERYONE,
      memberCount: team?.memberCount ?? null,
      settings: saved.settings,
      updatedAt: serializeDate(saved.updatedAt),
    },
  })
}

export function registerOrgAgentPermissionRoutes<T extends { Variables: OrgRouteVariables }>(app: Hono<T>) {
  app.get(
    "/v1/agent-permissions",
    describeRoute({
      tags: ["Agent Permissions"],
      summary: "List agent permissions",
      description: "Returns what agents may do on members' computers: everyone's settings and each team's overrides, every team listed by name. A permission a team leaves out inherits everyone's. Members who can view desktop policies can read; canEdit says whether the caller can change them.",
      responses: {
        200: jsonResponse("Agent permissions returned successfully.", agentPermissionPolicyListSchema),
        401: jsonResponse("The caller must be signed in.", unauthorizedSchema),
        403: jsonResponse("The caller needs the desktop_policies.view permission.", forbiddenSchema),
        404: jsonResponse("Agent permissions are not turned on for this organization.", notFoundSchema),
      },
    }),
    orgPermissionRoute("desktop_policies.view"),
    requireFeature("agentPermissions"),
    async (c) => {
      const payload = c.get("organizationContext")
      if (!payload) return c.json({ error: "organization_not_found" }, 404)
      const policies = await listAgentPermissionPolicies(payload.organization.id)
      return c.json({
        everyone: {
          teamId: null,
          name: AGENT_PERMISSION_EVERYONE,
          memberCount: null,
          settings: policies.everyone.settings,
          updatedAt: serializeDate(policies.everyone.updatedAt),
        },
        teams: policies.teams.map((team) => ({
          teamId: team.teamId,
          name: team.teamName,
          memberCount: team.memberCount,
          settings: team.settings,
          updatedAt: serializeDate(team.updatedAt),
        })),
        canEdit: await hasPermission(c, "desktop_policies.manage"),
      })
    },
  )

  app.put(
    "/v1/agent-permissions/everyone",
    describeRoute({
      tags: ["Agent Permissions"],
      summary: "Set everyone's agent permissions",
      description: "Replaces the agent permissions that apply to every member. A permission left out allows, so members' own settings apply. Members' apps pick up the change the next time they refresh their organization's settings. Requires the desktop_policies.manage permission with a recent sign-in, and the Enterprise plan.",
      responses: {
        200: jsonResponse("Everyone's agent permissions saved.", agentPermissionPolicyResponseSchema),
        400: jsonResponse("A permission or pattern was not valid.", invalidRequestSchema),
        401: jsonResponse("The caller must be signed in.", unauthorizedSchema),
        402: jsonResponse("Agent permissions require an Enterprise plan.", enterprisePlanRequiredSchema),
        403: jsonResponse("The caller needs the desktop_policies.manage permission and a recent sign-in.", forbiddenSchema),
        404: jsonResponse("Agent permissions are not turned on for this organization.", notFoundSchema),
      },
    }),
    orgPermissionRoute("desktop_policies.manage"),
    requireFeature("agentPermissions"),
    jsonValidator(agentPermissionPolicyWriteSchema),
    async (c) => {
      const payload = c.get("organizationContext")
      if (!payload) return c.json({ error: "organization_not_found" }, 404)
      return savePolicy(c, payload, { teamId: null, settings: c.req.valid("json").settings })
    },
  )

  app.put(
    "/v1/agent-permissions/teams/:teamId",
    describeRoute({
      tags: ["Agent Permissions"],
      summary: "Set a team's agent permissions",
      description: "Replaces one team's overrides. A team's decision replaces everyone's for its members (the strictest wins when a member is in several teams that set one), and its allowed and blocked patterns add to everyone's. A permission left out inherits everyone's; saving no permissions removes the team's overrides. Requires the desktop_policies.manage permission with a recent sign-in, and the Enterprise plan.",
      responses: {
        200: jsonResponse("The team's agent permissions saved.", agentPermissionPolicyResponseSchema),
        400: jsonResponse("A permission or pattern was not valid.", invalidRequestSchema),
        401: jsonResponse("The caller must be signed in.", unauthorizedSchema),
        402: jsonResponse("Agent permissions require an Enterprise plan.", enterprisePlanRequiredSchema),
        403: jsonResponse("The caller needs the desktop_policies.manage permission and a recent sign-in.", forbiddenSchema),
        404: jsonResponse("The team was not found, or agent permissions are not turned on for this organization.", notFoundSchema),
      },
    }),
    orgPermissionRoute("desktop_policies.manage"),
    requireFeature("agentPermissions"),
    paramValidator(teamParamsSchema),
    jsonValidator(agentPermissionPolicyWriteSchema),
    async (c) => {
      const payload = c.get("organizationContext")
      if (!payload) return c.json({ error: "organization_not_found" }, 404)
      const teamId = normalizeDenTypeId("team", c.req.valid("param").teamId)
      return savePolicy(c, payload, { teamId, settings: c.req.valid("json").settings })
    },
  )

  app.delete(
    "/v1/agent-permissions/teams/:teamId",
    describeRoute({
      tags: ["Agent Permissions"],
      summary: "Remove a team's agent permissions",
      description: "Removes one team's overrides, so its members get everyone's agent permissions. Idempotent. Requires the desktop_policies.manage permission with a recent sign-in, and the Enterprise plan.",
      responses: {
        204: emptyResponse("The team's overrides were removed."),
        401: jsonResponse("The caller must be signed in.", unauthorizedSchema),
        402: jsonResponse("Agent permissions require an Enterprise plan.", enterprisePlanRequiredSchema),
        403: jsonResponse("The caller needs the desktop_policies.manage permission and a recent sign-in.", forbiddenSchema),
        404: jsonResponse("The team was not found, or agent permissions are not turned on for this organization.", notFoundSchema),
      },
    }),
    orgPermissionRoute("desktop_policies.manage"),
    requireFeature("agentPermissions"),
    paramValidator(teamParamsSchema),
    async (c) => {
      const payload = c.get("organizationContext")
      if (!payload) return c.json({ error: "organization_not_found" }, 404)
      const permission = await requirePermission(c, "desktop_policies.manage")
      if (!permission.ok) return c.json(permission.response, orgAccessFailureStatus(permission.response), permissionFailureHeaders(permission.response))
      const entitlement = checkEntitlement(payload.organization.metadata, "desktopPolicies")
      if (!entitlement.ok) return c.json(entitlement.response, entitlement.status)
      const team = await findOrganizationTeam(payload.organization.id, normalizeDenTypeId("team", c.req.valid("param").teamId))
      if (!team) return c.json({ error: "team_not_found" }, 404)
      await saveAgentPermissionPolicy({
        organizationId: payload.organization.id,
        teamId: team.id,
        settings: {},
        updatedByOrgMemberId: payload.currentMember.id,
      })
      return c.body(null, 204)
    },
  )
}
