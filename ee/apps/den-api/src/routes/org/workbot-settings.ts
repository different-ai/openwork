import { readWorkbotModel, withWorkbotModel, isWorkbotManagedLuna, workbotModelTestSchema, workbotSettingsInputSchema, workbotSettingsSchema } from "@openwork/types/den/workbot-settings"
import {
  mergeAgentTemplate,
  mergeWorkbotProactiveSettings,
  readWorkbotProactiveSettings,
  withWorkbotProactiveSettings,
  workbotProactiveSettingsInputSchema,
  workbotProactiveHealthSchema,
  workbotProactiveViewSchema,
  AGENT_RESPONSIBILITIES,
  type WorkbotProactiveHealth,
  type WorkbotProactiveSettings,
  type WorkbotProactiveView,
} from "@openwork/types/den/workbot-proactive"
import type { Hono } from "hono"
import { describeRoute } from "hono-openapi"
import { z } from "zod"
import { requireFeature } from "../../features.js"
import { jsonValidator, orgMemberRoute, requireOrgPermission, userSessionRoute } from "../../middleware/index.js"
import { proactiveRunnerReady, readProactiveSettings } from "../../workbot-proactive/access.js"
import { workbotSlackAppReady } from "../../slack-assistant/direct-message.js"
import { readAgentTemplate, saveAgentTemplate, type AgentTemplateVersion } from "../../workbot-proactive/template.js"
import { readAgentChecks, readAgentMutes } from "../../workbot-proactive/repository.js"
import { workbotOrigin } from "../../workbot/config.js"
import { checkRateLimit } from "../../utils/rate-limit.js"
import { testOrganizationWorkbotModel } from "../../workbot/model-test.js"
import { forbiddenSchema, invalidRequestSchema, jsonResponse, unauthorizedSchema } from "../../openapi.js"
import { updateOrganizationMetadata } from "../../organization-metadata.js"
import {
  checkWorkbotModelChoice,
  workbotModelCatalog,
  readOrganizationDefaultModel,
  workbotSettingsView,
} from "../../workbot/model.js"
import { memberPermissionsForRequest, type OrgRouteVariables } from "./shared.js"

const workbotSettingsDocumentSchema = workbotSettingsSchema.meta({ ref: "WorkbotSettings" })
const workbotSettingsInputDocumentSchema = workbotSettingsInputSchema.meta({ ref: "WorkbotSettingsInput" })
const featureDisabledSchema = z.object({ error: z.literal("feature_disabled"), feature: z.string() })
const unknownModelSchema = z.object({ error: z.literal("unknown_model"), message: z.string() }).meta({ ref: "WorkbotUnknownModelError" })
const runnerUnavailableSchema = z
  .object({ error: z.literal("workbot_runner_unavailable"), message: z.string() })
  .meta({ ref: "WorkbotRunnerUnavailableError" })

export const UNKNOWN_MODEL_MESSAGE = "Workbot can't use that model. Choose one from the list."
export const RUNNER_UNAVAILABLE_MESSAGE = "Workbot's models can't be checked right now. Try again in a minute."

const notFound = jsonResponse("The organization was not found, or Workbot is off.", featureDisabledSchema)

const requireWorkbotSettingsRead: ReturnType<typeof requireOrgPermission> = async (c, next) => {
  if ((await memberPermissionsForRequest(c))?.has("inference.manage")) return next()
  return requireOrgPermission("inference.view")(c, next)
}

/** Your agent needs Workbot on this deployment, the same capability that gates Workbot itself. */
const requireWorkbotDeployed: ReturnType<typeof requireOrgPermission> = async (c, next) => {
  if (workbotOrigin() === null) return c.json({ error: "feature_disabled" as const, feature: "workbot" }, 404)
  return next()
}

const workbotProactiveViewDocumentSchema = workbotProactiveViewSchema.meta({ ref: "WorkbotProactiveSettings" })
const workbotProactiveHealthDocumentSchema = workbotProactiveHealthSchema.meta({ ref: "WorkbotProactiveHealth" })
const workbotProactiveInputDocumentSchema = workbotProactiveSettingsInputSchema.meta({ ref: "WorkbotProactiveSettingsInput" })
const invalidHoursSchema = z.object({ error: z.literal("invalid_working_hours"), message: z.string() }).meta({ ref: "WorkbotProactiveInvalidHoursError" })
export const INVALID_WORKING_HOURS_MESSAGE = "The workday must end after it starts."

async function proactiveView(organizationId: string, settings: WorkbotProactiveSettings, template: AgentTemplateVersion): Promise<WorkbotProactiveView> {
  const { versionId, version, responsibilities, instructions } = template
  return {
    settings,
    template: { versionId, version, responsibilities, instructions },
    slackReady: await workbotSlackAppReady(organizationId),
    runnerReady: proactiveRunnerReady(),
  }
}

/**
 * Manage › Workbot: the organization's default model for its cloud agents (Workbot, the Slack assistant, and cloud
 * Automations set to the cloud default). Admins choose it from their AI Gateway models.
 */
export function registerOrgWorkbotSettingsRoutes<T extends { Variables: OrgRouteVariables }>(app: Hono<T>) {
  app.get(
    "/v1/org/workbot-settings/proactive",
    describeRoute({
      tags: ["Organizations"],
      summary: "Get the settings for members' agents",
      description:
        "Returns how members' agents work in this organization (Manage › Workbot): whether they are on, working hours, the daily limit per member, whether members start opted in, the default place messages go (a DM from the Workbot Slack app), and the current \"Your agent\" template version (responsibilities and organization instructions). Also says whether the Workbot Slack app is installed to send those DMs and whether the headless runner the agents run on is configured. Requires the workbotProactive feature, Workbot on this deployment, and View OpenWork Models settings or Manage OpenWork Models.",
      responses: {
        200: jsonResponse("Agent settings returned.", workbotProactiveViewDocumentSchema),
        401: jsonResponse("Authentication required.", unauthorizedSchema),
        403: jsonResponse("The caller lacks both View OpenWork Models settings and Manage OpenWork Models.", forbiddenSchema),
        404: notFound,
      },
    }),
    orgMemberRoute(),
    requireFeature("workbotProactive"),
    requireWorkbotDeployed,
    requireWorkbotSettingsRead,
    async (c) => {
      c.header("Cache-Control", "no-store")
      const organizationId = c.get("organizationContext").organization.id
      return c.json(await proactiveView(organizationId, await readProactiveSettings(organizationId), await readAgentTemplate(organizationId)))
    },
  )

  app.get(
    "/v1/org/workbot-settings/proactive/health",
    describeRoute({
      tags: ["Organizations"],
      summary: "Get how members' agents are doing",
      description:
        "For the last 7 days (UTC) and each responsibility: how many checks members' agents ran about it, how many of those stayed quiet, how many messages it produced, and how many members muted it, with the number of members who have an agent. Counts only: no member names, message text or email content. Requires the workbotProactive and workbotAgentHealthView features, Workbot on this deployment, and View OpenWork Models settings or Manage OpenWork Models.",
      responses: {
        200: jsonResponse("Agent health returned.", workbotProactiveHealthDocumentSchema),
        401: jsonResponse("Authentication required.", unauthorizedSchema),
        403: jsonResponse("The caller lacks both View OpenWork Models settings and Manage OpenWork Models.", forbiddenSchema),
        404: notFound,
      },
    }),
    orgMemberRoute(),
    requireFeature("workbotProactive"),
    requireFeature("workbotAgentHealthView"),
    requireWorkbotDeployed,
    requireWorkbotSettingsRead,
    async (c) => {
      c.header("Cache-Control", "no-store")
      const organizationId = c.get("organizationContext").organization.id
      const days = 7
      const from = new Date(Date.now() - (days - 1) * 86_400_000).toISOString().slice(0, 10)
      const [checks, mutes] = [await readAgentChecks(organizationId, from), await readAgentMutes(organizationId)]
      const health: WorkbotProactiveHealth = {
        days,
        members: mutes.members,
        responsibilities: AGENT_RESPONSIBILITIES.map((id) => {
          const counted = checks.find((entry) => entry.responsibility === id)
          return { id, checks: counted?.checks ?? 0, quiet: counted?.quiet ?? 0, sent: counted?.sent ?? 0, muted: mutes.muted.get(id) ?? 0 }
        }),
      }
      return c.json(health)
    },
  )

  app.put(
    "/v1/org/workbot-settings/proactive",
    describeRoute({
      tags: ["Organizations"],
      summary: "Change the settings for members' agents",
      description:
        "Changes any subset of how members' agents work. Policy fields (on/off, working hours, daily limit, members' starting choice, default destination: a Workbot DM or nowhere, never a channel) apply from the next pass; members' own choices (muted, snoozed, turned off, their own destination) are kept. A change to responsibilities or instructions saves a new version of the organization's \"Your agent\" template. Agents only read members' email and calendar and never act for them. Requires the workbotProactive feature, Workbot on this deployment and Manage OpenWork Models.",
      responses: {
        200: jsonResponse("Agent settings saved.", workbotProactiveViewDocumentSchema),
        400: jsonResponse("The request was invalid, or the workday would end before it starts.", z.union([invalidHoursSchema, invalidRequestSchema])),
        401: jsonResponse("Authentication required.", unauthorizedSchema),
        403: jsonResponse("The caller lacks the Manage OpenWork Models permission.", forbiddenSchema),
        404: notFound,
      },
    }),
    orgMemberRoute(),
    requireFeature("workbotProactive"),
    requireWorkbotDeployed,
    requireOrgPermission("inference.manage"),
    jsonValidator(workbotProactiveInputDocumentSchema),
    async (c) => {
      c.header("Cache-Control", "no-store")
      const { organization, currentMember } = c.get("organizationContext")
      const change = c.req.valid("json")
      const result: { settings: WorkbotProactiveSettings | null } = { settings: null }
      await updateOrganizationMetadata(organization.id, (current) => {
        result.settings = mergeWorkbotProactiveSettings(readWorkbotProactiveSettings(current), change)
        return result.settings ? withWorkbotProactiveSettings(current, result.settings) : current
      })
      if (!result.settings) return c.json({ error: "invalid_working_hours" as const, message: INVALID_WORKING_HOURS_MESSAGE }, 400)
      const current = await readAgentTemplate(organization.id)
      const content = mergeAgentTemplate(current, change)
      const template = content ? await saveAgentTemplate({ organizationId: organization.id, memberId: currentMember.id, content }) : current
      return c.json(await proactiveView(organization.id, result.settings, template))
    },
  )

  app.post(
    "/v1/org/workbot-settings/test-default-model",
    describeRoute({
      tags: ["Organizations"],
      summary: "Test Workbot's default model",
      description: "Runs one bounded synthetic completion on the server-resolved organization default with the signed-in member's AI Gateway access. No member content, tools, files, MCP access or conversation is used. May consume paid inference. Returns only status, a safe error code and requested/provider-reported model IDs. Requires a genuine user session, recent sign-in, Manage OpenWork Models. Limited durably to three checks per organization and three per member in a ten-minute inactivity-reset window. Never exposed to MCP.",
      ...{ "x-mcp": false },
      responses: {
        200: jsonResponse("Synthetic completion result; catalog availability alone never means answered.", workbotModelTestSchema.meta({ ref: "WorkbotModelTest" })),
        400: jsonResponse("Only an empty request body is accepted.", invalidRequestSchema),
        401: jsonResponse("Authentication required.", unauthorizedSchema),
        403: jsonResponse("A genuine recent user sign-in and Manage OpenWork Models are required.", forbiddenSchema),
        404: notFound,
        429: jsonResponse("The durable diagnostic request limit was reached.", z.object({ error: z.literal("rate_limited"), retryAfterSeconds: z.number() })),
      },
    }),
    orgMemberRoute(),
    userSessionRoute(),
    requireOrgPermission("inference.manage"),
    jsonValidator(z.strictObject({})),
    async (c) => {
      c.header("Cache-Control", "no-store")
      const context = c.get("organizationContext")
      const windowMs = 10 * 60_000
      for (const key of [`workbot-model-test:org:${context.organization.id}`, `workbot-model-test:member:${context.currentMember.id}`]) {
        const retryAfterSeconds = await checkRateLimit(key, 3, windowMs, Date.now())
        if (retryAfterSeconds !== null) {
          c.header("Retry-After", String(retryAfterSeconds))
          return c.json({ error: "rate_limited", retryAfterSeconds }, 429)
        }
      }
      return c.json(await testOrganizationWorkbotModel(context.organization.id, context.currentMember.userId))
    },
  )

  app.get(
    "/v1/org/workbot-settings",
    describeRoute({
      tags: ["Organizations"],
      summary: "Get Workbot settings",
      description:
        "Returns the organization's default model for Workbot, the Slack assistant and cloud Automations set to the cloud default (null means the caller's AI Gateway default), and the caller's credential-ready, supported Gateway assignments. defaultModel identifies that default and defaultReadiness reports whether it is available; an organization default never grants inference access. With workbotIncludedModels or workbotUsageRecovery, Workbot’s default is free Auto or paid Models Luna using this member’s entitlement; no custom provider is needed. Requires View OpenWork Models settings or Manage OpenWork Models.",
      responses: {
        200: jsonResponse("Workbot settings returned.", workbotSettingsDocumentSchema),
        401: jsonResponse("Authentication required.", unauthorizedSchema),
        403: jsonResponse("The caller lacks both View OpenWork Models settings and Manage OpenWork Models.", forbiddenSchema),
        404: notFound,
      },
    }),
    orgMemberRoute(),
    requireWorkbotSettingsRead,
    async (c) => {
      c.header("Cache-Control", "no-store")
      const context = c.get("organizationContext")
      const actor = { organizationId: context.organization.id, userId: context.currentMember.userId }
      const chosen = await readOrganizationDefaultModel(actor.organizationId)
      // Gateway projections are live and actor-scoped; never put them in the deployment catalog cache.
      const catalog = await workbotModelCatalog(actor).catch(() => null)
      return c.json(workbotSettingsView(chosen, catalog))
    },
  )

  app.put(
    "/v1/org/workbot-settings",
    describeRoute({
      tags: ["Organizations"],
      summary: "Set Workbot's default model",
      description:
        "Sets the organization's default model for Workbot, the Slack assistant and cloud Automations set to the cloud default, from their next message or run; null uses the AI Gateway default. Automations with their own model keep it. Only the caller's supported, credential-ready Gateway aliases are accepted. Each executing member still needs their own assignment and credentials. With workbotIncludedModels or workbotUsageRecovery, selecting the managed Luna starter keeps the shared saved choice null; other cloud agents retain their existing default policy. Requires the Manage OpenWork Models permission and a recent sign-in.",
      responses: {
        200: jsonResponse("Workbot settings saved.", workbotSettingsDocumentSchema),
        400: jsonResponse("The model is not one the runner serves, or the request was invalid.", z.union([unknownModelSchema, invalidRequestSchema])),
        401: jsonResponse("Authentication required.", unauthorizedSchema),
        403: jsonResponse("The caller lacks the Manage OpenWork Models permission or needs to sign in again.", forbiddenSchema),
        404: notFound,
        503: jsonResponse("The headless runner could not be reached to check the model.", runnerUnavailableSchema),
      },
    }),
    orgMemberRoute(),
    requireOrgPermission("inference.manage"),
    jsonValidator(workbotSettingsInputDocumentSchema),
    async (c) => {
      c.header("Cache-Control", "no-store")
      const context = c.get("organizationContext")
      const organizationId = context.organization.id
      const actor = { organizationId, userId: context.currentMember.userId }
      const { model: requestedModel } = c.req.valid("json")
      const catalog = await workbotModelCatalog(actor).catch(() => null)
      // Selecting the managed starter means Default. Do not save a Workbot-only route as Slack/Automation policy.
      const model = isWorkbotManagedLuna(requestedModel) && requestedModel === catalog?.defaultModel ? null : requestedModel
      const choice = checkWorkbotModelChoice(model, catalog)
      if (choice === "runner_unavailable") return c.json({ error: "workbot_runner_unavailable" as const, message: RUNNER_UNAVAILABLE_MESSAGE }, 503)
      if (choice === "unknown_model") return c.json({ error: "unknown_model" as const, message: UNKNOWN_MODEL_MESSAGE }, 400)
      const metadata = await updateOrganizationMetadata(organizationId, (current) => withWorkbotModel(current, model))
      return c.json(workbotSettingsView(readWorkbotModel(metadata), catalog))
    },
  )
}
