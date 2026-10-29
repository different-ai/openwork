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
import { jsonValidator, orgMemberRoute, paramValidator, requireOrgPermission, userSessionRoute } from "../../middleware/index.js"
import { proactiveRunnerReady, readProactiveSettings } from "../../workbot-proactive/access.js"
import { workbotSlackAppReady } from "../../slack-assistant/direct-message.js"
import { readAgentTemplate, saveAgentTemplate, type AgentTemplateVersion } from "../../workbot-proactive/template.js"
import { readAgentChecks, readAgentMutes } from "../../workbot-proactive/repository.js"
import { checkSourcesChange, groupSourceConnections, sourceToolOptions, type SourceToolOption } from "../../workbot-proactive/sources.js"
import { listOrganizationSourceConnections } from "../../workbot-proactive/sources-repository.js"
import { getExternalMcpConnection } from "../../capability-sources/external-mcp-connections.js"
import { isToolDisabled } from "../../capability-sources/external-mcp-tool-policy.js"
import { listExternalMcpToolCatalog } from "./mcp-connections.js"
import { normalizeDenTypeId, type DenTypeId } from "@openwork-ee/utils/typeid"
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
const sourceToolSchema = z.object({ name: z.string(), description: z.string().optional(), readOnlyHint: z.boolean().optional(), blocked: z.boolean() })
const sourceToolsDocumentSchema = z.object({ tools: z.array(sourceToolSchema) }).meta({ ref: "WorkbotProactiveSourceTools" })
const sourceToolsErrorSchema = z.object({ error: z.enum(["connection_not_found", "connection_not_ready", "tool_catalog_failed", "forbidden", "invalid_request"]), message: z.string() })

/** An MCP connection's tools as an admin approves them for agents: blocked ones marked. Null when it isn't one. */
async function sourceTools(organizationId: DenTypeId<"organization">, connectionId: string, memberId: DenTypeId<"member">, requestId: string): Promise<
  | { ok: true; tools: SourceToolOption[] }
  | { ok: false; status: 404 | 409 | 502; error: "connection_not_found" | "connection_not_ready" | "tool_catalog_failed"; message: string }
> {
  const connection = connectionId.startsWith("emc_")
    ? await getExternalMcpConnection({ organizationId, connectionId: normalizeDenTypeId("externalMcpConnection", connectionId) }).catch(() => null)
    : null
  if (!connection || connection.kind !== "external_mcp") return { ok: false, status: 404, error: "connection_not_found", message: "No MCP connection with that id in this organization." }
  const listed = await listExternalMcpToolCatalog(connection, memberId, requestId)
  if (!listed.ok) return listed.reason === "not_ready"
    ? { ok: false, status: 409, error: "connection_not_ready", message: listed.message }
    : { ok: false, status: 502, error: "tool_catalog_failed", message: listed.message }
  return { ok: true, tools: sourceToolOptions(listed.tools, (name) => isToolDisabled(connection.toolPolicy, name)) }
}

async function proactiveView(organizationId: DenTypeId<"organization">, settings: WorkbotProactiveSettings, template: AgentTemplateVersion, canViewConnections: boolean): Promise<WorkbotProactiveView> {
  const { versionId, version, responsibilities, instructions } = template
  return {
    settings,
    template: { versionId, version, responsibilities, instructions },
    slackReady: await workbotSlackAppReady(organizationId),
    runnerReady: proactiveRunnerReady(),
    // Connection names and URLs only for callers who may view the organization's connections.
    sourceConnections: canViewConnections ? groupSourceConnections(await listOrganizationSourceConnections(organizationId)) : null,
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
        "Returns how members' agents work in this organization (Manage › Workbot): whether they are on, working hours, the daily limit per member, whether members start opted in, the default place messages go (a DM from the Workbot Slack app), what agents may read (`settings.sources`: calendar, email and team chat, and each other connection by id: `everyone` = on for everyone, `members` = members choose, `off` = not allowed; agents only ever read; `coreConnections` = the connections an admin picked for calendar, email or chat, any of the organization's connections, absent for every connection that serves it; `otherConnections` = the connections in Other context, absent for every connection with reviewed read tools; `readTools` = the tools an admin approved per MCP connection without reviewed read tools) with the organization's connections behind each by default and `sourceConnections.all`, every connection an admin can add with where it can go and whether it needs approved tools (`sourceConnections`, null without View connections; includes Google Workspace or Microsoft 365 set up before connections had their own entries), and the current \"Your agent\" template version (preset responsibilities and organization instructions). Also says whether the Workbot Slack app is installed to send those DMs and whether the headless runner the agents run on is configured. Requires the workbotProactive feature, Workbot on this deployment, and View OpenWork Models settings or Manage OpenWork Models.",
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
      const canViewConnections = (await memberPermissionsForRequest(c))?.has("connections.view") ?? false
      return c.json(await proactiveView(organizationId, await readProactiveSettings(organizationId), await readAgentTemplate(organizationId), canViewConnections))
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

  app.get(
    "/v1/org/workbot-settings/proactive/connections/:connectionId/tools",
    describeRoute({
      tags: ["Organizations"],
      summary: "List an MCP connection's tools for members' agents",
      description:
        "Lists the tools an MCP connection offers, for an admin choosing which ones members' agents may call when the connection is a source (Manage › Workbot › What agents read): each tool's name, its description and read-only hint when the provider gives them, and `blocked` when agents may never call it (its name says it changes something, or it is turned off for the connection). Reads the provider's live tool list with the caller's credential; no tool is called. Requires the workbotProactive feature, Workbot on this deployment, Manage OpenWork Models and View connections.",
      responses: {
        200: jsonResponse("The connection's tools.", sourceToolsDocumentSchema),
        401: jsonResponse("Authentication required.", unauthorizedSchema),
        403: jsonResponse("The caller lacks Manage OpenWork Models or View connections.", z.union([forbiddenSchema, sourceToolsErrorSchema])),
        404: jsonResponse("No MCP connection with that id, or Workbot is off.", z.union([featureDisabledSchema, sourceToolsErrorSchema])),
        409: jsonResponse("The caller has no usable credential for the connection.", sourceToolsErrorSchema),
        502: jsonResponse("The provider's tool list could not be read.", sourceToolsErrorSchema),
      },
    }),
    orgMemberRoute(),
    requireFeature("workbotProactive"),
    requireWorkbotDeployed,
    requireOrgPermission("inference.manage"),
    paramValidator(z.object({ connectionId: z.string().trim().min(1).max(64) })),
    async (c) => {
      c.header("Cache-Control", "no-store")
      const { organization, currentMember } = c.get("organizationContext")
      if (!((await memberPermissionsForRequest(c))?.has("connections.view") ?? false)) {
        return c.json({ error: "forbidden" as const, message: "Viewing connections is needed to choose their tools." }, 403)
      }
      const listed = await sourceTools(organization.id, c.req.valid("param").connectionId, currentMember.id, c.get("requestId"))
      if (!listed.ok) return c.json({ error: listed.error, message: listed.message }, listed.status)
      return c.json({ tools: listed.tools })
    },
  )

  app.put(
    "/v1/org/workbot-settings/proactive",
    describeRoute({
      tags: ["Organizations"],
      summary: "Change the settings for members' agents",
      description:
        "Changes any subset of how members' agents work. Policy fields (on/off, working hours, daily limit, members' starting choice, default destination: a Workbot DM or nowhere, never a channel) apply from the next pass; members' own choices (muted, snoozed, turned off, their own destination) are kept. `sources` sets what agents may read: `calendar`, `email`, `chat` and `connections` by connection id, each `everyone` (on for everyone), `members` (members choose; null also means this) or `off` (not allowed). `sources.coreConnections.{calendar,email,chat}` picks which of the organization's connections serve that source (ids from `sourceConnections`; null goes back to every connection that serves it), so a member's other accounts on the same service are never read or asked for; any MCP connection can serve them too, and an empty list reads nothing. `sources.otherConnections` lists the connections in Other context (null goes back to every connection with reviewed read tools). `sources.readTools.{connectionId}` approves which of an MCP connection's tools agents may call when its service has no reviewed read tools (names from GET .../proactive/connections/{connectionId}/tools; never a blocked one; null removes the approval); such a connection is only a source with at least one approved tool, and a tool whose name says it changes something is never callable. Members can never read a source the admin didn't allow or turn off one that is on for everyone. A change to responsibilities or instructions saves a new version of the organization's \"Your agent\" template. Agents only read and never send, edit or delete anything for members. Requires the workbotProactive feature, Workbot on this deployment and Manage OpenWork Models.",
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
      const requested = c.req.valid("json")
      // Every id is one of the organization's connections, put where it can serve; approved tools are the connection's
      // own and never ones that change things; an MCP without reviewed reads needs at least one approved tool.
      const connections = await listOrganizationSourceConnections(organization.id)
      const catalogs = new Map<string, SourceToolOption[]>()
      for (const [id, tools] of Object.entries(requested.sources?.readTools ?? {})) {
        if (tools === null) continue
        const listed = await sourceTools(organization.id, id, currentMember.id, c.get("requestId"))
        if (listed.ok) catalogs.set(id, listed.tools)
      }
      const invalid: { message: string | null } = { message: null }
      const change = requested
      const result: { settings: WorkbotProactiveSettings | null } = { settings: null }
      await updateOrganizationMetadata(organization.id, (current) => {
        const merged = mergeWorkbotProactiveSettings(readWorkbotProactiveSettings(current), change)
        invalid.message = merged ? checkSourcesChange({ change: change.sources, merged: merged.sources, connections, catalogs }) : null
        result.settings = invalid.message ? null : merged
        return result.settings ? withWorkbotProactiveSettings(current, result.settings) : current
      })
      if (invalid.message) return c.json({ error: "invalid_request" as const, message: invalid.message }, 400)
      if (!result.settings) return c.json({ error: "invalid_working_hours" as const, message: INVALID_WORKING_HOURS_MESSAGE }, 400)
      const current = await readAgentTemplate(organization.id)
      const content = mergeAgentTemplate(current, change)
      const template = content ? await saveAgentTemplate({ organizationId: organization.id, memberId: currentMember.id, content }) : current
      return c.json(await proactiveView(organization.id, result.settings, template, (await memberPermissionsForRequest(c))?.has("connections.view") ?? false))
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
