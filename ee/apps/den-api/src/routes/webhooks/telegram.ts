import type { Env, Hono } from "hono"
import { describeRoute } from "hono-openapi"
import { z } from "zod"
import { normalizeDenTypeId } from "@openwork-ee/utils/typeid"
import {
  isRetryableTelegramApiError,
  sendTelegramText,
} from "../../capability-sources/telegram-api.js"
import {
  RetryableTelegramUpdateError,
  setTelegramUpdateProcessor,
  triggerTelegramUpdateDispatcher,
} from "../../capability-sources/telegram-dispatcher.js"
import {
  claimTelegramUpdate,
  consumeTelegramPairing,
  getTelegramChatBinding,
  getTelegramConnectionById,
  noteTelegramWebhookReceived,
  saveTelegramWorkerSession,
  setTelegramUpdateStatus,
  telegramUpdateIntakeAllowed,
  type TelegramConnectionRow,
  type TelegramUpdateRow,
} from "../../capability-sources/telegram-store.js"
import {
  claimAndQueueTelegramUpdate,
  consumeAndConfirmTelegramPairing,
  hashTelegramPairingCode,
  isTelegramConnectionGenerationCurrent,
  telegramWebhookBodyLimit,
  telegramPairingCode,
  telegramPromptMessageId,
  verifyTelegramWebhookSecret,
} from "../../capability-sources/telegram-webhook.js"
import {
  isRetryableTelegramWorkerError,
  loadTelegramWorkerAccess,
  runTelegramWorkerPrompt,
  TelegramWorkerTimeoutError,
} from "../../capability-sources/telegram-worker.js"
import { paramValidator, signedWebhookRoute } from "../../middleware/index.js"
import { invalidRequestSchema, jsonResponse } from "../../openapi.js"

const telegramWebhookParamsSchema = z.object({
  connectionId: z.string().trim().min(1).max(64),
})

const telegramSenderSchema = z.object({
  id: z.number().int(),
  is_bot: z.boolean().optional().default(false),
  first_name: z.string().min(1).max(255),
  username: z.string().max(64).optional(),
})

const telegramMessageSchema = z.object({
  message_id: z.number().int(),
  chat: z.object({
    id: z.number().int(),
    type: z.string(),
  }),
  from: telegramSenderSchema.optional(),
  text: z.string().optional(),
})

export const telegramUpdateSchema = z.object({
  update_id: z.number().int().nonnegative(),
  message: telegramMessageSchema.optional(),
})

const queuedTelegramUpdateSchema = z.object({
  generation: z.string().min(1),
  update: telegramUpdateSchema,
})

type TelegramUpdate = z.infer<typeof telegramUpdateSchema>

const webhookResponseSchema = z.object({
  ok: z.literal(true),
  accepted: z.boolean(),
  reason: z.string().optional(),
}).meta({ ref: "TelegramWebhookResponse" })

const webhookUnauthorizedSchema = z.object({
  ok: z.literal(false),
  error: z.literal("invalid secret"),
}).meta({ ref: "TelegramWebhookUnauthorized" })

const webhookPayloadTooLargeSchema = z.object({
  error: z.literal("payload_too_large"),
}).meta({ ref: "TelegramWebhookPayloadTooLarge" })

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

class TelegramConnectionGenerationChanged extends Error {
  constructor() {
    super("Telegram connection was disconnected or replaced.")
    this.name = "TelegramConnectionGenerationChanged"
  }
}

async function currentTelegramConnection(input: {
  connectionId: TelegramConnectionRow["id"]
  dispatchToken: string
  generation: string
}): Promise<TelegramConnectionRow | null> {
  const current = await getTelegramConnectionById(input.connectionId)
  if (
    !isTelegramConnectionGenerationCurrent(current, input.generation)
    || current?.dispatchToken !== input.dispatchToken
  ) {
    return null
  }
  return current
}

async function sendForCurrentConnection(input: {
  chatId: string
  connectionId: TelegramConnectionRow["id"]
  dispatchToken: string
  generation: string
  text: string
}) {
  const connection = await currentTelegramConnection(input)
  if (!connection) throw new TelegramConnectionGenerationChanged()
  try {
    return await sendTelegramText({
      botToken: connection.botToken,
      chatId: input.chatId,
      text: input.text,
    })
  } catch (error) {
    if (isRetryableTelegramApiError(error)) throw new RetryableTelegramUpdateError(error)
    throw error
  }
}

async function sendPairingResult(input: {
  chatId: string
  code: string
  connection: TelegramConnectionRow
  dispatchToken: string
  generation: string
  sender: z.infer<typeof telegramSenderSchema>
}) {
  await consumeAndConfirmTelegramPairing({
    consume: () => consumeTelegramPairing({
      chatId: input.chatId,
      connectionId: input.connection.id,
      dispatchToken: input.dispatchToken,
      firstName: input.sender.first_name,
      tokenHash: hashTelegramPairingCode(input.code),
      userId: String(input.sender.id),
      username: input.sender.username ?? null,
    }),
    confirm: async (pairing) => {
      await sendForCurrentConnection({
        chatId: input.chatId,
        connectionId: input.connection.id,
        dispatchToken: input.dispatchToken,
        generation: input.generation,
        text: pairing.paired
          ? "Connected. Messages in this private chat will now go to your selected OpenWork worker."
          : "This pairing link is invalid, expired, or already used. Create a new link in OpenWork Connect.",
      })
    },
  })
}

async function processTelegramUpdate(input: {
  connection: TelegramConnectionRow
  dispatchToken: string
  generation: string
  update: TelegramUpdate
  updateRowId: Parameters<typeof setTelegramUpdateStatus>[0]["id"]
}) {
  const updateStatus = (status: Parameters<typeof setTelegramUpdateStatus>[0]["status"], error: string | null = null) =>
    setTelegramUpdateStatus({
      connectionId: input.connection.id,
      error,
      id: input.updateRowId,
      processingToken: input.dispatchToken,
      status,
    })
  const currentAtStart = await currentTelegramConnection({
    connectionId: input.connection.id,
    dispatchToken: input.dispatchToken,
    generation: input.generation,
  })
  if (!currentAtStart) {
    await updateStatus("ignored")
    return
  }
  input.connection = currentAtStart
  const message = input.update.message
  const sender = message?.from
  if (!message || message.chat.type !== "private" || !sender || sender.is_bot || !message.text?.trim()) {
    await updateStatus("ignored")
    return
  }

  const chatId = String(message.chat.id)
  const text = message.text.trim()
  const pairingCode = telegramPairingCode(text)
  if (pairingCode) {
    await sendPairingResult({
      chatId,
      code: pairingCode,
      connection: input.connection,
      dispatchToken: input.dispatchToken,
      generation: input.generation,
      sender,
    })
    await updateStatus("completed")
    return
  }

  if (/^\/start(?:@[A-Za-z0-9_]+)?$/.test(text)) {
    await sendForCurrentConnection({
      chatId,
      connectionId: input.connection.id,
      dispatchToken: input.dispatchToken,
      generation: input.generation,
      text: "Open OpenWork Connect and create a pairing link for this bot, then use that link here.",
    })
    await updateStatus("completed")
    return
  }

  const binding = await getTelegramChatBinding(input.connection.id)
  if (!binding || binding.telegramChatId !== chatId || binding.telegramUserId !== String(sender.id)) {
    await sendForCurrentConnection({
      chatId,
      connectionId: input.connection.id,
      dispatchToken: input.dispatchToken,
      generation: input.generation,
      text: "This private chat is not paired with OpenWork. Create a new pairing link in OpenWork Connect.",
    })
    await updateStatus("ignored")
    return
  }

  if (text.length > 12_000) {
    await sendForCurrentConnection({
      chatId,
      connectionId: input.connection.id,
      dispatchToken: input.dispatchToken,
      generation: input.generation,
      text: "That message is too long. Please keep Telegram requests under 12,000 characters.",
    })
    await updateStatus("ignored")
    return
  }

  try {
    const currentBeforePrompt = await currentTelegramConnection({
      connectionId: input.connection.id,
      dispatchToken: input.dispatchToken,
      generation: input.generation,
    })
    if (!currentBeforePrompt) throw new TelegramConnectionGenerationChanged()
    const access = await loadTelegramWorkerAccess({
      organizationId: currentBeforePrompt.organizationId,
      workerId: currentBeforePrompt.workerId,
    })
    if (!access) throw new Error("The selected worker does not have active host and client connections.")

    const result = await runTelegramWorkerPrompt({
      access,
      messageId: telegramPromptMessageId(input.updateRowId),
      onSessionReady: async (session) => {
        const saved = await saveTelegramWorkerSession({
          bindingId: binding.id,
          connectionId: input.connection.id,
          dispatchToken: input.dispatchToken,
          generation: input.generation,
          sessionId: session.sessionId,
          workspaceId: session.workspaceId,
        })
        if (!saved) throw new TelegramConnectionGenerationChanged()
      },
      preferredWorkspaceId: binding.workerWorkspaceId ?? undefined,
      sessionId: binding.workerSessionId ?? undefined,
      text,
    })
    await sendForCurrentConnection({
      chatId,
      connectionId: input.connection.id,
      dispatchToken: input.dispatchToken,
      generation: input.generation,
      text: result.text,
    })
    await updateStatus("completed")
  } catch (error) {
    if (error instanceof TelegramConnectionGenerationChanged) {
      await updateStatus("ignored")
      return
    }
    if (error instanceof RetryableTelegramUpdateError) throw error
    if (isRetryableTelegramWorkerError(error)) throw new RetryableTelegramUpdateError(error)
    const notice = error instanceof TelegramWorkerTimeoutError
      ? "The worker is still waiting. Check OpenWork for a permission or question, then try again."
      : "I couldn't reach the selected OpenWork worker. Check its status in OpenWork and try again."
    try {
      await sendForCurrentConnection({
        chatId,
        connectionId: input.connection.id,
        dispatchToken: input.dispatchToken,
        generation: input.generation,
        text: notice,
      })
    } catch (noticeError) {
      if (noticeError instanceof RetryableTelegramUpdateError) throw noticeError
      // The durable update row still records the original worker failure.
    }
    await updateStatus("failed", errorMessage(error))
  }
}

async function processQueuedTelegramUpdate(row: TelegramUpdateRow) {
  const processingToken = row.processingToken
  if (!processingToken) return
  const updateStatus = (status: Parameters<typeof setTelegramUpdateStatus>[0]["status"], error: string | null = null) =>
    setTelegramUpdateStatus({
      connectionId: row.connectionId,
      error,
      id: row.id,
      processingToken,
      status,
    })
  let raw: unknown
  try {
    raw = JSON.parse(row.payload)
  } catch {
    await updateStatus("failed", "Stored Telegram update payload is invalid JSON.")
    return
  }
  const parsed = queuedTelegramUpdateSchema.safeParse(raw)
  if (!parsed.success) {
    await updateStatus("failed", "Stored Telegram update payload is invalid.")
    return
  }
  const connection = await currentTelegramConnection({
    connectionId: row.connectionId,
    dispatchToken: processingToken,
    generation: parsed.data.generation,
  })
  if (!connection) {
    await updateStatus("ignored")
    return
  }
  try {
    await processTelegramUpdate({
      connection,
      dispatchToken: processingToken,
      generation: parsed.data.generation,
      update: parsed.data.update,
      updateRowId: row.id,
    })
  } catch (error) {
    if (error instanceof TelegramConnectionGenerationChanged) {
      await updateStatus("ignored")
      return
    }
    throw error
  }
}

setTelegramUpdateProcessor(processQueuedTelegramUpdate)

export function registerTelegramWebhookRoutes<T extends Env>(app: Hono<T>) {
  app.post(
    "/v1/webhooks/telegram/:connectionId",
    describeRoute({
      tags: ["Webhooks"],
      summary: "Telegram bot webhook ingress",
      description: "Verifies Telegram's per-connection secret header, durably claims update_id, and acknowledges before queued worker processing begins.",
      responses: {
        200: jsonResponse("Telegram update accepted or already processed.", webhookResponseSchema),
        400: jsonResponse("Invalid Telegram update or connection id.", invalidRequestSchema),
        401: jsonResponse("Invalid Telegram webhook secret.", webhookUnauthorizedSchema),
        413: jsonResponse("Telegram update body exceeds 256 KiB.", webhookPayloadTooLargeSchema),
        404: jsonResponse("Telegram connection not found.", webhookResponseSchema),
      },
    }),
    telegramWebhookBodyLimit,
    signedWebhookRoute,
    paramValidator(telegramWebhookParamsSchema),
    async (c) => {
      const connectionIdInput = c.req.valid("param").connectionId
      let connectionId
      try {
        connectionId = normalizeDenTypeId("telegramConnection", connectionIdInput)
      } catch {
        return c.json({ ok: true, accepted: false, reason: "connection not found" }, 404)
      }

      const connection = await getTelegramConnectionById(connectionId)
      if (!connection) {
        return c.json({ ok: true, accepted: false, reason: "connection not found" }, 404)
      }

      const receivedSecret = c.req.header("x-telegram-bot-api-secret-token")?.trim() ?? ""
      if (!receivedSecret || !verifyTelegramWebhookSecret(receivedSecret, connection.webhookSecret)) {
        return c.json({ ok: false, error: "invalid secret" }, 401)
      }

      if (connection.status !== "active" || !connection.webhookRegistered) {
        return c.json({ ok: true, accepted: false, reason: "connection inactive" })
      }

      let body: unknown = null
      try {
        body = await c.req.json()
      } catch (error) {
        if (error instanceof Error && error.name === "BodyLimitError") throw error
      }
      const parsed = telegramUpdateSchema.safeParse(body)
      if (!parsed.success) {
        return c.json({ error: "invalid_request", details: parsed.error }, 400)
      }

      if (!await telegramUpdateIntakeAllowed(connection.id)) {
        return c.json({ ok: true, accepted: false, reason: "rate limit or backlog reached" })
      }

      const response = await claimAndQueueTelegramUpdate({
        claim: async () => {
          const update = await claimTelegramUpdate({
            connectionId: connection.id,
            payload: JSON.stringify({
              generation: connection.webhookSecret,
              update: parsed.data,
            }),
            updateId: String(parsed.data.update_id),
          })
          return { claimed: update.claimed, value: update.id }
        },
        queue: () => {
          triggerTelegramUpdateDispatcher()
        },
      })
      if (response.accepted) await noteTelegramWebhookReceived(connection.id)
      return c.json(response)
    },
  )
}
