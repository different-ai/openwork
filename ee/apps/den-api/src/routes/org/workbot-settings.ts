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
  DEFAULT_AGENT_BRIEF,
  agentConnectionToolsViewSchema,
  agentToolOverrides,
  resolveAgentBrief,
  type WorkbotProactiveHealth,
  type WorkbotProactiveSettings,
  type WorkbotProactiveSettingsInput,
  type WorkbotProactiveView,
} from "@openwork/types/den/workbot-proactive"
import type { Hono } from "hono"
import { describeRoute } from "hono-openapi"
import { z } from "zod"
import { requireFeature } from "../../features.js"
import { jsonValidator, orgMemberRoute, paramValidator, requireOrgPermission, userSessionRoute } from "../../middleware/index.js"
import { agentBriefAllowed, proactiveRunnerReady, readProactiveSettings } from "../../workbot-proactive/access.js"
import { AGENT_RHYTHM_COUNTER } from "../../workbot-proactive/repository.js"
import { workbotSlackAppReady } from "../../slack-assistant/direct-message.js"
import { readAgentTemplate, saveAgentTemplate, type AgentTemplateVersion } from "../../workbot-proactive/template.js"
import { readAgentChecks, readAgentMutes } from "../../workbot-proactive/repository.js"
import { checkSourcesChange, groupSourceConnections } from "../../workbot-proactive/sources.js"
import { countConnectedMembers, listConnectionToolsForMember, listOrganizationSourceConnections } from "../../workbot-proactive/sources-repository.js"
import { mcpConnectionToolsView, nativeConnectionToolsView, unlistedConnectionToolsView } from "../../workbot-proactive/agent-tools.js"
import { getCatalog } from "../../mcp/index.js"
import { nativeOperations } from "../../mcp/native-capabilities.js"
import { probeExternalConnectionStatus } from "../../mcp/external-capabilities.js"
import { listTeamsForMember } from "../../member-teams.js"
import type { DenTypeId } from "@openwork-ee/utils/typeid"
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
const agentConnectionToolsDocumentSchema = agentConnectionToolsViewSchema.meta({ ref: "WorkbotAgentConnectionTools" })
const connectionToolsParamsSchema = z.object({ connectionId: z.string().trim().min(1).max(64) })
const connectionNotFoundSchema = z.object({ error: z.literal("connection_not_found"), message: z.string() }).meta({ ref: "WorkbotAgentConnectionNotFound" })
const invalidHoursSchema = z.object({ error: z.literal("invalid_working_hours"), message: z.string() }).meta({ ref: "WorkbotProactiveInvalidHoursError" })
export const INVALID_WORKING_HOURS_MESSAGE = "The workday must end after it starts."

async function proactiveView(organizationId: DenTypeId<"organization">, settings: WorkbotProactiveSettings, template: AgentTemplateVersion, canViewConnections: boolean, briefOn: boolean): Promise<WorkbotProactiveView> {
  const { versionId, version, responsibilities, instructions } = template
  // What admins saved under `brief` is shown resolved (`brief` below), never raw.
  const { brief: _saved, ...policy } = settings
  return {
    settings: policy,
    ...(briefOn ? { brief: { ...resolveAgentBrief(settings, template), defaultText: DEFAULT_AGENT_BRIEF } } : {}),
    template: { versionId, version, responsibilities, instructions },
    slackReady: await workbotSlackAppReady(organizationId),
    runnerReady: proactiveRunnerReady(),
    // Connection names, URLs and counts only for callers who may view the organization's connections.
    sourceConnections: canViewConnections ? await sourceConnectionsView(organizationId, settings, briefOn) : null,
  }
}

async function sourceConnectionsView(organizationId: DenTypeId<"organization">, settings: WorkbotProactiveSettings, briefOn: boolean) {
  const [connections, connectedMembers] = await Promise.all([listOrganizationSourceConnections(organizationId), countConnectedMembers(organizationId)])
  // With the brief on, every connection is listed (`any`); otherwise only services with reviewed read tools.
  return groupSourceConnections(connections, { policy: settings.sources, connectedMembers, mode: briefOn ? "any" : "reviewed" })
}

/**
 * PUT /v1/org/workbot-settings/proactive without the HTTP layer (also used by config-blob imports,
 * src/config-blobs/areas/workbot-proactive.ts): the brief gate, the sources check, the policy merge and the template
 * version, exactly as the route runs them. Permission and feature checks stay with the caller.
 */
export async function saveWorkbotProactiveSettings(input: {
  organizationId: DenTypeId<"organization">
  memberId: DenTypeId<"member">
  userId: string
  change: WorkbotProactiveSettingsInput
}): Promise<
  | { ok: true; settings: WorkbotProactiveSettings; template: AgentTemplateVersion; briefOn: boolean }
  | { ok: false; error: "brief_off" | "invalid_sources" | "invalid_working_hours"; message: string }
> {
  const { organizationId, change } = input
  const briefOn = await agentBriefAllowed(organizationId, input.userId)
  if (change.brief && !briefOn) return { ok: false, error: "brief_off", message: "Your agent's brief isn't on for this organization." }
  // Every id is one of the organization's connections, put where it can serve; an MCP only with reviewed read tools;
  // each core source's default stays one of its allowed connections.
  const invalid = checkSourcesChange({
    change: change.sources,
    connections: await listOrganizationSourceConnections(organizationId),
    current: (await readProactiveSettings(organizationId)).sources,
    mode: briefOn ? "any" : "reviewed",
  })
  if (invalid) return { ok: false, error: "invalid_sources", message: invalid }
  const result: { settings: WorkbotProactiveSettings | null } = { settings: null }
  await updateOrganizationMetadata(organizationId, (current) => {
    result.settings = mergeWorkbotProactiveSettings(readWorkbotProactiveSettings(current), change)
    return result.settings ? withWorkbotProactiveSettings(current, result.settings) : current
  })
  if (!result.settings) return { ok: false, error: "invalid_working_hours", message: INVALID_WORKING_HOURS_MESSAGE }
  const current = await readAgentTemplate(organizationId)
  const content = mergeAgentTemplate(current, change)
  const template = content ? await saveAgentTemplate({ organizationId, memberId: input.memberId, content }) : current
  return { ok: true, settings: result.settings, template, briefOn }
}

/**
 * PUT /v1/org/workbot-settings without the HTTP layer (also used by config-blob imports,
 * src/config-blobs/areas/workbot-settings.ts): only the actor's servable models are accepted.
 */
export async function saveWorkbotDefaultModel(input: { organizationId: DenTypeId<"organization">; userId: string; model: string | null }) {
  const actor = { organizationId: input.organizationId, userId: input.userId }
  const catalog = await workbotModelCatalog(actor).catch(() => null)
  // Selecting the managed starter means Default. Do not save a Workbot-only route as Slack/Automation policy.
  const model = isWorkbotManagedLuna(input.model) && input.model === catalog?.defaultModel ? null : input.model
  const choice = checkWorkbotModelChoice(model, catalog)
  if (choice !== "ok") return { choice, model: null, catalog }
  const metadata = await updateOrganizationMetadata(input.organizationId, (current) => withWorkbotModel(current, model))
  return { choice, model: readWorkbotModel(metadata), catalog }
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
        "Returns how members' agents work in this organization (Manage › Workbot): whether they are on, working hours, the daily limit per member, whether members start opted in, the default place messages go (a DM from the Workbot Slack app), what agents may read (`settings.sources`: calendar, email and team chat, and each other connection by id: `everyone` = on for everyone, `members` = members choose, `off` = not allowed; agents only ever read; `coreConnections` = the connections an admin allowed for calendar, email or chat: Den's own providers for what they serve, or an MCP whose read tools are reviewed; absent for every connection that serves it; `coreDefaults` = the admin's default connection per core source, absent for automatic; each member's agent reads exactly one allowed connection per core source: the one the member picked, else the default when their account on it is ready, else one they already connected, else the default for them to connect; `otherConnections` = the connections in Other context, absent for every connection with reviewed read tools; with Your agent's brief on (workbotAgentBrief) every connection is offered instead, MCP and Den's own providers alike, each `sourceConnections.other` entry with the policy it has now, and `toolOverrides` = an admin's per-tool choices per connection id (`allow` or `deny`)) with the organization's connections behind each by default (each core one with `connectedMembers`, how many members connected their own account on it, null when unknown such as a shared credential), `sourceConnections.all`, every connection an admin can add with where it can go, and `sourceConnections.defaults`, the default each core source uses now (the admin's `coreDefaults` while still allowed, else the allowed connection most members connected) (`sourceConnections`, null without View connections; includes Google Workspace or Microsoft 365 set up before connections had their own entries), and the current \"Your agent\" template version (preset responsibilities and organization instructions). With Your agent's brief on (workbotAgentBrief), `brief` is what agents follow instead of the responsibilities: `checkEveryHours` (a check every 1, 2, 3 or 4 hours inside working hours), `dailyCap` (messages per member per day), `extraChecksPerDay` (extra checks an agent may ask for before something time-sensitive), `text` (what to tell people, in plain text; `defaultText` is the built-in default) and `carriedOver` (fields not saved yet, carried over from the responsibilities, organization instructions and daily limit). Also says whether the Workbot Slack app is installed to send those DMs and whether the headless runner the agents run on is configured. Requires the workbotProactive feature, Workbot on this deployment, and View OpenWork Models settings or Manage OpenWork Models.",
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
      const briefOn = await agentBriefAllowed(organizationId, c.get("organizationContext").currentMember.userId)
      return c.json(await proactiveView(organizationId, await readProactiveSettings(organizationId), await readAgentTemplate(organizationId), canViewConnections, briefOn))
    },
  )

  app.get(
    "/v1/org/workbot-settings/proactive/health",
    describeRoute({
      tags: ["Organizations"],
      summary: "Get how members' agents are doing",
      description:
        "For the last 7 days (UTC) and each responsibility (with Your agent's brief on, `rhythm` counts checks on its one rhythm instead): how many checks members' agents ran about it, how many of those stayed quiet, how many messages it produced, and how many members muted it, with the number of members who have an agent. Counts only: no member names, message text or email content. Requires the workbotProactive feature, Workbot on this deployment, and View OpenWork Models settings or Manage OpenWork Models.",
      responses: {
        200: jsonResponse("Agent health returned.", workbotProactiveHealthDocumentSchema),
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
      const days = 7
      const from = new Date(Date.now() - (days - 1) * 86_400_000).toISOString().slice(0, 10)
      const [checks, mutes] = [await readAgentChecks(organizationId, from), await readAgentMutes(organizationId)]
      const briefOn = await agentBriefAllowed(organizationId, c.get("organizationContext").currentMember.userId)
      const rhythm = checks.find((entry) => entry.responsibility === AGENT_RHYTHM_COUNTER)
      const health: WorkbotProactiveHealth = {
        ...(briefOn ? { rhythm: { checks: rhythm?.checks ?? 0, quiet: rhythm?.quiet ?? 0, sent: rhythm?.sent ?? 0 } } : {}),
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
    "/v1/org/workbot-settings/proactive/sources/:connectionId/tools",
    describeRoute({
      tags: ["Organizations"],
      summary: "Get the tools members' agents may use on a connection",
      description:
        "With Your agent's brief on (workbotAgentBrief): every tool one of the organization's connections lists, and whether members' agents may call it (`allowed`), why (`reason`: `destructive` = its provider marks it destructive, never allowed; `admin_allowed` / `admin_denied` = an admin's choice; `reviewed` / `not_reviewed` = a reviewed list for that service; `marked_read` / `marked_write` = the provider's read-only annotation; `read_name` / `write_name` / `unclear` = its name and description; `native_read` / `native_write` = one of Den's own operations, a GET or not), the admin's choice (`override`) and whether no admin can allow it (`locked`). `readTools` counts the allowed ones. An MCP connection's tools are listed with the caller's own account (`status` `needs_connection` when they haven't connected it, `unavailable` when its server didn't answer); Den's own providers list their operations outside calendar, mail and chat (`coreSourcesElsewhere`), which are read under those sources. Agents only ever read. Requires the workbotProactive and workbotAgentBrief features, Workbot on this deployment, View OpenWork Models settings or Manage OpenWork Models, and View connections.",
      responses: {
        200: jsonResponse("The connection's tools returned.", agentConnectionToolsDocumentSchema),
        401: jsonResponse("Authentication required.", unauthorizedSchema),
        403: jsonResponse("The caller lacks View OpenWork Models settings, Manage OpenWork Models or View connections.", forbiddenSchema),
        404: jsonResponse("The organization was not found, the feature is off, or the connection isn't the organization's.", z.union([featureDisabledSchema, connectionNotFoundSchema])),
      },
    }),
    orgMemberRoute(),
    requireFeature("workbotProactive"),
    requireWorkbotDeployed,
    requireWorkbotSettingsRead,
    requireOrgPermission("connections.view"),
    paramValidator(connectionToolsParamsSchema),
    async (c) => {
      c.header("Cache-Control", "no-store")
      const { organization, currentMember } = c.get("organizationContext")
      if (!(await agentBriefAllowed(organization.id, currentMember.userId))) return c.json({ error: "feature_disabled" as const, feature: "workbotAgentBrief" }, 404)
      const { connectionId } = c.req.valid("param")
      const connection = (await listOrganizationSourceConnections(organization.id)).find((entry) => entry.id === connectionId)
      if (!connection) return c.json({ error: "connection_not_found" as const, message: "No such connection in this organization." }, 404)
      const overrides = agentToolOverrides((await readProactiveSettings(organization.id)).sources, connection.id)
      if (connection.native !== null) {
        const catalog = await getCatalog(app as unknown as Hono, c.env)
        const operations = nativeOperations(catalog, connection.native).map((operation) => ({ name: operation.name, method: operation.method, path: operation.path, summary: operation.operation.summary ?? null }))
        return c.json(nativeConnectionToolsView({ connectionId: connection.id, operations, overrides }))
      }
      const tools = await listConnectionToolsForMember({ organizationId: organization.id, memberId: currentMember.id, connectionId: connection.id })
      if (tools) return c.json(mcpConnectionToolsView({ connectionId: connection.id, url: connection.url, tools, overrides }))
      const member = { orgMembershipId: currentMember.id, teamIds: (await listTeamsForMember({ organizationId: organization.id, memberId: currentMember.id })).map((team) => team.id) }
      const probe = await probeExternalConnectionStatus({ organizationId: organization.id, member, connectionId: connection.id }).catch(() => null)
      return c.json(unlistedConnectionToolsView(connection.id, probe?.ok && probe.connected ? "unavailable" : "needs_connection"))
    },
  )

  app.put(
    "/v1/org/workbot-settings/proactive",
    describeRoute({
      tags: ["Organizations"],
      summary: "Change the settings for members' agents",
      description:
        "Changes any subset of how members' agents work. Policy fields (on/off, working hours, daily limit, members' starting choice, default destination: a Workbot DM or nowhere, never a channel) apply from the next pass; members' own choices (muted, snoozed, turned off, their own destination) are kept. `sources` sets what agents may read: `calendar`, `email`, `chat` and `connections` by connection id, each `everyone` (on for everyone), `members` (members choose; null also means this) or `off` (not allowed). `sources.coreConnections.{calendar,email,chat}` picks which of the organization's connections are allowed for that source (ids from `sourceConnections`; null goes back to every connection that serves it); an MCP connection whose read tools are reviewed (Slack, Linear, Notion, GitHub, Granola) can serve them too, and an empty list reads nothing. `sources.coreDefaults.{calendar,email,chat}` sets the default connection for that source (null goes back to automatic: the allowed one most members connected); it must be allowed after the change, and taking the current default out of the allowed connections is refused (400) unless the same change sets another default. Each member's agent reads exactly one allowed connection per core source (the member's pick, else the default when their account is ready, else one they already connected), so a member is never asked to connect an app they don't use. `sources.otherConnections` lists the connections in Other context (null goes back to every connection with reviewed read tools). An MCP without reviewed read tools can't be a source. With Your agent's brief on (workbotAgentBrief), any connection can be a source (Den's own providers in Other context for what isn't calendar, email or chat), and `sources.toolOverrides` sets, per connection id and tool name, `allow` or `deny` for members' agents (null on a tool goes back to its automatic decision: a reviewed list, the provider's read-only and destructive annotations, then the tool's name; null on a connection clears its choices); a tool its provider marks destructive is never allowed. Members can never read a source the admin didn't allow or turn off one that is on for everyone. With Your agent's brief on (workbotAgentBrief), `brief` sets any of `checkEveryHours` (1, 2, 3 or 4), `dailyCap` (1–10), `extraChecksPerDay` (0–6) and `text` (what to tell people, up to 2,000 characters; members add their own lines); members can check less often or lower the limit, never more. Without it `brief` answers 400. A change to responsibilities or instructions saves a new version of the organization's \"Your agent\" template. Agents only read and never send, edit or delete anything for members. Requires the workbotProactive feature, Workbot on this deployment and Manage OpenWork Models.",
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
      const saved = await saveWorkbotProactiveSettings({ organizationId: organization.id, memberId: currentMember.id, userId: currentMember.userId, change: c.req.valid("json") })
      if (!saved.ok) {
        if (saved.error === "invalid_working_hours") return c.json({ error: "invalid_working_hours" as const, message: saved.message }, 400)
        if (saved.error === "brief_off") return c.json({ error: "invalid_request" as const, message: saved.message, details: [] }, 400)
        return c.json({ error: "invalid_request" as const, message: saved.message }, 400)
      }
      return c.json(await proactiveView(organization.id, saved.settings, saved.template, (await memberPermissionsForRequest(c))?.has("connections.view") ?? false, saved.briefOn))
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
        "Returns the organization's default model for Workbot, the Slack assistant and cloud Automations set to the cloud default (null means the caller's AI Gateway default), and the caller's credential-ready, supported Gateway assignments. defaultModel identifies that default and defaultReadiness reports whether it is available; an organization default never grants inference access. Workbot’s default is free Auto or paid Models Luna using this member’s entitlement; no custom provider is needed. Requires View OpenWork Models settings or Manage OpenWork Models.",
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
        "Sets the organization's default model for Workbot, the Slack assistant and cloud Automations set to the cloud default, from their next message or run; null uses the AI Gateway default. Automations with their own model keep it. Only the caller's supported, credential-ready Gateway aliases are accepted. Each executing member still needs their own assignment and credentials. Selecting the managed Luna starter keeps the shared saved choice null; other cloud agents retain their existing default policy. Requires the Manage OpenWork Models permission and a recent sign-in.",
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
      const saved = await saveWorkbotDefaultModel({ organizationId: context.organization.id, userId: context.currentMember.userId, model: c.req.valid("json").model })
      if (saved.choice === "runner_unavailable") return c.json({ error: "workbot_runner_unavailable" as const, message: RUNNER_UNAVAILABLE_MESSAGE }, 503)
      if (saved.choice === "unknown_model") return c.json({ error: "unknown_model" as const, message: UNKNOWN_MODEL_MESSAGE }, 400)
      return c.json(workbotSettingsView(saved.model, saved.catalog))
    },
  )
}
