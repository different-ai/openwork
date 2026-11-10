import { normalizeDenTypeId, type DenTypeId } from "@openwork-ee/utils/typeid"
import { isWorkbotManagedLuna } from "@openwork/types/den/workbot-settings"
import {
  withWorkbotEnabled,
  workbotEveryoneSettingsWriteSchema,
  workbotTeamSettingsViewSchema,
  workbotTeamSettingsWriteSchema,
  type WorkbotTeamSettingsWrite,
} from "@openwork/types/den/workbot-team-settings"
import type { Hono } from "hono"
import { describeRoute } from "hono-openapi"
import { z } from "zod"
import { findOrganizationTeamForDefaultModel } from "../../default-model.js"
import { organizationFeatureEnabled, requireFeature } from "../../features.js"
import { jsonValidator, orgMemberRoute, paramValidator, requireOrgPermission } from "../../middleware/index.js"
import { forbiddenSchema, invalidRequestSchema, jsonResponse, notFoundSchema, unauthorizedSchema } from "../../openapi.js"
import { updateOrganizationMetadata } from "../../organization-metadata.js"
import { checkWorkbotModelChoice, workbotModelCatalog } from "../../workbot/model.js"
import { listWorkbotTeamSettings, saveWorkbotTeamSettings } from "../../workbot/team-settings.js"
import { isDuplicateEntry } from "./declarative.js"
import type { OrgRouteVariables } from "./shared.js"
import { hasPermission, idParamSchema, type PermissionRouteContext } from "./shared.js"
import {
  RUNNER_UNAVAILABLE_MESSAGE,
  UNKNOWN_MODEL_MESSAGE,
  requireWorkbotSettingsRead,
  runnerUnavailableSchema,
  unknownModelSchema,
} from "./workbot-settings.js"

const notFound = jsonResponse("The organization or team was not found, or Workbot settings per team are off.", notFoundSchema)
const teamParamsSchema = idParamSchema("teamId", "team")

/** A team's step limit exists only while the organization's step limit (`workbotStepLimit`) is on too. */
function stepLimitOn(organizationId: string, userId: string): Promise<boolean> {
  return organizationFeatureEnabled(organizationId, "workbotStepLimit", { userId })
}

async function settingsView(c: PermissionRouteContext, organizationId: DenTypeId<"organization">, stepLimit: boolean) {
  return { ...await listWorkbotTeamSettings(organizationId, { stepLimit }), canEdit: await hasPermission(c, "inference.manage") }
}

/**
 * Members › Teams › a team › Workbot (the `workbotTeamSettings` feature): a team's own default model, Workbot
 * name, on/off switch and (with `workbotStepLimit`) step limit on top of the organization's, and the
 * organization's switch for everyone. Members never
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
        "Returns the organization's Workbot default model (null is the deployment's default model), Workbot name (null when the organization set none) and whether Workbot is on for everyone, and for each team, by name, whether it uses the organization's value or its own for each of the three. With Workbot's step limit on (workbotStepLimit), the organization and each team also carry `maxSteps`, how many model calls Workbot may make on one request (null is the deployment's default, 0 is no limit). A member on several teams whose own values for a setting differ gets the organization's value for it; conflictingMemberCount counts them per team. Requires View OpenWork Models settings or Manage OpenWork Models, and the Workbot settings per team feature.",
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
      return c.json(await settingsView(c, organization.id, await stepLimitOn(organization.id, currentMember.userId)))
    },
  )

  app.put(
    "/v1/org/workbot-settings/teams/:teamId",
    describeRoute({
      tags: ["Organizations"],
      summary: "Set a team's Workbot settings",
      description:
        "Changes one team's Workbot default model, Workbot name, whether Workbot is on for the team (`enabled`), or several; a setting left out is kept. For each, `{ inherit: true }` makes the team use the organization's value again and `{ inherit: false, value }` sets the team's own: a model from the caller's supported, credential-ready AI Gateway models (null is the deployment's default model), a name of 1 to 40 characters, or true or false for `enabled`. With Workbot's step limit on (workbotStepLimit), `maxSteps` sets how many model calls Workbot may make on one request for the team's members (1–100,000; null is the deployment's default, 0 is no limit), from each chat's next message; without it `maxSteps` answers 400. The team's members get it from their next message or run, in Workbot, the Slack assistant and cloud Automations set to the cloud default; a member on several teams whose own values differ gets the organization's. `enabled` covers the Workbot app and Your agent only, never the Slack assistant, Automations or the desktop app. A team's model selects a model and never grants access to it. Requires the Manage OpenWork Models permission, which also governs the team's Workbot name and switch, a recent sign-in and the Workbot settings per team feature.",
      responses: {
        200: jsonResponse("Workbot settings per team saved.", workbotTeamSettingsViewSchema),
        400: jsonResponse("The model is not one the runner serves, the step limit isn't on for this organization, or the request was invalid.", z.union([unknownModelSchema, invalidRequestSchema])),
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
      const stepLimit = await stepLimitOn(organizationId, context.currentMember.userId)
      if (change.maxSteps && !stepLimit) return c.json({ error: "invalid_request" as const, message: "Workbot's step limit isn't on for this organization.", details: [] }, 400)
      if (change.model && !change.model.inherit && change.model.value !== null) {
        // The same check as the organization's default model, against the caller's own models.
        const catalog = await workbotModelCatalog({ organizationId, userId: context.currentMember.userId }).catch(() => null)
        // Selecting the managed starter means Default, as for the organization.
        const model = isWorkbotManagedLuna(change.model.value) && change.model.value === catalog?.defaultModel ? null : change.model.value
        const choice = checkWorkbotModelChoice(model, catalog)
        if (choice === "runner_unavailable") return c.json({ error: "workbot_runner_unavailable" as const, message: RUNNER_UNAVAILABLE_MESSAGE }, 503)
        if (choice === "unknown_model") return c.json({ error: "unknown_model" as const, message: UNKNOWN_MODEL_MESSAGE }, 400)
        change = { ...change, model: { inherit: false, value: model } }
      }
      const write = () => saveWorkbotTeamSettings({ organizationId, teamId, change, updatedByOrgMemberId: context.currentMember.id })
      try {
        await write()
      } catch (error) {
        // A concurrent first save of the same team created the row; apply the change to it.
        if (!isDuplicateEntry(error)) throw error
        await write()
      }
      return c.json(await settingsView(c, organizationId, stepLimit))
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
      if (enabled !== undefined) await updateOrganizationMetadata(organizationId, (current) => withWorkbotEnabled(current, enabled))
      return c.json(await settingsView(c, organizationId, await stepLimitOn(organizationId, context.currentMember.userId)))
    },
  )
}
