import { Api, GrammyError, HttpError } from "grammy"

export const TELEGRAM_MESSAGE_LIMIT = 4096
export const TELEGRAM_MAX_TEXT_CHUNKS = 8

export function isRetryableTelegramApiError(error: unknown): boolean {
  return error instanceof HttpError
    || (error instanceof GrammyError && (error.error_code === 408 || error.error_code === 429 || error.error_code >= 500))
}

/** Kept from the former MIT-licensed local adapter, now used only by the cloud connector. */
export function chunkTelegramText(input: string, limit = TELEGRAM_MESSAGE_LIMIT): string[] {
  if (input.length <= limit) return [input]

  const chunks: string[] = []
  let current = ""

  for (const line of input.split(/\n/)) {
    if ((current + line).length + 1 > limit) {
      if (current) chunks.push(current.trimEnd())
      current = ""
    }

    if (line.length > limit) {
      for (let index = 0; index < line.length; index += limit) {
        const slice = line.slice(index, index + limit)
        if (slice) chunks.push(slice)
      }
      continue
    }

    current += current ? `\n${line}` : line
  }

  if (current.trim()) chunks.push(current.trimEnd())
  return chunks.length > 0 ? chunks : [input]
}

function configuredApiRoot(explicit?: string) {
  const value = explicit?.trim() || process.env.DEN_TELEGRAM_API_ROOT?.trim()
  return value || undefined
}

export function createTelegramApi(botToken: string, options: { apiRoot?: string } = {}) {
  return new Api(botToken, {
    apiRoot: configuredApiRoot(options.apiRoot),
    timeoutSeconds: 15,
  })
}

export async function validateTelegramBot(botToken: string, options: { apiRoot?: string } = {}) {
  const bot = await createTelegramApi(botToken, options).getMe()
  if (!bot.is_bot || !bot.username?.trim()) {
    throw new Error("Telegram token did not resolve to a bot with a username.")
  }
  return {
    id: String(bot.id),
    username: bot.username,
    displayName: [bot.first_name, bot.last_name].filter(Boolean).join(" "),
  }
}

export async function registerTelegramWebhook(input: {
  apiRoot?: string
  botToken: string
  secret: string
  url: string
}) {
  await createTelegramApi(input.botToken, { apiRoot: input.apiRoot }).setWebhook(input.url, {
    allowed_updates: ["message"],
    secret_token: input.secret,
  })
}

export async function deleteTelegramWebhook(input: {
  apiRoot?: string
  botToken: string
}) {
  await createTelegramApi(input.botToken, { apiRoot: input.apiRoot }).deleteWebhook({
    drop_pending_updates: true,
  })
}

export async function sendTelegramText(input: {
  apiRoot?: string
  botToken: string
  chatId: string
  maxChunks?: number
  text: string
}) {
  const api = createTelegramApi(input.botToken, { apiRoot: input.apiRoot })
  const messageIds: number[] = []
  const allChunks = chunkTelegramText(input.text)
  const maxChunks = Math.max(1, Math.min(input.maxChunks ?? TELEGRAM_MAX_TEXT_CHUNKS, TELEGRAM_MAX_TEXT_CHUNKS))
  const chunks = allChunks.slice(0, maxChunks)
  if (allChunks.length > maxChunks) {
    const lastIndex = chunks.length - 1
    const suffix = "\n\n[Response truncated in Telegram. Open the worker session in OpenWork for the full answer.]"
    const last = chunks[lastIndex] ?? ""
    chunks[lastIndex] = `${last.slice(0, TELEGRAM_MESSAGE_LIMIT - suffix.length)}${suffix}`
  }
  for (const chunk of chunks) {
    const message = await api.sendMessage(input.chatId, chunk)
    messageIds.push(message.message_id)
  }
  return messageIds
}
