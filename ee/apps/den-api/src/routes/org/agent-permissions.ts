import { normalizeDenTypeId, type DenTypeId } from "@openwork-ee/utils/typeid"
import {
  AGENT_PERMISSION_EVERYONE,
  AGENT_HARNESS_PERMISSION_KEYS,
  agentPermissionSettingsSchema,
  withoutAgentHarnessPermissions,
  withoutBrowserUploadPermissions,
  withoutFileSendPermissions,
  type AgentPermissionKey,
  type AgentPermissionSettings,
} from "@openwork/types/den/agent-permissions"
import type { Hono } from "hono"
import { describeRoute } from "hono-openapi"
import { z } from "zod"
import {
  findOrganizationTeam,
  listAgentPermissionPolicies,
  saveAgentPermissionPolicy,
  type AgentPermissionPolicyChange,
} from "../../agent-permissions.js"
import { agentPermissionPolicyChangedEvent, type AgentPermissionAuditScope } from "../../audit/domain/agent-permissions.js"
import { appendDomainChanges } from "../../audit/domain/legacy.js"
import { auditChangeCapture, type AuditChangeCapture } from "../../audit/request-capture.js"
import { getOrganizationFeatures } from "../../features.js"
import { jsonValidator, orgMemberRoute, paramValidator, requireOrgPermission } from "../../middleware/index.js"
import {
  emptyResponse,
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
  /** Whether the caller can change them (agent_permissions.manage). */
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

/** Appends the scope's before → after change event inside the save's transaction. */
function auditPolicyChange(capture: AuditChangeCapture | null, organizationId: string, scope: AgentPermissionAuditScope): AgentPermissionPolicyChange {
  return (tx, { before, after }) => appendDomainChanges(tx, capture, [agentPermissionPolicyChangedEvent(organizationId, scope, before, after)])
}

/** Which member-decided permissions the calling editor says it can show. */
type EditorSupport = { browserUploads: boolean; fileSends: boolean }
function editorSupport(c: { req: { header(name: string): string | undefined } }): EditorSupport {
  return {
    browserUploads: c.req.header("X-OpenWork-Browser-Upload-Permissions") === "1",
    fileSends: c.req.header("X-OpenWork-File-Send-Permissions") === "1",
  }
}

/** Old editors cannot replace permissions they do not understand. */
async function policyVisibility(payload: ResourceOrganizationContext, supports: EditorSupport) {
  const features = await getOrganizationFeatures(payload.organization.id, { userId: payload.currentMember.userId })
  const uploadsEnabled = features.browserUploadPermissions && supports.browserUploads
  const fileSendsEnabled = features.fileSendPermissions && supports.fileSends
  const preserveKeys: AgentPermissionKey[] = [
    ...(features.agentHarnessPermissions ? [] : AGENT_HARNESS_PERMISSION_KEYS),
    ...(uploadsEnabled ? [] : ["browserUploads"] satisfies AgentPermissionKey[]),
    ...(fileSendsEnabled ? [] : ["fileSends"] satisfies AgentPermissionKey[]),
  ]
  return {
    preserveKeys,
    settings(settings: AgentPermissionSettings) {
      const visible = features.agentHarnessPermissions ? settings : withoutAgentHarnessPermissions(settings)
      const uploads = uploadsEnabled ? visible : withoutBrowserUploadPermissions(visible)
      return fileSendsEnabled ? uploads : withoutFileSendPermissions(uploads)
    },
  }
}

async function savePolicy(
  c: ResourceActionContext,
  payload: ResourceOrganizationContext,
  input: { teamId: DenTypeId<"team"> | null; settings: AgentPermissionSettings; capture: AuditChangeCapture | null; supports: EditorSupport },
) {
  const permission = await requirePermission(c, "agent_permissions.manage")
  if (!permission.ok) return c.json(permission.response, orgAccessFailureStatus(permission.response), permissionFailureHeaders(permission.response))

  const team = input.teamId ? await findOrganizationTeam(payload.organization.id, input.teamId) : null
  if (input.teamId && !team) return c.json({ error: "team_not_found" }, 404)

  const visibility = await policyVisibility(payload, input.supports)
  const save = () => saveAgentPermissionPolicy({
    organizationId: payload.organization.id,
    teamId: input.teamId,
    settings: input.settings,
    preserveKeys: visibility.preserveKeys,
    updatedByOrgMemberId: payload.currentMember.id,
    onChange: auditPolicyChange(input.capture, payload.organization.id, team ? { kind: "team", teamId: team.id, teamName: team.name } : { kind: "everyone" }),
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
      settings: visibility.settings(saved.settings),
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
      description: "Returns what agents may do on members' computers: everyone's settings and each team's overrides, every team listed by name. A permission a team leaves out inherits everyone's. Members who can view desktop policies can read; canEdit says whether the caller can change them. Computer use, Mac app scripting and outside-folder settings are included only when agentHarnessPermissions is enabled for the caller. Browser upload settings additionally require browserUploadPermissions for the caller and X-OpenWork-Browser-Upload-Permissions: 1.",
      responses: {
        200: jsonResponse("Agent permissions returned successfully.", agentPermissionPolicyListSchema),
        401: jsonResponse("The caller must be signed in.", unauthorizedSchema),
        403: jsonResponse("The caller needs the agent_permissions.view permission.", forbiddenSchema),
        404: jsonResponse("Agent permissions are not turned on for this organization.", notFoundSchema),
      },
    }),
    orgMemberRoute(),
    requireOrgPermission("agent_permissions.view"),
    async (c) => {
      const payload = c.get("organizationContext")
      if (!payload) return c.json({ error: "organization_not_found" }, 404)
      const visibility = await policyVisibility(payload, editorSupport(c))
      const policies = await listAgentPermissionPolicies(payload.organization.id)
      return c.json({
        everyone: {
          teamId: null,
          name: AGENT_PERMISSION_EVERYONE,
          memberCount: null,
          settings: visibility.settings(policies.everyone.settings),
          updatedAt: serializeDate(policies.everyone.updatedAt),
        },
        teams: policies.teams.map((team) => ({
          teamId: team.teamId,
          name: team.teamName,
          memberCount: team.memberCount,
          settings: visibility.settings(team.settings),
          updatedAt: serializeDate(team.updatedAt),
        })),
        canEdit: await hasPermission(c, "agent_permissions.manage"),
      })
    },
  )

  app.put(
    "/v1/agent-permissions/everyone",
    describeRoute({
      tags: ["Agent Permissions"],
      summary: "Set everyone's agent permissions",
      description: "Replaces the agent permissions that apply to every member. A permission left out uses its default: Allow for existing permissions, Ask first without administrator authority for browser uploads and files sent to connected accounts. Members' apps pick up the change the next time they refresh their organization's settings. Requires the agent_permissions.manage permission with a recent sign-in. When agentHarnessPermissions is off for the caller, incoming computer use, Mac app scripting and outside-folder settings are ignored, stored settings for those permissions are preserved, and they are omitted from responses. Independently, browser upload settings are ignored and preserved unless browserUploadPermissions is on for the caller and the client sends X-OpenWork-Browser-Upload-Permissions: 1. Settings for files sent to connected accounts follow the same rule with fileSendPermissions and X-OpenWork-File-Send-Permissions: 1.",
      responses: {
        200: jsonResponse("Everyone's agent permissions saved.", agentPermissionPolicyResponseSchema),
        400: jsonResponse("A permission or pattern was not valid.", invalidRequestSchema),
        401: jsonResponse("The caller must be signed in.", unauthorizedSchema),
        403: jsonResponse("The caller needs the agent_permissions.manage permission and a recent sign-in.", forbiddenSchema),
        404: jsonResponse("Agent permissions are not turned on for this organization.", notFoundSchema),
      },
    }),
    orgMemberRoute(),
    requireOrgPermission("agent_permissions.manage"),
    jsonValidator(agentPermissionPolicyWriteSchema),
    async (c) => {
      const payload = c.get("organizationContext")
      if (!payload) return c.json({ error: "organization_not_found" }, 404)
      return savePolicy(c, payload, { teamId: null, settings: c.req.valid("json").settings, capture: auditChangeCapture(c), supports: editorSupport(c) })
    },
  )

  app.put(
    "/v1/agent-permissions/teams/:teamId",
    describeRoute({
      tags: ["Agent Permissions"],
      summary: "Set a team's agent permissions",
      description: "Replaces one team's overrides. A team's decision replaces everyone's for its members (the strictest wins when a member is in several teams that set one), and its allowed and blocked patterns add to everyone's. A permission left out inherits everyone's; saving no permissions removes the team's overrides. Requires the agent_permissions.manage permission with a recent sign-in. When agentHarnessPermissions is off for the caller, incoming computer use, Mac app scripting and outside-folder settings are ignored, stored settings for those permissions are preserved, and they are omitted from responses. Independently, browser upload settings are ignored and preserved unless browserUploadPermissions is on for the caller and the client sends X-OpenWork-Browser-Upload-Permissions: 1.",
      responses: {
        200: jsonResponse("The team's agent permissions saved.", agentPermissionPolicyResponseSchema),
        400: jsonResponse("A permission or pattern was not valid.", invalidRequestSchema),
        401: jsonResponse("The caller must be signed in.", unauthorizedSchema),
        403: jsonResponse("The caller needs the agent_permissions.manage permission and a recent sign-in.", forbiddenSchema),
        404: jsonResponse("The team was not found, or agent permissions are not turned on for this organization.", notFoundSchema),
      },
    }),
    orgMemberRoute(),
    requireOrgPermission("agent_permissions.manage"),
    paramValidator(teamParamsSchema),
    jsonValidator(agentPermissionPolicyWriteSchema),
    async (c) => {
      const payload = c.get("organizationContext")
      if (!payload) return c.json({ error: "organization_not_found" }, 404)
      const teamId = normalizeDenTypeId("team", c.req.valid("param").teamId)
      return savePolicy(c, payload, { teamId, settings: c.req.valid("json").settings, capture: auditChangeCapture(c), supports: editorSupport(c) })
    },
  )

  app.delete(
    "/v1/agent-permissions/teams/:teamId",
    describeRoute({
      tags: ["Agent Permissions"],
      summary: "Remove a team's agent permissions",
      description: "Removes one team's overrides, so its members get everyone's agent permissions. Idempotent. Requires the agent_permissions.manage permission with a recent sign-in. When agentHarnessPermissions is off for the caller, stored computer use, Mac app scripting and outside-folder settings are preserved; only the team's other overrides are removed. Browser upload overrides are likewise preserved unless the caller has browserUploadPermissions and sends X-OpenWork-Browser-Upload-Permissions: 1.",
      responses: {
        204: emptyResponse("The team's overrides were removed."),
        401: jsonResponse("The caller must be signed in.", unauthorizedSchema),
        403: jsonResponse("The caller needs the agent_permissions.manage permission and a recent sign-in.", forbiddenSchema),
        404: jsonResponse("The team was not found, or agent permissions are not turned on for this organization.", notFoundSchema),
      },
    }),
    orgMemberRoute(),
    requireOrgPermission("agent_permissions.manage"),
    paramValidator(teamParamsSchema),
    async (c) => {
      const payload = c.get("organizationContext")
      if (!payload) return c.json({ error: "organization_not_found" }, 404)
      const permission = await requirePermission(c, "agent_permissions.manage")
      if (!permission.ok) return c.json(permission.response, orgAccessFailureStatus(permission.response), permissionFailureHeaders(permission.response))
      const team = await findOrganizationTeam(payload.organization.id, normalizeDenTypeId("team", c.req.valid("param").teamId))
      if (!team) return c.json({ error: "team_not_found" }, 404)
      const visibility = await policyVisibility(payload, editorSupport(c))
      await saveAgentPermissionPolicy({
        organizationId: payload.organization.id,
        teamId: team.id,
        settings: {},
        preserveKeys: visibility.preserveKeys,
        updatedByOrgMemberId: payload.currentMember.id,
        onChange: auditPolicyChange(auditChangeCapture(c), payload.organization.id, { kind: "team", teamId: team.id, teamName: team.name }),
      })
      return c.body(null, 204)
    },
  )
}
