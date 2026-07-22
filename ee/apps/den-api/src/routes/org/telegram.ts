import { createHash, randomBytes } from "node:crypto"
import { createDenTypeId, normalizeDenTypeId } from "@openwork-ee/utils/typeid"
import type { Hono } from "hono"
import { describeRoute } from "hono-openapi"
import { z } from "zod"
import { resolvePublicOrigin } from "../../capability-sources/generic-oauth.js"
import { switchTelegramConnectionSafely } from "../../capability-sources/telegram-connection-switch.js"
import {
  deleteTelegramWebhook,
  registerTelegramWebhook,
  sendTelegramText,
  validateTelegramBot,
} from "../../capability-sources/telegram-api.js"
import {
  createTelegramPairing,
  deleteTelegramConnection,
  getTelegramChatBinding,
  getTelegramConnectionByOrganization,
  isDuplicateDatabaseEntry,
  replaceTelegramConnection,
  telegramConnectionView,
} from "../../capability-sources/telegram-store.js"
import { loadTelegramWorkerAccess } from "../../capability-sources/telegram-worker.js"
import { env } from "../../env.js"
import { jsonValidator, orgMemberRoute } from "../../middleware/index.js"
import {
  forbiddenSchema,
  invalidRequestSchema,
  jsonResponse,
  unauthorizedSchema,
} from "../../openapi.js"
import { CONNECTIONS_READ_SESSION_MAX_AGE_MS, ensureOrganizationAdmin, orgAccessFailureStatus } from "./shared.js"
import type { OrgRouteVariables } from "./shared.js"

const PAIRING_TTL_MS = 10 * 60 * 1_000

const telegramConnectionSchema = z.object({
  id: z.string(),
  status: z.enum(["active", "error"]),
  connected: z.boolean(),
  bot: z.object({
    id: z.string(),
    username: z.string().nullable(),
    displayName: z.string(),
  }),
  worker: z.object({
    id: z.string(),
    name: z.string(),
    status: z.string(),
  }),
  webhook: z.object({
    registered: z.boolean(),
    lastReceivedAt: z.string().datetime().nullable(),
    lastError: z.string().nullable(),
  }),
  pairing: z.object({
    paired: z.boolean(),
    chat: z.object({
      username: z.string().nullable(),
      firstName: z.string(),
      pairedAt: z.string().datetime(),
    }).nullable(),
  }),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
}).meta({ ref: "TelegramConnection" })

const telegramConnectionResponseSchema = z.object({
  connection: telegramConnectionSchema.nullable(),
}).meta({ ref: "TelegramConnectionResponse" })

const telegramCapabilityStatusSchema = z.object({
  connection: z.object({
    id: z.string(),
    status: z.enum(["active", "error"]),
    connected: z.boolean(),
    bot: z.object({ username: z.string().nullable(), displayName: z.string() }),
    worker: z.object({ id: z.string(), name: z.string(), status: z.string() }),
    webhook: z.object({ registered: z.boolean(), lastReceivedAt: z.string().datetime().nullable() }),
    pairing: z.object({ paired: z.boolean() }),
  }).nullable(),
}).meta({ ref: "TelegramCapabilityStatus" })

const saveTelegramConnectionSchema = z.object({
  botToken: z.string().trim().min(1).max(512),
  workerId: z.string().trim().min(1).max(64),
})

const pairingResponseSchema = z.object({
  pairing: z.object({
    url: z.string().url(),
    code: z.string(),
    expiresAt: z.string().datetime(),
  }),
}).meta({ ref: "TelegramPairingResponse" })

const telegramDeleteResponseSchema = z.object({
  ok: z.literal(true),
  webhookDeleted: z.boolean(),
}).meta({ ref: "TelegramDeleteResponse" })

const telegramSendSchema = z.object({
  text: z.string().trim().min(1).max(32_000),
})

const telegramSendResponseSchema = z.object({
  ok: z.literal(true),
  messageIds: z.array(z.number().int()),
}).meta({ ref: "TelegramSendResponse" })

const telegramConnectionErrorSchema = z.object({
  error: z.string(),
  message: z.string(),
}).meta({ ref: "TelegramConnectionError" })

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function pairingHash(code: string): string {
  return createHash("sha256").update(code).digest("hex")
}

function webhookUrl(request: Request, connectionId: string): string {
  const origin = resolvePublicOrigin(request, env.apiPublicUrl)
  return `${origin}/v1/webhooks/telegram/${encodeURIComponent(connectionId)}`
}

async function connectionResponse(organizationId: Parameters<typeof getTelegramConnectionByOrganization>[0]) {
  const connection = await getTelegramConnectionByOrganization(organizationId)
  return { connection: connection ? await telegramConnectionView(connection) : null }
}

async function capabilityStatusResponse(organizationId: Parameters<typeof getTelegramConnectionByOrganization>[0]) {
  const full = await connectionResponse(organizationId)
  if (!full.connection) return { connection: null }
  return {
    connection: {
      id: full.connection.id,
      status: full.connection.status,
      connected: full.connection.connected,
      bot: {
        username: full.connection.bot.username,
        displayName: full.connection.bot.displayName,
      },
      worker: full.connection.worker,
      webhook: {
        registered: full.connection.webhook.registered,
        lastReceivedAt: full.connection.webhook.lastReceivedAt,
      },
      pairing: { paired: full.connection.pairing.paired },
    },
  }
}

async function tryDeleteWebhook(botToken: string): Promise<boolean> {
  try {
    await deleteTelegramWebhook({ botToken })
    return true
  } catch {
    return false
  }
}

function managementDenied(c: Parameters<typeof ensureOrganizationAdmin>[0], maxAgeMs?: number) {
  return ensureOrganizationAdmin(c, "Only workspace owners and admins can manage Telegram.", maxAgeMs)
}

export function registerTelegramOrgRoutes<T extends { Variables: OrgRouteVariables }>(app: Hono<T>) {
  app.get(
    "/v1/telegram/connection",
    describeRoute({
      tags: ["Authentication"],
      summary: "Get the organization Telegram connection",
      description: "Returns redacted bot, worker, webhook, and private-chat pairing status. Bot tokens and webhook secrets are never returned.",
      responses: {
        200: jsonResponse("Telegram connection status.", telegramConnectionResponseSchema),
        401: jsonResponse("The caller must be signed in.", unauthorizedSchema),
      },
    }),
    orgMemberRoute(),
    async (c) => {
      const admin = managementDenied(c, CONNECTIONS_READ_SESSION_MAX_AGE_MS)
      if (!admin.ok) return c.json(admin.response, orgAccessFailureStatus(admin.response))
      const organization = c.get("organizationContext").organization
      return c.json(await connectionResponse(organization.id))
    },
  )

  app.put(
    "/v1/telegram/connection",
    describeRoute({
      tags: ["Authentication"],
      summary: "Connect an organization Telegram bot",
      description: "Admin-only. Validates a BotFather token, binds it to one organization worker, encrypts it at rest, and registers a secret-protected webhook.",
      responses: {
        200: jsonResponse("Telegram bot connected.", telegramConnectionResponseSchema),
        400: jsonResponse("The request was invalid.", invalidRequestSchema),
        401: jsonResponse("The caller must be signed in.", unauthorizedSchema),
        403: jsonResponse("Only workspace owners and admins can manage Telegram.", forbiddenSchema),
        409: jsonResponse("The selected worker is unavailable or bot is already connected elsewhere.", telegramConnectionErrorSchema),
        502: jsonResponse("Telegram rejected the token or webhook.", telegramConnectionErrorSchema),
      },
    }),
    orgMemberRoute(),
    jsonValidator(saveTelegramConnectionSchema),
    async (c) => {
      const payload = c.get("organizationContext")
      const admin = managementDenied(c)
      if (!admin.ok) return c.json(admin.response, orgAccessFailureStatus(admin.response))
      if (c.get("session")?.id === "mcp_internal") {
        return c.json({
          error: "invalid_request",
          message: "Telegram bot tokens cannot be set from an agent. Add the token in OpenWork Cloud Connect.",
        }, 400)
      }

      const body = c.req.valid("json")
      let workerId
      try {
        workerId = normalizeDenTypeId("worker", body.workerId)
      } catch {
        return c.json({ error: "invalid_request", message: "Select a valid OpenWork worker." }, 400)
      }

      const access = await loadTelegramWorkerAccess({
        organizationId: payload.organization.id,
        workerId,
      })
      if (!access) {
        return c.json({
          error: "worker_unavailable",
          message: "The selected worker must belong to this workspace and have active host and client connections.",
        }, 409)
      }

      let bot
      try {
        bot = await validateTelegramBot(body.botToken)
      } catch (error) {
        return c.json({ error: "telegram_validation_failed", message: errorMessage(error) }, 502)
      }

      const previous = await getTelegramConnectionByOrganization(payload.organization.id)
      const webhookSecret = randomBytes(32).toString("hex")
      try {
        const connectionId = previous?.id ?? createDenTypeId("telegramConnection")
        const nextWebhook = {
          botToken: body.botToken,
          secret: webhookSecret,
          url: webhookUrl(c.req.raw, connectionId),
        }
        await switchTelegramConnectionSafely({
          deleteWebhook: async (botToken) => {
            await deleteTelegramWebhook({ botToken })
          },
          next: nextWebhook,
          previous: previous
            ? {
                botToken: previous.botToken,
                secret: previous.webhookSecret,
                url: webhookUrl(c.req.raw, previous.id),
              }
            : null,
          registerWebhook: async (registration) => {
            await registerTelegramWebhook(registration)
          },
          switchConnection: (activateWebhook) => replaceTelegramConnection({
            activateWebhook: async () => activateWebhook(),
            bot,
            botToken: body.botToken,
            connectionId,
            createdByOrgMembershipId: payload.currentMember.id,
            organizationId: payload.organization.id,
            webhookSecret,
            workerId,
          }),
        })
      } catch (error) {
        if (isDuplicateDatabaseEntry(error)) {
          return c.json({
            error: "telegram_bot_in_use",
            message: "This Telegram bot is already connected to another OpenWork workspace.",
          }, 409)
        }
        return c.json({ error: "telegram_webhook_failed", message: errorMessage(error) }, 502)
      }

      return c.json(await connectionResponse(payload.organization.id))
    },
  )

  app.post(
    "/v1/telegram/connection/pairing",
    describeRoute({
      tags: ["Authentication"],
      summary: "Create a one-time Telegram pairing link",
      description: "Admin-only. Rotates any prior private-chat binding and returns a ten-minute one-time Telegram deep link.",
      responses: {
        200: jsonResponse("Pairing link created.", pairingResponseSchema),
        401: jsonResponse("The caller must be signed in.", unauthorizedSchema),
        403: jsonResponse("Only workspace owners and admins can manage Telegram.", forbiddenSchema),
        404: jsonResponse("Telegram is not connected.", telegramConnectionErrorSchema),
      },
    }),
    orgMemberRoute(),
    async (c) => {
      const payload = c.get("organizationContext")
      const admin = managementDenied(c)
      if (!admin.ok) return c.json(admin.response, orgAccessFailureStatus(admin.response))

      const connection = await getTelegramConnectionByOrganization(payload.organization.id)
      if (!connection?.botUsername) {
        return c.json({ error: "telegram_not_connected", message: "Connect Telegram before creating a pairing link." }, 404)
      }

      const code = `ow_${randomBytes(24).toString("base64url")}`
      const expiresAt = new Date(Date.now() + PAIRING_TTL_MS)
      await createTelegramPairing({
        connectionId: connection.id,
        expiresAt,
        tokenHash: pairingHash(code),
      })

      return c.json({
        pairing: {
          url: `https://t.me/${connection.botUsername}?start=${encodeURIComponent(code)}`,
          code,
          expiresAt: expiresAt.toISOString(),
        },
      })
    },
  )

  app.delete(
    "/v1/telegram/connection",
    describeRoute({
      tags: ["Authentication"],
      summary: "Disconnect the organization Telegram bot",
      description: "Admin-only. Removes the Telegram webhook and permanently deletes the encrypted bot token, secret, pairing, and delivery state.",
      responses: {
        200: jsonResponse("Telegram disconnected.", telegramDeleteResponseSchema),
        401: jsonResponse("The caller must be signed in.", unauthorizedSchema),
        403: jsonResponse("Only workspace owners and admins can manage Telegram.", forbiddenSchema),
        404: jsonResponse("Telegram is not connected.", telegramConnectionErrorSchema),
      },
    }),
    orgMemberRoute(),
    async (c) => {
      const payload = c.get("organizationContext")
      const admin = managementDenied(c)
      if (!admin.ok) return c.json(admin.response, orgAccessFailureStatus(admin.response))

      const connection = await getTelegramConnectionByOrganization(payload.organization.id)
      if (!connection) {
        return c.json({ error: "telegram_not_connected", message: "Telegram is not connected." }, 404)
      }

      const webhookDeleted = await tryDeleteWebhook(connection.botToken)
      await deleteTelegramConnection(connection.id)
      return c.json({ ok: true, webhookDeleted })
    },
  )

  app.get(
    "/v1/capabilities/telegram/status",
    describeRoute({
      tags: ["Capability Sources"],
      summary: "Check the organization Telegram connection",
      description: "Returns redacted Telegram connection and pairing status without any credential material.",
      responses: {
        200: jsonResponse("Telegram connection status.", telegramCapabilityStatusSchema),
        401: jsonResponse("The caller must be signed in.", unauthorizedSchema),
      },
    }),
    orgMemberRoute(),
    async (c) => {
      const organization = c.get("organizationContext").organization
      return c.json(await capabilityStatusResponse(organization.id))
    },
  )

  app.post(
    "/v1/capabilities/telegram/send-message",
    describeRoute({
      tags: ["Capability Sources"],
      summary: "Send a message to the paired Telegram chat",
      description: "Sends text only to the organization connection's paired private chat. The caller cannot supply an arbitrary Telegram chat id.",
      responses: {
        200: jsonResponse("Telegram message sent.", telegramSendResponseSchema),
        400: jsonResponse("The message was invalid.", invalidRequestSchema),
        401: jsonResponse("The caller must be signed in.", unauthorizedSchema),
        409: jsonResponse("Telegram is not connected or paired.", telegramConnectionErrorSchema),
        502: jsonResponse("Telegram rejected the message.", telegramConnectionErrorSchema),
      },
    }),
    orgMemberRoute(),
    jsonValidator(telegramSendSchema),
    async (c) => {
      const organization = c.get("organizationContext").organization
      const connection = await getTelegramConnectionByOrganization(organization.id)
      if (!connection?.webhookRegistered || connection.status !== "active") {
        return c.json({ error: "telegram_not_connected", message: "Connect Telegram before sending a message." }, 409)
      }
      const binding = await getTelegramChatBinding(connection.id)
      if (!binding) {
        return c.json({ error: "telegram_not_paired", message: "Pair a private Telegram chat before sending a message." }, 409)
      }

      try {
        const messageIds = await sendTelegramText({
          botToken: connection.botToken,
          chatId: binding.telegramChatId,
          text: c.req.valid("json").text,
        })
        return c.json({ ok: true, messageIds })
      } catch (error) {
        return c.json({ error: "telegram_send_failed", message: errorMessage(error) }, 502)
      }
    },
  )
}
