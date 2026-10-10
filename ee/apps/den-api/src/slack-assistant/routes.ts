import { randomBytes } from "node:crypto"
import type { Context, Hono } from "hono"
import { bodyLimit } from "hono/body-limit"
import { describeRoute } from "hono-openapi"
import { z } from "zod"
import { and, eq, gt } from "@openwork-ee/den-db/drizzle"
import {
  SlackAssistantInstallationTable as Installation,
  SlackAssistantOAuthStateTable as State,
  ExternalMcpConnectionTable,
  MemberTable,
} from "@openwork-ee/den-db/schema"
import { normalizeDenTypeId } from "@openwork-ee/utils/typeid"
import { attributeAuditRequest, auditServiceAttribution, auditSessionUserAttribution } from "../audit/request-capture.js"
import { appLogger } from "../observability/logger.js"
import { db } from "../db.js"
import { env } from "../env.js"
import {
  forbiddenSchema,
  invalidRequestSchema,
  jsonResponse,
  notFoundSchema,
  okSchema,
  textResponse,
  unauthorizedSchema,
} from "../openapi.js"
import { paramValidator, jsonValidator, orgPermissionRoute, publicRoute, signedWebhookRoute } from "../middleware/index.js"
import {
  idParamSchema,
  orgAccessFailureStatus,
  type OrgRouteVariables,
} from "../routes/org/shared.js"
import { resolvePermissionsForMember } from "../permissions/resolve.js"
import { ensureFreshPrivilegedSession } from "../privileged-session.js"
import { getExternalMcpConnection } from "../capability-sources/external-mcp-connections.js"
import { getOrgOAuthClient } from "../capability-sources/oauth-credentials.js"
import { listHeadlessModels, slackRunnerAvailable } from "./headless.js"
import { getOrganizationFeatures } from "../features.js"
import { defaultModelFeatureOn, organizationDefaultModel } from "../workbot/model.js"
import { publicRequestUrl } from "../request-url.js"
import { openworkYourConnectionsUrl } from "../mcp/connection-navigation.js"
import {
  BOT_SCOPES,
  REQUIRED_BOT_SCOPES,
  isInvocation,
  scopeKey,
  slackEnvelopeSchema,
  slackManifest,
  verifySlackSignature,
} from "./protocol.js"
import {
  recordSlackFeedback,
  slackAssistantMetrics,
  enqueueSlackEvent,
  getInstallation,
  isSlackConnection,
  slackAssistantEnabledForInstallation,
} from "./repository.js"

const connectionParams = idParamSchema("connectionId", "externalMcpConnection")
const configSchema = z.object({
  enabled: z.boolean(),
  signingSecret: z.string().min(16).max(512).optional(),
  channelIds: z
    .array(z.string().regex(/^[CG][A-Z0-9]+$/))
    .max(100)
    .default([]),
  shadowMode: z.boolean().default(false),
  dailyLimit: z.number().int().min(1).max(1000).default(100),
  model: z
    .string()
    .regex(/^[A-Za-z0-9._:/-]{1,255}$/)
    .nullable()
    .optional()
    .describe("Gateway model alias for headless runs; null restores the runner default. Omit to keep the current model."),
  progressUpdates: z
    .boolean()
    .optional()
    .describe(
      "Show steps and notes in Slack while a task works. Off (the default) shows only Slack's working status, then the answer. Omit to keep the current setting.",
    ),
})
function publicBase(request: Request) {
  return env.apiPublicUrl ?? publicRequestUrl(request, { trustedOrigins: env.publicUrlTrustedOrigins }).origin
}
const setupResponseSchema = z.object({
  enabled: z.boolean(),
  installed: z.boolean(),
  teamId: z.string().nullable(),
  rolloutEnabled: z.boolean().describe("Whether the platform admin enabled Slack Assistant for this organization."),
  hasSigningSecret: z.boolean(),
  eligible: z.boolean(),
  runnerAvailable: z
    .boolean()
    .describe("Whether this deployment has the headless runner Slack replies run on. Without it the assistant can't be enabled."),
  channelIds: z.array(z.string()),
  shadowMode: z.boolean(),
  dailyLimit: z.number().int(),
  model: z.string().nullable().describe("Model chosen for Slack runs, or null for the runner default."),
  modelManagedByOrganization: z
    .boolean()
    .optional()
    .describe("The organization's default model (Manage › Workbot) is used instead of a model chosen here; `model` is that model."),
  defaultModel: z.string().nullable().describe("The headless runner's default model, when the runner is available."),
  progressUpdates: z.boolean().describe("Whether Slack shows steps and notes while a task works, or only its working status."),
  models: z
    .array(z.object({ id: z.string(), name: z.string() }))
    .describe("Models the headless runner can use; empty when the runner is unavailable."),
  metrics: z.object({
    completed: z.number().int(),
    failed: z.number().int(),
    active: z.number().int(),
    awaitingConnection: z.number().int(),
    helpful: z.number().int(),
    needsWork: z.number().int(),
    firstTextMedianMs: z.number().nullable(),
    finalMedianMs: z.number().nullable(),
    sampledEvents: z.number().int(),
  }),
  manifest: z.record(z.string(), z.unknown()).describe("Slack app manifest to import when configuring the bot."),
})
const setupErrorSchema = z.object({
  error: z.enum([
    "individual_accounts_required",
    "signing_secret_required",
    "setup_required",
    "browser_session_required",
    "slack_assistant_not_enabled",
    "slack_runner_unavailable",
  ]),
  message: z.string().optional(),
})
const adminResponses = {
  400: jsonResponse("Invalid parameters or incomplete Slack setup.", z.union([invalidRequestSchema, setupErrorSchema])),
  401: jsonResponse("Authentication required.", unauthorizedSchema),
  403: jsonResponse(
    "Permission, recent verification, or Slack eligibility required.",
    z.union([forbiddenSchema, setupErrorSchema]),
  ),
  404: jsonResponse("Organization or connection not found.", notFoundSchema),
}
const rejectedWebhookSchema = z.object({ ok: z.literal(false) })
const webhookResponses = {
  400: jsonResponse("Invalid parameters or Slack payload.", z.union([invalidRequestSchema, rejectedWebhookSchema])),
  401: jsonResponse("Missing installation or invalid Slack signature.", rejectedWebhookSchema),
  403: jsonResponse("Slack workspace or app does not match this installation.", rejectedWebhookSchema),
  413: textResponse("Slack payload exceeds the request size limit."),
}

/**
 * A request signed with this installation's Slack signing secret proves the
 * installation, whose organization is the audit tenant (origin webhook).
 */
async function attributeSlackInstallation(c: Context, installation: { organizationId: string; connectionId: string }) {
  const audited = await attributeAuditRequest(c, {
    organizationId: installation.organizationId, origin: "webhook",
    ...auditServiceAttribution("slack_installation", installation.connectionId),
  })
  return audited.ok ? null : audited.response
}

export function registerSlackAssistantRoutes<T extends { Variables: OrgRouteVariables }>(app: Hono<T>) {
  app.get(
    "/v1/mcp-connections/:connectionId/slack-assistant",
    describeRoute({
      tags: ["Authentication"],
      summary: "Read Slack assistant setup",
      description:
        "Read connector configuration, organization eligibility, recent activity metrics, and the Slack app manifest. Requires the View all connections permission; stored credentials are never returned.",
      responses: { ...adminResponses, 200: jsonResponse("Slack assistant setup.", setupResponseSchema) },
    }),
    orgPermissionRoute("connections.view"),
    paramValidator(connectionParams),
    async (c) => {
      const org = c.get("organizationContext")
      if (!org) return c.json({ error: "forbidden" }, 403)
      const connectionId = normalizeDenTypeId("externalMcpConnection", c.req.param("connectionId"))
      const connection = await getExternalMcpConnection({ organizationId: org.organization.id, connectionId })
      if (!connection) return c.json({ error: "not_found" }, 404)
      const installation = await getInstallation(connectionId)
      const features = await getOrganizationFeatures(org.organization.id)
      const runnerAvailable = slackRunnerAvailable()
      const catalog = runnerAvailable ? await listHeadlessModels() : null
      return c.json({
        enabled: installation?.enabled ?? false,
        installed: Boolean(installation?.botToken),
        teamId: installation?.teamId ?? null,
        rolloutEnabled: features.slackAssistant,
        hasSigningSecret: Boolean(installation?.signingSecret),
        eligible: isSlackConnection(connection),
        runnerAvailable,
        channelIds: installation?.channelIds ?? [],
        shadowMode: installation?.shadowMode ?? false,
        dailyLimit: installation?.dailyLimit ?? 100,
        ...(defaultModelFeatureOn(features)
          ? { model: await organizationDefaultModel(org.organization.id, { features: async () => features }), modelManagedByOrganization: true }
          : { model: installation?.model ?? null, modelManagedByOrganization: false }),
        defaultModel: catalog?.defaultModel ?? null,
        progressUpdates: installation?.progressUpdates ?? false,
        models: catalog?.models ?? [],
        metrics: await slackAssistantMetrics(connectionId),
        manifest: slackManifest(publicBase(c.req.raw), connectionId),
      })
    },
  )
  app.put(
    "/v1/mcp-connections/:connectionId/slack-assistant",
    describeRoute({
      tags: ["Authentication"],
      summary: "Configure Slack assistant installation",
      description:
        "Save the connector's Slack assistant settings and optionally replace its signing secret. Enabling requires the platform capability and the deployment's headless runner. Requires the Manage connections permission, a browser session and recent verification.",
      responses: {
        ...adminResponses,
        200: jsonResponse("Slack assistant settings saved.", okSchema),
        409: jsonResponse("Connection changed while saving.", z.object({ error: z.literal("connection_changed") })),
      },
    }),
    orgPermissionRoute("connections.manage"),
    paramValidator(connectionParams),
    jsonValidator(configSchema),
    async (c) => {
      // connections.manage is not sensitive; Slack assistant setup keeps its recent sign-in check.
      const fresh = ensureFreshPrivilegedSession(c)
      if (!fresh.ok) return c.json(fresh.response, orgAccessFailureStatus(fresh.response))
      const org = c.get("organizationContext")
      if (!org || !c.get("session")) return c.json({ error: "browser_session_required" }, 403)
      const connectionId = normalizeDenTypeId("externalMcpConnection", c.req.param("connectionId"))
      const connection = await getExternalMcpConnection({ organizationId: org.organization.id, connectionId })
      if (!connection || !isSlackConnection(connection))
        return c.json(
          { error: "individual_accounts_required", message: "Choose a Slack connection in Individual accounts mode." },
          400,
        )
      const features = await getOrganizationFeatures(org.organization.id)
      // While the organization's default model applies, the installation's own model is kept as it was.
      const { model: _keptModel, ...settings } = c.req.valid("json")
      const body = defaultModelFeatureOn(features) ? settings : c.req.valid("json")
      if (body.enabled && !features.slackAssistant) {
        return c.json(
          {
            error: "slack_assistant_not_enabled",
            message: "A platform admin must enable Slack Assistant for this workspace in /admin.",
          },
          403,
        )
      }
      if (body.enabled && !slackRunnerAvailable())
        return c.json(
          {
            error: "slack_runner_unavailable",
            message: "The Slack assistant runs on OpenWork's headless runner, which this deployment doesn't have.",
          },
          403,
        )
      const previous = await getInstallation(connectionId)
      const signingSecret = body.signingSecret ?? previous?.signingSecret
      if (!signingSecret) return c.json({ error: "signing_secret_required" }, 400)
      const saved = await db.transaction(async (tx) => {
        const [current] = await tx
          .select()
          .from(ExternalMcpConnectionTable)
          .where(
            and(
              eq(ExternalMcpConnectionTable.id, connectionId),
              eq(ExternalMcpConnectionTable.organizationId, org.organization.id),
            ),
          )
          .for("update")
        if (!current || !isSlackConnection(current)) return false
        await tx
          .insert(Installation)
          .values({ connectionId, organizationId: org.organization.id, ...body, signingSecret })
          .onDuplicateKeyUpdate({ set: { ...body, signingSecret } })
        return true
      })
      if (!saved) return c.json({ error: "connection_changed" }, 409)
      return c.json({ ok: true })
    },
  )
  app.post(
    "/v1/mcp-connections/:connectionId/slack-assistant/install",
    describeRoute({
      tags: ["Authentication"],
      summary: "Start Slack bot installation",
      description:
        "Create a short-lived, single-use OAuth state tied to the installing admin and return the Slack authorization URL. The connector must already have OAuth credentials and a signing secret configured.",
      responses: {
        ...adminResponses,
        200: jsonResponse("Slack bot authorization URL.", z.object({ url: z.string().url() })),
      },
    }),
    orgPermissionRoute("connections.manage"),
    paramValidator(connectionParams),
    async (c) => {
      // connections.manage is not sensitive; Slack assistant installation keeps its recent sign-in check.
      const fresh = ensureFreshPrivilegedSession(c)
      if (!fresh.ok) return c.json(fresh.response, orgAccessFailureStatus(fresh.response))
      const org = c.get("organizationContext")
      if (!org || !c.get("session")) return c.json({ error: "browser_session_required" }, 403)
      const connectionId = normalizeDenTypeId("externalMcpConnection", c.req.param("connectionId"))
      const connection = await getExternalMcpConnection({ organizationId: org.organization.id, connectionId })
      if (!connection || !isSlackConnection(connection)) return c.json({ error: "individual_accounts_required" }, 400)
      const client = await getOrgOAuthClient(org.organization.id, connectionId)
      if (!client?.clientSecret || !(await getInstallation(connectionId)))
        return c.json(
          {
            error: "setup_required",
            message: "Configure this connector's Slack OAuth client and save its signing secret first.",
          },
          400,
        )
      const nonce = randomBytes(32).toString("base64url")
      await db.insert(State).values({
        id: scopeKey(nonce),
        connectionId,
        memberId: org.currentMember.id,
        expiresAt: new Date(Date.now() + 600_000),
      })
      const url = new URL("https://slack.com/oauth/v2/authorize")
      url.searchParams.set("client_id", client.clientId)
      url.searchParams.set("scope", BOT_SCOPES.join(","))
      url.searchParams.set("state", nonce)
      url.searchParams.set("redirect_uri", `${publicBase(c.req.raw)}/v1/integrations/slack/oauth/callback`)
      return c.json({ url: url.toString() })
    },
  )
  app.get(
    "/v1/integrations/slack/oauth/callback",
    describeRoute({
      tags: ["Authentication"],
      summary: "Complete Slack bot installation",
      description:
        "Consume the single-use OAuth state, recheck the installing admin's access, and exchange the Slack authorization code for bot credentials. Redirect to connector settings after a successful installation.",
      security: [],
      responses: {
        302: {
          description: "Redirect to the installed connector's settings.",
          headers: { Location: { schema: { type: "string", format: "uri" } } },
        },
        400: textResponse("Installation cancelled, expired, incomplete, or missing required permissions."),
        403: textResponse("The installing member no longer has the Manage connections permission."),
        409: textResponse("Slack workspace conflicts with an existing installation."),
      },
    }),
    publicRoute,
    async (c) => {
      const state = c.req.query("state")
      const code = c.req.query("code")
      if (!state || !code || c.req.query("error")) return c.text("Slack installation was not completed.", 400)
      const transaction = await db.transaction(async (tx) => {
        const row = (
          await tx
            .select()
            .from(State)
            .where(and(eq(State.id, scopeKey(state)), gt(State.expiresAt, new Date())))
            .limit(1)
            .for("update")
        )[0]
        if (row) await tx.delete(State).where(eq(State.id, row.id))
        return row
      })
      if (!transaction) return c.text("This installation link expired. Start again in OpenWork.", 400)
      const installation = await getInstallation(transaction.connectionId)
      const member = (await db.select().from(MemberTable).where(eq(MemberTable.id, transaction.memberId)).limit(1))[0]
      if (!installation || !member?.userId || member.removedAt) return c.text("Access denied.", 403)
      const permissions = await resolvePermissionsForMember({ organizationId: installation.organizationId, memberId: member.id })
      if (!permissions.has("connections.manage")) return c.text("Access denied.", 403)
      // Single-use state consumed and the installing admin re-verified: the
      // installation's organization is the tenant (state consumption precedes
      // attribution; nothing else has happened yet).
      const installer = auditSessionUserAttribution(member.userId, member.id)
      if (installer) {
        const audited = await attributeAuditRequest(c, { organizationId: installation.organizationId, ...installer })
        if (!audited.ok) return audited.response
      }
      const connection = await getExternalMcpConnection({
        organizationId: installation.organizationId,
        connectionId: installation.connectionId,
      })
      if (!connection || !isSlackConnection(connection)) return c.text("The connection changed. Start again.", 400)
      const client = await getOrgOAuthClient(installation.organizationId, installation.connectionId)
      if (!client?.clientSecret) return c.text("Slack app setup is incomplete.", 400)
      const response = await fetch("https://slack.com/api/oauth.v2.access", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: client.clientId,
          client_secret: client.clientSecret,
          code,
          redirect_uri: `${publicBase(c.req.raw)}/v1/integrations/slack/oauth/callback`,
        }),
        signal: AbortSignal.timeout(10_000),
        redirect: "error",
      })
      const result = z
        .object({
          ok: z.literal(true),
          app_id: z.string(),
          bot_user_id: z.string(),
          access_token: z.string(),
          team: z.object({ id: z.string() }),
          scope: z.string(),
        })
        .safeParse(await response.json())
      if (!result.success || REQUIRED_BOT_SCOPES.some((scope) => !result.data.scope.split(",").includes(scope)))
        return c.text("Slack did not grant the required bot permissions. Check the app manifest and reinstall.", 400)
      const token = result.data
      if (installation.teamId && installation.teamId !== token.team.id)
        return c.text("This connector is already linked to another Slack workspace.", 409)
      const collision = (
        await db
          .select({ id: Installation.connectionId })
          .from(Installation)
          .where(eq(Installation.teamId, token.team.id))
          .limit(1)
      )[0]
      if (collision && collision.id !== installation.connectionId)
        return c.text("This Slack workspace is already connected to OpenWork.", 409)
      await db
        .update(Installation)
        .set({ teamId: token.team.id, appId: token.app_id, botUserId: token.bot_user_id, botToken: token.access_token })
        .where(eq(Installation.connectionId, installation.connectionId))
      return c.redirect(
        new URL(`/dashboard/mcp-connections/${installation.connectionId}`, env.betterAuthUrl).toString(),
      )
    },
  )

  app.post(
    "/v1/integrations/slack/:connectionId/events",
    describeRoute({
      tags: ["Webhooks"],
      summary: "Receive signed Slack assistant events",
      description:
        "Verify the Slack signature and workspace, answer URL verification challenges, and durably enqueue supported events before acknowledging. Disabled or ineligible invocations are acknowledged without routing to a member runtime.",
      security: [],
      responses: {
        ...webhookResponses,
        200: jsonResponse(
          "Event acknowledged or URL verification challenge.",
          z.union([okSchema, z.object({ challenge: z.string() })]),
        ),
      },
    }),
    signedWebhookRoute,
    paramValidator(connectionParams),
    bodyLimit({ maxSize: 1_000_000 }),
    async (c) => {
      const startedAt = Date.now()
      const connectionId = normalizeDenTypeId("externalMcpConnection", c.req.param("connectionId"))
      const installation = await getInstallation(connectionId)
      if (!installation) return c.json({ ok: false }, 401)
      const raw = await c.req.text()
      if (
        !verifySlackSignature(
          raw,
          c.req.header("x-slack-request-timestamp") ?? "",
          c.req.header("x-slack-signature") ?? "",
          installation.signingSecret,
        )
      )
        return c.json({ ok: false }, 401)
      const auditBlocked = await attributeSlackInstallation(c, installation)
      if (auditBlocked) return auditBlocked
      let json: unknown
      try {
        json = JSON.parse(raw)
      } catch {
        return c.json({ ok: false }, 400)
      }
      const envelope = slackEnvelopeSchema.safeParse(json)
      if (!envelope.success) return c.json({ ok: false }, 400)
      const value = envelope.data
      if (value.type === "url_verification") return c.json({ challenge: value.challenge })
      if (value.team_id !== installation.teamId || value.api_app_id !== installation.appId)
        return c.json({ ok: false }, 403)
      if (!value.event || !value.event_id) return c.json({ ok: true })
      if (
        !installation.enabled &&
        !["app_uninstalled", "tokens_revoked", "agent_session_stopped"].includes(value.event.type)
      )
        return c.json({ ok: true })
      const event = value.event
      if (isInvocation(event) && !(await slackAssistantEnabledForInstallation(installation)))
        return c.json({ ok: true })
      if (event.bot_id || event.app_id || event.user === installation.botUserId) return c.json({ ok: true })
      if (
        isInvocation(event) ||
        [
          "app_uninstalled",
          "tokens_revoked",
          "agent_session_stopped",
          "app_home_opened",
          "app_context_changed",
          "agent_session_title_changed",
        ].includes(event.type)
      ) {
        if (
          isInvocation(event) &&
          installation.channelIds?.length &&
          event.channel_type !== "im" &&
          !installation.channelIds.includes(event.channel ?? "")
        )
          return c.json({ ok: true })
        const id = await enqueueSlackEvent(installation, value.event_id, event)
        appLogger.info("slack_assistant_event_accepted", { event_id: id, ack_ms: Date.now() - startedAt })
      }
      // Acknowledge only after durable insertion. No provider/runtime calls on ingress.
      return c.json({ ok: true })
    },
  )
  for (const action of ["commands", "interactions"]) {
    app.post(
      `/v1/integrations/slack/:connectionId/${action}`,
      describeRoute({
        tags: ["Webhooks"],
        summary: `Receive Slack ${action}`,
        description:
          action === "commands"
            ? "Verify the signed Slack slash command and return an ephemeral link for the member to connect their own account in OpenWork."
            : "Verify the signed Slack interaction and record supported feedback only for the member who owns the referenced assistant event.",
        security: [],
        responses: {
          ...webhookResponses,
          200: jsonResponse(
            action === "commands" ? "Private connection instructions." : "Interaction acknowledged.",
            action === "commands" ? z.object({ response_type: z.literal("ephemeral"), text: z.string() }) : okSchema,
          ),
        },
      }),
      signedWebhookRoute,
      paramValidator(connectionParams),
      bodyLimit({ maxSize: 100_000 }),
      async (c) => {
        const connectionId = normalizeDenTypeId("externalMcpConnection", c.req.param("connectionId"))
        const installation = await getInstallation(connectionId)
        const raw = await c.req.text()
        if (
          !installation ||
          !verifySlackSignature(
            raw,
            c.req.header("x-slack-request-timestamp") ?? "",
            c.req.header("x-slack-signature") ?? "",
            installation.signingSecret,
          )
        )
          return c.json({ ok: false }, 401)
        const auditBlocked = await attributeSlackInstallation(c, installation)
        if (auditBlocked) return auditBlocked
        const form = new URLSearchParams(raw)
        if (
          action === "commands" &&
          (form.get("team_id") !== installation.teamId || form.get("api_app_id") !== installation.appId)
        )
          return c.json({ ok: false }, 403)
        if (action === "interactions") {
          let payload: unknown
          try {
            payload = JSON.parse(form.get("payload") ?? "")
          } catch {
            return c.json({ ok: false }, 400)
          }
          const parsed = z
            .object({
              team: z.object({ id: z.string() }),
              user: z.object({ id: z.string() }),
              api_app_id: z.string(),
              actions: z.array(z.object({ action_id: z.string(), value: z.string().optional() })).optional(),
            })
            .safeParse(payload)
          if (
            !parsed.success ||
            parsed.data.team.id !== installation.teamId ||
            parsed.data.api_app_id !== installation.appId
          )
            return c.json({ ok: false }, 403)
          for (const item of parsed.data.actions ?? [])
            if (
              item.action_id.startsWith("slack_feedback:") &&
              (item.value === "positive" || item.value === "negative")
            ) {
              await recordSlackFeedback(
                installation,
                parsed.data.user.id,
                item.action_id.slice("slack_feedback:".length),
                item.value,
              )
            }
          return c.json({ ok: true })
        }
        return c.json({
          response_type: "ephemeral",
          text: `Connect your own Slack account in OpenWork: <${openworkYourConnectionsUrl(connectionId)}|Connect OpenWork>`,
        })
      },
    )
  }
}
