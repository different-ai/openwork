import { normalizeDenTypeId, type DenTypeId } from "@openwork-ee/utils/typeid"
import { isWorkbotManagedLuna } from "@openwork/types/den/workbot-settings"
import {
  withWorkbotEnabled,
  workbotEveryoneSettingsWriteSchema,
  workbotTeamAgentViewSchema,
  workbotTeamSettingsViewSchema,
  workbotTeamSettingsWriteSchema,
  type WorkbotTeamSettingsWrite,
} from "@openwork/types/den/workbot-team-settings"
import type { Hono } from "hono"
import { describeRoute } from "hono-openapi"
import { z } from "zod"
import { findOrganizationTeamForDefaultModel } from "../../default-model.js"
import { getOrganizationFeatures, requireFeature } from "../../features.js"
import { jsonValidator, orgMemberRoute, paramValidator, requireOrgPermission } from "../../middleware/index.js"
import { forbiddenSchema, invalidRequestSchema, jsonResponse, notFoundSchema, unauthorizedSchema } from "../../openapi.js"
import { updateOrganizationMetadata } from "../../organization-metadata.js"
import { agentBriefAllowed, agentCheckGateAllowed, agentSendCheckAllowed, readProactiveSettings } from "../../workbot-proactive/access.js"
import { workbotOrigin } from "../../workbot/config.js"
import { checkWorkbotModelChoice, workbotModelCatalog } from "../../workbot/model.js"
import { listWorkbotTeamSettings, readEveryoneAgentPolicy, readTeamAgentPolicy, saveTeamAgentPolicy, saveWorkbotTeamSettings } from "../../workbot/team-settings.js"
import { isDuplicateEntry } from "./declarative.js"
import type { OrgRouteVariables } from "./shared.js"
import { hasPermission, idParamSchema, memberPermissionsForRequest, type PermissionRouteContext } from "./shared.js"
import {
  CONNECTION_NOT_FOUND_MESSAGE,
  INVALID_WORKING_HOURS_MESSAGE,
  RUNNER_UNAVAILABLE_MESSAGE,
  UNKNOWN_MODEL_MESSAGE,
  agentConnectionTools,
  agentConnectionToolsDocumentSchema,
  connectionNotFoundSchema,
  connectionToolsParamsSchema,
  featureDisabledSchema,
  invalidHoursSchema,
  proactiveView,
  refusedProactiveChange,
  requireWorkbotDeployed,
  requireWorkbotSettingsRead,
  runnerUnavailableSchema,
  unknownModelSchema,
  workbotProactiveInputDocumentSchema,
} from "./workbot-settings.js"

const notFound = jsonResponse("The organization or team was not found, or Workbot settings per team are off.", notFoundSchema)
const agentNotFound = jsonResponse("The organization or team was not found, or Workbot settings per team, members' agents or Workbot are off.", z.union([featureDisabledSchema, notFoundSchema]))
const teamParamsSchema = idParamSchema("teamId", "team")
const teamConnectionParamsSchema = teamParamsSchema.extend(connectionToolsParamsSchema.shape)
const AGENTS_OFF_MESSAGE = "Members' agents aren't on for this organization."

/**
 * The group that exists only with a second feature: a team's members'-agents policy with members' agents
 * (`workbotProactive`, on a deployment with Workbot). One cached feature read.
 */
async function shownGroups(organizationId: string, userId: string): Promise<{ agents: boolean }> {
  const features = await getOrganizationFeatures(organizationId, { userId })
  return { agents: features.workbotProactive && workbotOrigin() !== null }
}

/**
 * The route's model check for a team's own model: the caller's supported, credential-ready models only, and the
 * managed starter saved as Default (null), as for the organization. Shared with the config-blob area.
 */
export async function checkWorkbotTeamModel(input: { organizationId: DenTypeId<"organization">; userId: string; model: string }) {
  const catalog = await workbotModelCatalog({ organizationId: input.organizationId, userId: input.userId }).catch(() => null)
  // Selecting the managed starter means Default, as for the organization.
  const model = isWorkbotManagedLuna(input.model) && input.model === catalog?.defaultModel ? null : input.model
  return { choice: checkWorkbotModelChoice(model, catalog), model }
}

/** Saves one team's change; a concurrent first save of the same team created the row, so the change is applied to it. */
export async function saveWorkbotTeamSettingsChange(input: Parameters<typeof saveWorkbotTeamSettings>[0]): Promise<void> {
  try {
    await saveWorkbotTeamSettings(input)
  } catch (error) {
    if (!isDuplicateEntry(error)) throw error
    await saveWorkbotTeamSettings(input)
  }
}

/** Turns Workbot on or off for everyone whose teams do not say otherwise (organization metadata `workbot.enabled`). */
export async function saveWorkbotEnabledForEveryone(organizationId: DenTypeId<"organization">, enabled: boolean): Promise<void> {
  await updateOrganizationMetadata(organizationId, (current) => withWorkbotEnabled(current, enabled))
}

async function settingsView(c: PermissionRouteContext, organizationId: DenTypeId<"organization">, groups: { agents: boolean }) {
  return { ...await listWorkbotTeamSettings(organizationId, groups), canEdit: await hasPermission(c, "inference.manage") }
}

/**
 * Members › Teams › a team › Workbot (the `workbotTeamSettings` feature): a team's own default model, Workbot
 * name, on/off switch and (with `workbotProactive`) policy for its members'
 * agents on top of the organization's, and the organization's switch for everyone. Members never
 * read these routes; Den resolves each member's values for them. No route here depends on the caller's own
 * switch, so an admin whose Workbot is off can still turn it back on.
 */
export function registerOrgWorkbotTeamSettingsRoutes<T extends { Variables: OrgRouteVariables }>(app: Hono<T>) {
  app.get(
    "/v1/org/workbot-settings/teams",
    describeRoute({
      tags: ["Organizations"],
      summary: "Get Workbot settings per team",
      description:
        "Returns the organization's Workbot default model (null is the deployment's default model), Workbot name (null when the organization set none) and whether Workbot is on for everyone, and for each team, by name, whether it uses the organization's value or its own for each of the three. With members' agents on (workbotProactive), `organization.agentEnabled` says whether they are on for everyone and each team carries `agent`: `inherit` (the team follows the organization's policy for members' agents) and `enabled` (agents are on under the policy the team has now); the team's own policy is read and saved at `/v1/org/workbot-settings/teams/{teamId}/agent`. A member on several teams whose own values for a setting differ gets the organization's value for it; conflictingMemberCount counts them per team. Requires View OpenWork Models settings or Manage OpenWork Models, and the Workbot settings per team feature.",
      responses: {
        200: jsonResponse("Workbot settings per team returned.", workbotTeamSettingsViewSchema),
        401: jsonResponse("Authentication required.", unauthorizedSchema),
        403: jsonResponse("The caller lacks both View OpenWork Models settings and Manage OpenWork Models.", forbiddenSchema),
        404: notFound,
      },
    }),
    orgMemberRoute(),
    requireFeature("workbotTeamSettings"),
    requireWorkbotSettingsRead,
    async (c) => {
      c.header("Cache-Control", "no-store")
      const { organization, currentMember } = c.get("organizationContext")
      return c.json(await settingsView(c, organization.id, await shownGroups(organization.id, currentMember.userId)))
    },
  )

  app.put(
    "/v1/org/workbot-settings/teams/:teamId",
    describeRoute({
      tags: ["Organizations"],
      summary: "Set a team's Workbot settings",
      description:
        "Changes one team's Workbot default model, Workbot name, whether Workbot is on for the team (`enabled`), or several; a setting left out is kept. For each, `{ inherit: true }` makes the team use the organization's value again and `{ inherit: false, value }` sets the team's own: a model from the caller's supported, credential-ready AI Gateway models (null is the deployment's default model), a name of 1 to 40 characters, or true or false for `enabled`. With members' agents on (workbotProactive), `agent: { inherit: true }` removes the team's own policy for its members' agents so they follow the organization's again from their next check (the team's own policy is saved with `PUT /v1/org/workbot-settings/teams/{teamId}/agent`); without it `agent` answers 400. The team's members get it from their next message or run, in Workbot, the Slack assistant and cloud Automations set to the cloud default; a member on several teams whose own values differ gets the organization's. `enabled` covers the Workbot app and Your agent only, never the Slack assistant, Automations or the desktop app. A team's model selects a model and never grants access to it. Requires the Manage OpenWork Models permission, which also governs the team's Workbot name and switch, a recent sign-in and the Workbot settings per team feature.",
      responses: {
        200: jsonResponse("Workbot settings per team saved.", workbotTeamSettingsViewSchema),
        400: jsonResponse("The model is not one the runner serves, members' agents aren't on for this organization, or the request was invalid.", z.union([unknownModelSchema, invalidRequestSchema])),
        401: jsonResponse("Authentication required.", unauthorizedSchema),
        403: jsonResponse("The caller lacks the Manage OpenWork Models permission or needs to sign in again.", forbiddenSchema),
        404: notFound,
        503: jsonResponse("The headless runner could not be reached to check the model.", runnerUnavailableSchema),
      },
    }),
    orgMemberRoute(),
    requireFeature("workbotTeamSettings"),
    requireOrgPermission("inference.manage"),
    paramValidator(teamParamsSchema),
    jsonValidator(workbotTeamSettingsWriteSchema),
    async (c) => {
      c.header("Cache-Control", "no-store")
      const context = c.get("organizationContext")
      const organizationId = context.organization.id
      const teamId = normalizeDenTypeId("team", c.req.valid("param").teamId)
      if (!await findOrganizationTeamForDefaultModel(organizationId, teamId)) return c.json({ error: "team_not_found" }, 404)
      let change: WorkbotTeamSettingsWrite = c.req.valid("json")
      const groups = await shownGroups(organizationId, context.currentMember.userId)
      if (change.agent && !groups.agents) return c.json({ error: "invalid_request" as const, message: AGENTS_OFF_MESSAGE, details: [] }, 400)
      if (change.model && !change.model.inherit && change.model.value !== null) {
        // The same check as the organization's default model, against the caller's own models.
        const { choice, model } = await checkWorkbotTeamModel({ organizationId, userId: context.currentMember.userId, model: change.model.value })
        if (choice === "runner_unavailable") return c.json({ error: "workbot_runner_unavailable" as const, message: RUNNER_UNAVAILABLE_MESSAGE }, 503)
        if (choice === "unknown_model") return c.json({ error: "unknown_model" as const, message: UNKNOWN_MODEL_MESSAGE }, 400)
        change = { ...change, model: { inherit: false, value: model } }
      }
      await saveWorkbotTeamSettingsChange({ organizationId, teamId, change, updatedByOrgMemberId: context.currentMember.id })
      return c.json(await settingsView(c, organizationId, groups))
    },
  )

  app.get(
    "/v1/org/workbot-settings/teams/:teamId/agent",
    describeRoute({
      tags: ["Organizations"],
      summary: "Get the settings for a team's members' agents",
      description:
        "Returns how members' agents work for one team's members, in the same shape as `GET /v1/org/workbot-settings/proactive` plus `inherit`. A team either follows the organization's policy (`inherit: true`: the organization's settings, sources, brief and template are returned, so they can be shown as the team's current values) or has its own complete one (`inherit: false`): on/off, working hours, the daily limit, members' starting choice, the destination, what agents may read (`settings.sources`, with `sourceConnections` grouped under the team's policy), the brief (with workbotAgentBrief) and the \"Your agent\" template, whose `version` counts the team's own template saves. The team's members follow its policy from their next check; a member on several teams whose own policies differ follows the organization's. Requires the Workbot settings per team and workbotProactive features, Workbot on this deployment, and View OpenWork Models settings or Manage OpenWork Models.",
      responses: {
        200: jsonResponse("The team's agent settings returned.", workbotTeamAgentViewSchema),
        401: jsonResponse("Authentication required.", unauthorizedSchema),
        403: jsonResponse("The caller lacks both View OpenWork Models settings and Manage OpenWork Models.", forbiddenSchema),
        404: agentNotFound,
      },
    }),
    orgMemberRoute(),
    requireFeature("workbotTeamSettings"),
    requireFeature("workbotProactive"),
    requireWorkbotDeployed,
    requireWorkbotSettingsRead,
    paramValidator(teamParamsSchema),
    async (c) => {
      c.header("Cache-Control", "no-store")
      const { organization, currentMember } = c.get("organizationContext")
      const teamId = normalizeDenTypeId("team", c.req.valid("param").teamId)
      if (!await findOrganizationTeamForDefaultModel(organization.id, teamId)) return c.json({ error: "team_not_found" }, 404)
      const canViewConnections = (await memberPermissionsForRequest(c))?.has("connections.view") ?? false
      const briefOn = await agentBriefAllowed(organization.id, currentMember.userId)
      const checkGateOn = await agentCheckGateAllowed(organization.id, currentMember.userId)
      const sendCheckOn = await agentSendCheckAllowed(organization.id, currentMember.userId)
      const own = await readTeamAgentPolicy(organization.id, teamId)
      const policy = own ?? await readEveryoneAgentPolicy(organization.id)
      return c.json({ ...await proactiveView(organization.id, policy.settings, policy.template, canViewConnections, briefOn, checkGateOn, sendCheckOn), inherit: !own })
    },
  )

  app.get(
    "/v1/org/workbot-settings/teams/:teamId/agent/sources/:connectionId/tools",
    describeRoute({
      tags: ["Organizations"],
      summary: "Get the tools a team's members' agents may use on a connection",
      description:
        "With Your agent's brief on (workbotAgentBrief): every tool one of the organization's connections lists and whether the team's members' agents may call it, in the same shape as `GET /v1/org/workbot-settings/proactive/sources/{connectionId}/tools`, decided with the admin's per-tool choices (`sources.toolOverrides`) of the team's own policy, or the organization's while the team follows it. An MCP connection's tools are listed with the caller's own account. Agents only ever read. Requires the Workbot settings per team, workbotProactive and workbotAgentBrief features, Workbot on this deployment, View OpenWork Models settings or Manage OpenWork Models, and View connections.",
      responses: {
        200: jsonResponse("The connection's tools returned.", agentConnectionToolsDocumentSchema),
        401: jsonResponse("Authentication required.", unauthorizedSchema),
        403: jsonResponse("The caller lacks View OpenWork Models settings, Manage OpenWork Models or View connections.", forbiddenSchema),
        404: jsonResponse("The organization or team was not found, a feature is off, or the connection isn't the organization's.", z.union([featureDisabledSchema, connectionNotFoundSchema, notFoundSchema])),
      },
    }),
    orgMemberRoute(),
    requireFeature("workbotTeamSettings"),
    requireFeature("workbotProactive"),
    requireWorkbotDeployed,
    requireWorkbotSettingsRead,
    requireOrgPermission("connections.view"),
    paramValidator(teamConnectionParamsSchema),
    async (c) => {
      c.header("Cache-Control", "no-store")
      const { organization, currentMember } = c.get("organizationContext")
      if (!(await agentBriefAllowed(organization.id, currentMember.userId))) return c.json({ error: "feature_disabled" as const, feature: "workbotAgentBrief" }, 404)
      const { connectionId, teamId: requestedTeamId } = c.req.valid("param")
      const teamId = normalizeDenTypeId("team", requestedTeamId)
      if (!await findOrganizationTeamForDefaultModel(organization.id, teamId)) return c.json({ error: "team_not_found" }, 404)
      const view = await agentConnectionTools(app, c.env, {
        organizationId: organization.id,
        memberId: currentMember.id,
        connectionId,
        sources: async () => ((await readTeamAgentPolicy(organization.id, teamId))?.settings ?? await readProactiveSettings(organization.id)).sources,
      })
      if (!view) return c.json({ error: "connection_not_found" as const, message: CONNECTION_NOT_FOUND_MESSAGE }, 404)
      return c.json(view)
    },
  )

  app.put(
    "/v1/org/workbot-settings/teams/:teamId/agent",
    describeRoute({
      tags: ["Organizations"],
      summary: "Change the settings for a team's members' agents",
      description:
        "Changes any subset of how members' agents work for one team's members, with the same body and the same checks as `PUT /v1/org/workbot-settings/proactive`: policy fields, `sources` (only the organization's own connections, each where it can serve; an MCP only with reviewed read tools unless workbotAgentBrief is on; a core source's default must stay allowed), `brief` (400 without workbotAgentBrief), `responsibilities` and `instructions`. The change is merged onto the team's own policy. A team that followed the organization starts from the organization's policy, sources, brief and template as they are now, and this first save makes that copy the team's own: from then on it no longer follows the organization's changes. A change to responsibilities or instructions adds one to the team's template `version`. The team's members follow it from their next check, including when agents are off for everyone and on for this team; a member on several teams whose own policies differ follows the organization's. Members' own choices are kept. To follow the organization again, send `agent: { inherit: true }` to `PUT /v1/org/workbot-settings/teams/{teamId}`. Returns the team's policy with `inherit: false`. Requires the Workbot settings per team and workbotProactive features, Workbot on this deployment and Manage OpenWork Models.",
      responses: {
        200: jsonResponse("The team's agent settings saved.", workbotTeamAgentViewSchema),
        400: jsonResponse("The request was invalid, or the workday would end before it starts.", z.union([invalidHoursSchema, invalidRequestSchema])),
        401: jsonResponse("Authentication required.", unauthorizedSchema),
        403: jsonResponse("The caller lacks the Manage OpenWork Models permission.", forbiddenSchema),
        404: agentNotFound,
      },
    }),
    orgMemberRoute(),
    requireFeature("workbotTeamSettings"),
    requireFeature("workbotProactive"),
    requireWorkbotDeployed,
    requireOrgPermission("inference.manage"),
    paramValidator(teamParamsSchema),
    jsonValidator(workbotProactiveInputDocumentSchema),
    async (c) => {
      c.header("Cache-Control", "no-store")
      const { organization, currentMember } = c.get("organizationContext")
      const teamId = normalizeDenTypeId("team", c.req.valid("param").teamId)
      if (!await findOrganizationTeamForDefaultModel(organization.id, teamId)) return c.json({ error: "team_not_found" }, 404)
      const requested = c.req.valid("json")
      const briefOn = await agentBriefAllowed(organization.id, currentMember.userId)
      const checkGateOn = await agentCheckGateAllowed(organization.id, currentMember.userId)
      const sendCheckOn = await agentSendCheckAllowed(organization.id, currentMember.userId)
      // What the change applies to: the team's own policy, or the organization's for a team that had none.
      const everyone = await readEveryoneAgentPolicy(organization.id)
      const refused = await refusedProactiveChange({
        organizationId: organization.id,
        requested,
        briefOn,
        checkGateOn,
        sendCheckOn,
      })
      if (refused) return c.json(refused, 400)
      const write = () => saveTeamAgentPolicy({ organizationId: organization.id, teamId, change: requested, everyone, updatedByOrgMemberId: currentMember.id })
      // A concurrent first save of the same team created the row; apply the change to it.
      const saved = await write().catch((error: unknown) => {
        if (!isDuplicateEntry(error)) throw error
        return write()
      })
      if (!saved) return c.json({ error: "invalid_working_hours" as const, message: INVALID_WORKING_HOURS_MESSAGE }, 400)
      const canViewConnections = (await memberPermissionsForRequest(c))?.has("connections.view") ?? false
      return c.json({ ...await proactiveView(organization.id, saved.settings, saved.template, canViewConnections, briefOn, checkGateOn, sendCheckOn), inherit: false })
    },
  )

  app.put(
    "/v1/org/workbot-settings/everyone",
    describeRoute({
      tags: ["Organizations"],
      summary: "Set Workbot settings for everyone",
      description:
        "Changes the organization's own Workbot settings that teams can override; a setting left out is kept. `enabled` turns Workbot on or off for every member whose teams do not set their own: off, those members' Workbot app says it isn't on, their Workbot routes are refused and Your agent stops checking and messaging for them; the Slack assistant, Automations and the desktop app are not affected. A team with its own `enabled` keeps it, and a member on several teams whose own values differ gets this one. Returns the same view as the per-team routes. Requires the Manage OpenWork Models permission, a recent sign-in and the Workbot settings per team feature.",
      responses: {
        200: jsonResponse("Workbot settings for everyone saved.", workbotTeamSettingsViewSchema),
        400: jsonResponse("The request was invalid.", invalidRequestSchema),
        401: jsonResponse("Authentication required.", unauthorizedSchema),
        403: jsonResponse("The caller lacks the Manage OpenWork Models permission or needs to sign in again.", forbiddenSchema),
        404: jsonResponse("The organization was not found, or Workbot settings per team are off.", notFoundSchema),
      },
    }),
    orgMemberRoute(),
    requireFeature("workbotTeamSettings"),
    requireOrgPermission("inference.manage"),
    jsonValidator(workbotEveryoneSettingsWriteSchema),
    async (c) => {
      c.header("Cache-Control", "no-store")
      const context = c.get("organizationContext")
      const organizationId = context.organization.id
      const { enabled } = c.req.valid("json")
      if (enabled !== undefined) await saveWorkbotEnabledForEveryone(organizationId, enabled)
      return c.json(await settingsView(c, organizationId, await shownGroups(organizationId, context.currentMember.userId)))
    },
  )
}
