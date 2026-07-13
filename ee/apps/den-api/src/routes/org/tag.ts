import { createDenTypeId, normalizeDenTypeId } from "@openwork-ee/utils/typeid"
import type { Hono } from "hono"
import { describeRoute } from "hono-openapi"
import { z } from "zod"
import {
  createOAuthStateToken,
  resolvePublicOrigin,
  verifyOAuthStateToken,
} from "../../capability-sources/generic-oauth.js"
import { escapeHtml } from "../../capability-sources/oauth-callback-page.js"
import { ORGANIZATION_AUDIT_ACTIONS, recordOrganizationAuditEvent } from "../../audit-events.js"
import {
  getSlackChannel,
  revokeSlackToken,
  validateSlackBot,
} from "../../capability-sources/tag-slack-api.js"
import {
  buildTagSlackAuthorizeUrl,
  configuredTagSlackOAuth,
  ensureFreshTagConnection,
  exchangeTagSlackOAuthCode,
  missingTagSlackScopes,
  TAG_SLACK_OAUTH_PROVIDER_ID,
  TAG_SLACK_OAUTH_SCOPES,
} from "../../capability-sources/tag-slack-oauth.js"
import {
  consumeTagOAuthState,
  deleteTagConnection,
  getActiveTagOAuthMember,
  getTagConnectionByOrganization,
  isDuplicateDatabaseEntry,
  listTagRuns,
  replaceTagConnection,
  saveTagOAuthState,
  tagConnectionView,
  updateTagConnectionPolicy,
} from "../../capability-sources/tag-store.js"
import { loadWorkerAccess } from "../../capability-sources/worker-session.js"
import { env } from "../../env.js"
import { jsonValidator, orgMemberRoute, publicRoute } from "../../middleware/index.js"
import {
  forbiddenSchema,
  htmlResponse,
  invalidRequestSchema,
  jsonResponse,
  unauthorizedSchema,
} from "../../openapi.js"
import { ensureOrganizationAdmin, orgAccessFailureStatus } from "./shared.js"
import type { OrgRouteVariables } from "./shared.js"

const slackId = z.string().trim().min(2).max(32).regex(/^[A-Z][A-Z0-9]+$/)

const tagPolicySchema = z.object({
  workerId: z.string().trim().min(1).max(64),
  serviceName: z.string().trim().min(1).max(80).default("OpenWork"),
  defaultInstructions: z.string().trim().min(1).max(12_000),
  allowedUserIds: z.array(slackId).max(250).default([]),
  allowGuests: z.boolean().default(false),
  allowSharedChannels: z.boolean().default(false),
  channels: z.array(z.object({
    id: slackId,
    instructions: z.string().trim().max(12_000).nullable().optional(),
  })).min(1).max(100),
})
const saveTagConnectionSchema = tagPolicySchema.extend({
  botToken: z.string().trim().min(1).max(512),
  signingSecret: z.string().trim().min(16).max(512),
})
const pendingTagOAuthSchema = tagPolicySchema.extend({
  returnOrigin: z.string().url().nullable(),
})

const tagConnectionResponseSchema = z.object({ connection: z.unknown().nullable() })
const tagRunsResponseSchema = z.object({ items: z.array(z.unknown()) })
const tagDeleteResponseSchema = z.object({ ok: z.literal(true) })
const tagErrorSchema = z.object({ error: z.string(), message: z.string() })
const tagOAuthConfigSchema = z.object({
  configured: z.boolean(),
  eventsUrl: z.string(),
  redirectUri: z.string(),
  scopes: z.array(z.string()),
})
const tagOAuthStartSchema = z.object({
  authorizeUrl: z.string(),
  callbackOrigin: z.string(),
})

function managementDenied(c: Parameters<typeof ensureOrganizationAdmin>[0]) {
  return ensureOrganizationAdmin(c, "Only workspace owners and admins can manage OpenWork Tag.")
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function eventsUrl(request: Request, connectionId: string): string {
  const origin = resolvePublicOrigin(request, env.apiPublicUrl)
  return `${origin}/v1/webhooks/tag/slack/${encodeURIComponent(connectionId)}`
}

function oauthEventsUrl(request: Request): string {
  return `${resolvePublicOrigin(request, env.apiPublicUrl)}/v1/webhooks/tag/slack/oauth`
}

function oauthRedirectUri(request: Request): string {
  return `${resolvePublicOrigin(request, env.apiPublicUrl)}/v1/tag/slack/oauth/callback`
}

function requestReturnOrigin(request: Request): string | null {
  const candidate = request.headers.get("origin")?.trim()
  if (!candidate) return null
  try {
    const origin = new URL(candidate).origin
    return env.publicUrlTrustedOrigins.includes(origin) ? origin : null
  } catch {
    return null
  }
}

function tagOAuthCallbackPage(input: { ok: boolean; message: string; returnOrigin: string | null }) {
  const title = input.ok ? "Slack connected" : "Slack connection failed"
  const payload = JSON.stringify({ type: "openwork-tag-slack-oauth", ok: input.ok, message: input.message })
    .replace(/</g, "\\u003c")
  const targetOrigin = JSON.stringify(input.returnOrigin ?? "*")
  return `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(title)} — OpenWork</title></head>
  <body style="font-family:system-ui,sans-serif;max-width:520px;margin:64px auto;text-align:center;color:#0f172a">
    <h1 style="font-size:20px">${escapeHtml(title)}</h1><p>${escapeHtml(input.message)}</p>
    <script>if(window.opener){window.opener.postMessage(${payload},${targetOrigin});setTimeout(()=>window.close(),250)}</script>
  </body></html>`
}

async function validateTagWorker(organizationId: Parameters<typeof getTagConnectionByOrganization>[0], workerId: string) {
  let normalized
  try {
    normalized = normalizeDenTypeId("worker", workerId)
  } catch {
    return { error: "Select a valid OpenWork worker." } as const
  }
  const access = await loadWorkerAccess({ organizationId, workerId: normalized })
  return access ? { workerId: normalized } as const : {
    error: "The selected worker must belong to this workspace and have active host and client connections.",
  } as const
}

async function validateTagChannels(input: {
  allowSharedChannels: boolean
  botToken: string
  channels: z.infer<typeof tagPolicySchema>["channels"]
}) {
  const uniqueChannelIds = [...new Set(input.channels.map((channel) => channel.id))]
  return Promise.all(uniqueChannelIds.map(async (channelId) => {
    const configured = input.channels.find((channel) => channel.id === channelId)
    const channel = await getSlackChannel({ botToken: input.botToken, channelId })
    if (channel.isShared && !input.allowSharedChannels) {
      throw new Error(`${channel.name ? `#${channel.name}` : channel.id} is shared outside this Slack workspace. Enable shared channels explicitly to allow it.`)
    }
    return { id: channel.id, name: channel.name, instructions: configured?.instructions ?? null }
  }))
}

async function connectionResponse(
  request: Request,
  organizationId: Parameters<typeof getTagConnectionByOrganization>[0],
) {
  const connection = await getTagConnectionByOrganization(organizationId)
  if (!connection) return { connection: null }
  return {
    connection: {
      ...await tagConnectionView(connection),
      eventsUrl: connection.installSource === "oauth" ? oauthEventsUrl(request) : eventsUrl(request, connection.id),
    },
  }
}

export function registerTagOrgRoutes<T extends { Variables: OrgRouteVariables }>(app: Hono<T>) {
  app.get(
    "/v1/tag/slack/oauth/config",
    describeRoute({
      tags: ["Integrations"],
      summary: "Get OpenWork Tag Slack OAuth availability",
      description: "Admin-only. Returns deployment OAuth readiness, required bot scopes, and the exact Slack redirect URI without exposing client credentials.",
      responses: {
        200: jsonResponse("Slack OAuth configuration.", tagOAuthConfigSchema),
        401: jsonResponse("The caller must be signed in.", unauthorizedSchema),
        403: jsonResponse("Only workspace owners and admins can manage OpenWork Tag.", forbiddenSchema),
      },
    }),
    orgMemberRoute(),
    async (c) => {
      const admin = managementDenied(c)
      if (!admin.ok) return c.json(admin.response, orgAccessFailureStatus(admin.response))
      return c.json({
        configured: Boolean(configuredTagSlackOAuth()),
        eventsUrl: oauthEventsUrl(c.req.raw),
        redirectUri: oauthRedirectUri(c.req.raw),
        scopes: [...TAG_SLACK_OAUTH_SCOPES],
      })
    },
  )

  app.post(
    "/v1/tag/slack/oauth/start",
    describeRoute({
      tags: ["Authentication"],
      summary: "Start OpenWork Tag Slack installation",
      description: "Admin-only. Persists encrypted, single-use setup state and returns Slack's OAuth v2 authorization URL. No policy or secret is embedded in the state parameter.",
      responses: {
        200: jsonResponse("Slack OAuth authorization URL.", tagOAuthStartSchema),
        400: jsonResponse("The setup policy is invalid.", invalidRequestSchema),
        401: jsonResponse("The caller must be signed in.", unauthorizedSchema),
        403: jsonResponse("Only workspace owners and admins can install OpenWork Tag.", forbiddenSchema),
        409: jsonResponse("Slack OAuth or the worker is unavailable.", tagErrorSchema),
      },
    }),
    orgMemberRoute(),
    jsonValidator(tagPolicySchema),
    async (c) => {
      const context = c.get("organizationContext")
      const admin = managementDenied(c)
      if (!admin.ok) return c.json(admin.response, orgAccessFailureStatus(admin.response))
      if (c.get("session")?.id === "mcp_internal") {
        return c.json({ error: "invalid_request", message: "An agent cannot start a Slack installation." }, 400)
      }
      const oauth = configuredTagSlackOAuth()
      if (!env.tagSlackEnabled || !oauth) {
        return c.json({
          error: "slack_oauth_unavailable",
          message: "Slack OAuth is not configured for this Den deployment. Use manual credentials or ask the deployment owner to configure the Slack app.",
        }, 409)
      }
      const body = c.req.valid("json")
      const worker = await validateTagWorker(context.organization.id, body.workerId)
      if ("error" in worker) return c.json({ error: "worker_unavailable", message: worker.error }, 409)
      const state = createOAuthStateToken({
        organizationId: context.organization.id,
        orgMembershipId: context.currentMember.id,
        providerId: TAG_SLACK_OAUTH_PROVIDER_ID,
        secret: env.betterAuthSecret,
      })
      const pending = pendingTagOAuthSchema.parse({
        ...body,
        workerId: worker.workerId,
        returnOrigin: requestReturnOrigin(c.req.raw),
      })
      await saveTagOAuthState({
        organizationId: context.organization.id,
        orgMembershipId: context.currentMember.id,
        payload: JSON.stringify(pending),
        state,
      })
      const redirectUri = oauthRedirectUri(c.req.raw)
      return c.json({
        authorizeUrl: buildTagSlackAuthorizeUrl({
          authorizeUrl: oauth.authorizeUrl,
          clientId: oauth.clientId,
          redirectUri,
          state,
        }),
        callbackOrigin: new URL(redirectUri).origin,
      })
    },
  )

  app.get(
    "/v1/tag/slack/oauth/callback",
    describeRoute({
      tags: ["Authentication"],
      summary: "Complete OpenWork Tag Slack installation",
      description: "Public Slack OAuth callback. Authorization comes only from the signed, single-use state token and the still-active organization membership.",
      responses: {
        200: htmlResponse("Slack installation completed."),
        400: htmlResponse("Slack installation failed."),
      },
    }),
    publicRoute,
    async (c) => {
      const url = new URL(c.req.url)
      const code = url.searchParams.get("code")
      const state = url.searchParams.get("state")
      if (!code || !state) {
        return c.html(tagOAuthCallbackPage({ ok: false, message: "Slack did not return a valid authorization code.", returnOrigin: null }), 400)
      }
      const statePayload = verifyOAuthStateToken({ token: state, secret: env.betterAuthSecret })
      if (!statePayload || statePayload.providerId !== TAG_SLACK_OAUTH_PROVIDER_ID) {
        return c.html(tagOAuthCallbackPage({ ok: false, message: "This Slack installation request is invalid or expired.", returnOrigin: null }), 400)
      }
      const pendingRow = await consumeTagOAuthState({
        organizationId: statePayload.organizationId,
        orgMembershipId: statePayload.orgMembershipId,
        state,
      })
      if (!pendingRow) {
        return c.html(tagOAuthCallbackPage({ ok: false, message: "This Slack installation request has expired or was already used.", returnOrigin: null }), 400)
      }
      let pending: z.infer<typeof pendingTagOAuthSchema>
      try {
        pending = pendingTagOAuthSchema.parse(JSON.parse(pendingRow.payload))
      } catch {
        return c.html(tagOAuthCallbackPage({ ok: false, message: "The stored OpenWork Tag setup is invalid.", returnOrigin: null }), 400)
      }
      const member = await getActiveTagOAuthMember({
        organizationId: statePayload.organizationId,
        orgMembershipId: statePayload.orgMembershipId,
      })
      const oauth = configuredTagSlackOAuth()
      const memberRoles = new Set(member?.role.split(",").map((role) => role.trim()) ?? [])
      if (!member?.userId || (!memberRoles.has("owner") && !memberRoles.has("admin")) || !oauth) {
        return c.html(tagOAuthCallbackPage({
          ok: false,
          message: member?.userId && (memberRoles.has("owner") || memberRoles.has("admin"))
            ? "Slack OAuth is no longer configured for this Den deployment."
            : "You no longer have permission to install OpenWork Tag for this organization.",
          returnOrigin: pending.returnOrigin,
        }), 400)
      }
      let issuedBotToken: string | null = null
      let installationPersisted = false
      try {
        const worker = await validateTagWorker(statePayload.organizationId, pending.workerId)
        if ("error" in worker) throw new Error(worker.error)
        const install = await exchangeTagSlackOAuthCode({
          code,
          config: oauth,
          redirectUri: oauthRedirectUri(c.req.raw),
        })
        issuedBotToken = install.access_token
        const missingScopes = missingTagSlackScopes(install.scope)
        if (missingScopes.length > 0) {
          throw new Error(`Slack did not grant required scopes: ${missingScopes.join(", ")}.`)
        }
        const bot = await validateSlackBot({ botToken: install.access_token })
        if (bot.teamId !== install.team.id || bot.botUserId !== install.bot_user_id) {
          throw new Error("Slack OAuth returned an installation identity that did not match auth.test.")
        }
        const channels = await validateTagChannels({
          allowSharedChannels: pending.allowSharedChannels,
          botToken: install.access_token,
          channels: pending.channels,
        })
        const existing = await getTagConnectionByOrganization(statePayload.organizationId)
        const saved = await replaceTagConnection({
          allowGuests: pending.allowGuests,
          allowSharedChannels: pending.allowSharedChannels,
          allowedUserIds: pending.allowedUserIds,
          bot,
          botToken: install.access_token,
          channels,
          connectionId: existing?.id ?? createDenTypeId("tagConnection"),
          createdByOrgMembershipId: statePayload.orgMembershipId,
          defaultInstructions: pending.defaultInstructions,
          installation: {
            appId: install.app_id ?? null,
            enterpriseId: install.enterprise?.id ?? null,
            isEnterpriseInstall: install.is_enterprise_install ?? false,
            refreshToken: install.refresh_token ?? null,
            scopes: install.scope?.split(/[ ,]+/).filter(Boolean) ?? [],
            source: "oauth",
            tokenExpiresAt: install.expires_in ? new Date(Date.now() + install.expires_in * 1_000) : null,
          },
          organizationId: statePayload.organizationId,
          serviceName: pending.serviceName,
          signingSecret: oauth.signingSecret,
          workerId: worker.workerId,
        })
        installationPersisted = true
        await recordOrganizationAuditEvent({
          organizationId: statePayload.organizationId,
          actorUserId: member.userId,
          action: existing ? ORGANIZATION_AUDIT_ACTIONS.tagSlackUpdated : ORGANIZATION_AUDIT_ACTIONS.tagSlackConnected,
          payload: {
            connectionId: saved.id,
            slackTeamId: saved.slackTeamId,
            channelCount: channels.length,
            workerId: worker.workerId,
            installSource: "oauth",
            enterpriseInstall: install.is_enterprise_install ?? false,
          },
        })
        if (existing?.botToken && existing.botToken !== install.access_token) {
          try {
            await revokeSlackToken({ botToken: existing.botToken })
          } catch {
            // The new installation is authoritative; old-token cleanup is best effort.
          }
        }
        return c.html(tagOAuthCallbackPage({ ok: true, message: `${bot.teamName} is connected to OpenWork Tag.`, returnOrigin: pending.returnOrigin }))
      } catch (error) {
        if (issuedBotToken && !installationPersisted) {
          try {
            await revokeSlackToken({ botToken: issuedBotToken })
          } catch {
            // Callback failure remains visible; no credential is persisted in Den.
          }
        }
        if (isDuplicateDatabaseEntry(error)) {
          return c.html(tagOAuthCallbackPage({ ok: false, message: "This Slack workspace is already connected to another OpenWork workspace.", returnOrigin: pending.returnOrigin }), 400)
        }
        console.error("tag_slack_oauth_callback_failed", {
          requestId: c.get("requestId"),
          organizationId: statePayload.organizationId,
          errorName: error instanceof Error ? error.name : "UnknownError",
        })
        return c.html(tagOAuthCallbackPage({ ok: false, message: errorMessage(error), returnOrigin: pending.returnOrigin }), 400)
      }
    },
  )

  app.get(
    "/v1/tag/slack/connection",
    describeRoute({
      tags: ["Integrations"],
      summary: "Get the OpenWork Tag Slack connection",
      description: "Admin-only. Returns redacted Slack identity, channel policy, worker health, Events API URL, and webhook status.",
      responses: {
        200: jsonResponse("OpenWork Tag connection status.", tagConnectionResponseSchema),
        401: jsonResponse("The caller must be signed in.", unauthorizedSchema),
        403: jsonResponse("Only workspace owners and admins can manage OpenWork Tag.", forbiddenSchema),
      },
    }),
    orgMemberRoute(),
    async (c) => {
      const admin = managementDenied(c)
      if (!admin.ok) return c.json(admin.response, orgAccessFailureStatus(admin.response))
      const organization = c.get("organizationContext").organization
      return c.json(await connectionResponse(c.req.raw, organization.id))
    },
  )

  app.put(
    "/v1/tag/slack/connection",
    describeRoute({
      tags: ["Integrations"],
      summary: "Connect a Slack app to OpenWork Tag",
      description: "Admin-only. Validates a bot token, signing secret configuration, explicit channels, and a healthy Den worker before encrypting credentials at rest.",
      responses: {
        200: jsonResponse("Slack app connected.", tagConnectionResponseSchema),
        400: jsonResponse("The request was invalid.", invalidRequestSchema),
        401: jsonResponse("The caller must be signed in.", unauthorizedSchema),
        403: jsonResponse("Only workspace owners and admins can manage OpenWork Tag.", forbiddenSchema),
        409: jsonResponse("The worker, workspace, or policy is unavailable.", tagErrorSchema),
        502: jsonResponse("Slack rejected the credentials or channel lookup.", tagErrorSchema),
      },
    }),
    orgMemberRoute(),
    jsonValidator(saveTagConnectionSchema),
    async (c) => {
      const context = c.get("organizationContext")
      const admin = managementDenied(c)
      if (!admin.ok) return c.json(admin.response, orgAccessFailureStatus(admin.response))
      if (!env.tagSlackEnabled) {
        return c.json({ error: "tag_disabled", message: "OpenWork Tag is disabled for this Den deployment." }, 409)
      }
      if (c.get("session")?.id === "mcp_internal") {
        return c.json({
          error: "invalid_request",
          message: "Slack credentials cannot be set from an agent. Add them in OpenWork Cloud Connections.",
        }, 400)
      }
      const body = c.req.valid("json")
      const worker = await validateTagWorker(context.organization.id, body.workerId)
      if ("error" in worker) return c.json({ error: "worker_unavailable", message: worker.error }, 409)

      let bot
      let channels
      try {
        bot = await validateSlackBot({ botToken: body.botToken })
        channels = await validateTagChannels({
          allowSharedChannels: body.allowSharedChannels,
          botToken: body.botToken,
          channels: body.channels,
        })
      } catch (error) {
        return c.json({ error: "slack_validation_failed", message: errorMessage(error) }, 502)
      }

      try {
        const existing = await getTagConnectionByOrganization(context.organization.id)
        const saved = await replaceTagConnection({
          allowGuests: body.allowGuests,
          allowSharedChannels: body.allowSharedChannels,
          allowedUserIds: body.allowedUserIds,
          bot,
          botToken: body.botToken,
          channels,
          connectionId: existing?.id ?? createDenTypeId("tagConnection"),
          createdByOrgMembershipId: context.currentMember.id,
          defaultInstructions: body.defaultInstructions,
          installation: { source: "manual" },
          organizationId: context.organization.id,
          serviceName: body.serviceName,
          signingSecret: body.signingSecret,
          workerId: worker.workerId,
        })
        await recordOrganizationAuditEvent({
          organizationId: context.organization.id,
          actorUserId: context.currentMember.userId,
          action: existing
            ? ORGANIZATION_AUDIT_ACTIONS.tagSlackUpdated
            : ORGANIZATION_AUDIT_ACTIONS.tagSlackConnected,
          payload: {
            connectionId: saved.id,
            slackTeamId: saved.slackTeamId,
            channelCount: channels.length,
            workerId: worker.workerId,
            installSource: "manual",
            allowGuests: body.allowGuests,
            allowSharedChannels: body.allowSharedChannels,
          },
        })
        if (existing?.botToken && existing.botToken !== body.botToken) {
          try {
            await revokeSlackToken({ botToken: existing.botToken })
          } catch {
            // The newly validated credential is authoritative; old-token cleanup is best effort.
          }
        }
      } catch (error) {
        if (isDuplicateDatabaseEntry(error)) {
          return c.json({
            error: "slack_workspace_in_use",
            message: "This Slack workspace is already connected to another OpenWork workspace.",
          }, 409)
        }
        throw error
      }
      return c.json(await connectionResponse(c.req.raw, context.organization.id))
    },
  )

  app.patch(
    "/v1/tag/slack/connection",
    describeRoute({
      tags: ["Integrations"],
      summary: "Update OpenWork Tag policy",
      description: "Admin-only. Revalidates the active Slack installation, channels, and healthy worker while preserving encrypted installation credentials.",
      responses: {
        200: jsonResponse("OpenWork Tag policy updated.", tagConnectionResponseSchema),
        400: jsonResponse("The request was invalid.", invalidRequestSchema),
        401: jsonResponse("The caller must be signed in.", unauthorizedSchema),
        403: jsonResponse("Only workspace owners and admins can manage OpenWork Tag.", forbiddenSchema),
        404: jsonResponse("OpenWork Tag is not connected.", tagErrorSchema),
        409: jsonResponse("The worker or Slack installation is unavailable.", tagErrorSchema),
        502: jsonResponse("Slack rejected the channel lookup.", tagErrorSchema),
      },
    }),
    orgMemberRoute(),
    jsonValidator(tagPolicySchema),
    async (c) => {
      const context = c.get("organizationContext")
      const admin = managementDenied(c)
      if (!admin.ok) return c.json(admin.response, orgAccessFailureStatus(admin.response))
      const body = c.req.valid("json")
      const existing = await getTagConnectionByOrganization(context.organization.id)
      if (!existing) return c.json({ error: "tag_not_connected", message: "OpenWork Tag is not connected." }, 404)
      if (existing.status !== "active") {
        return c.json({ error: "slack_reinstall_required", message: "The Slack installation was revoked or expired. Install it again before changing policy." }, 409)
      }
      const worker = await validateTagWorker(context.organization.id, body.workerId)
      if ("error" in worker) return c.json({ error: "worker_unavailable", message: worker.error }, 409)
      let connection
      let channels
      try {
        connection = await ensureFreshTagConnection(existing)
        channels = await validateTagChannels({
          allowSharedChannels: body.allowSharedChannels,
          botToken: connection.botToken,
          channels: body.channels,
        })
      } catch (error) {
        return c.json({ error: "slack_validation_failed", message: errorMessage(error) }, 502)
      }
      const saved = await updateTagConnectionPolicy({
        allowGuests: body.allowGuests,
        allowSharedChannels: body.allowSharedChannels,
        allowedUserIds: body.allowedUserIds,
        channels,
        connectionId: connection.id,
        defaultInstructions: body.defaultInstructions,
        serviceName: body.serviceName,
        workerId: worker.workerId,
      })
      await recordOrganizationAuditEvent({
        organizationId: context.organization.id,
        actorUserId: context.currentMember.userId,
        action: ORGANIZATION_AUDIT_ACTIONS.tagSlackUpdated,
        payload: {
          connectionId: saved.id,
          slackTeamId: saved.slackTeamId,
          channelCount: channels.length,
          workerId: worker.workerId,
          installSource: saved.installSource,
          allowGuests: body.allowGuests,
          allowSharedChannels: body.allowSharedChannels,
        },
      })
      return c.json(await connectionResponse(c.req.raw, context.organization.id))
    },
  )

  app.get(
    "/v1/tag/slack/runs",
    describeRoute({
      tags: ["Integrations"],
      summary: "List recent OpenWork Tag runs",
      description: "Admin-only. Returns the latest durable execution records with Slack thread and OpenCode session correlation.",
      responses: {
        200: jsonResponse("Recent OpenWork Tag runs.", tagRunsResponseSchema),
        401: jsonResponse("The caller must be signed in.", unauthorizedSchema),
        403: jsonResponse("Only workspace owners and admins can manage OpenWork Tag.", forbiddenSchema),
      },
    }),
    orgMemberRoute(),
    async (c) => {
      const admin = managementDenied(c)
      if (!admin.ok) return c.json(admin.response, orgAccessFailureStatus(admin.response))
      const organization = c.get("organizationContext").organization
      const rows = await listTagRuns(organization.id)
      return c.json({ items: rows.map((row) => ({
        ...row,
        createdAt: row.createdAt.toISOString(),
        completedAt: row.completedAt?.toISOString() ?? null,
        prompt: row.prompt.slice(0, 500),
        response: row.response?.slice(0, 1_000) ?? null,
      })) })
    },
  )

  app.delete(
    "/v1/tag/slack/connection",
    describeRoute({
      tags: ["Integrations"],
      summary: "Disconnect OpenWork Tag from Slack",
      description: "Admin-only. Deletes encrypted Slack credentials, channel policy, queued events, thread bindings, and execution records.",
      responses: {
        200: jsonResponse("OpenWork Tag disconnected.", tagDeleteResponseSchema),
        401: jsonResponse("The caller must be signed in.", unauthorizedSchema),
        403: jsonResponse("Only workspace owners and admins can manage OpenWork Tag.", forbiddenSchema),
      },
    }),
    orgMemberRoute(),
    async (c) => {
      const admin = managementDenied(c)
      if (!admin.ok) return c.json(admin.response, orgAccessFailureStatus(admin.response))
      const organization = c.get("organizationContext").organization
      const connection = await getTagConnectionByOrganization(organization.id)
      if (connection) {
        let slackRevocationAcknowledged = false
        if (connection.status === "active" && connection.botToken) {
          try {
            const current = await ensureFreshTagConnection(connection)
            await revokeSlackToken({ botToken: current.botToken })
            slackRevocationAcknowledged = true
          } catch (error) {
            console.warn("tag_slack_disconnect_revoke_failed", {
              requestId: c.get("requestId"),
              connectionId: connection.id,
              errorName: error instanceof Error ? error.name : "UnknownError",
            })
          }
        }
        await deleteTagConnection(connection.id)
        await recordOrganizationAuditEvent({
          organizationId: organization.id,
          actorUserId: c.get("organizationContext").currentMember.userId,
          action: ORGANIZATION_AUDIT_ACTIONS.tagSlackDisconnected,
          payload: {
            connectionId: connection.id,
            slackTeamId: connection.slackTeamId,
            installSource: connection.installSource,
            slackRevocationAcknowledged,
          },
        })
      }
      return c.json({ ok: true as const })
    },
  )
}
