import { afterEach, describe, expect, test } from "bun:test"
import { GrammyError, HttpError } from "grammy"
import {
  chunkTelegramText,
  deleteTelegramWebhook,
  isRetryableTelegramApiError,
  registerTelegramWebhook,
  sendTelegramText,
  validateTelegramBot,
} from "../src/capability-sources/telegram-api.js"

type BotApiCall = {
  body: unknown
  method: string
}

let stopServer: (() => void) | null = null

afterEach(() => {
  stopServer?.()
  stopServer = null
})

async function requestBody(request: Request): Promise<unknown> {
  const text = await request.text()
  if (!text) return null
  try {
    return JSON.parse(text)
  } catch {
    return Object.fromEntries(new URLSearchParams(text))
  }
}

function fakeBotApi() {
  const calls: BotApiCall[] = []
  let messageId = 100
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const method = new URL(request.url).pathname.split("/").pop() ?? ""
      const body = await requestBody(request)
      calls.push({ body, method })

      if (method === "getMe") {
        return Response.json({
          ok: true,
          result: {
            id: 123456,
            is_bot: true,
            first_name: "OpenWork",
            last_name: "Cloud",
            username: "openwork_test_bot",
          },
        })
      }
      if (method === "sendMessage") {
        messageId += 1
        return Response.json({
          ok: true,
          result: {
            message_id: messageId,
            date: 0,
            chat: { id: 777, type: "private", first_name: "Ada" },
            text: "sent",
          },
        })
      }
      return Response.json({ ok: true, result: true })
    },
  })
  stopServer = () => server.stop(true)
  return { apiRoot: server.url.origin, calls }
}

describe("Telegram Bot API client", () => {
  test("classifies Telegram network, rate-limit, and server errors as retryable", () => {
    const apiError = (status: number) => new GrammyError("send failed", {
      ok: false,
      error_code: status,
      description: "send failed",
    }, "sendMessage", {})

    expect(isRetryableTelegramApiError(new HttpError("network failed", new Error("reset")))).toBe(true)
    expect(isRetryableTelegramApiError(apiError(429))).toBe(true)
    expect(isRetryableTelegramApiError(apiError(503))).toBe(true)
    expect(isRetryableTelegramApiError(apiError(400))).toBe(false)
  })

  test("validates, registers a secret webhook, chunks outbound text, and deletes the webhook", async () => {
    const fake = fakeBotApi()
    const botToken = "123456:test-token"

    await expect(validateTelegramBot(botToken, { apiRoot: fake.apiRoot })).resolves.toEqual({
      id: "123456",
      username: "openwork_test_bot",
      displayName: "OpenWork Cloud",
    })
    await registerTelegramWebhook({
      apiRoot: fake.apiRoot,
      botToken,
      secret: "webhook-secret",
      url: "https://openwork.example/v1/webhooks/telegram/tgc_test",
    })
    await expect(sendTelegramText({
      apiRoot: fake.apiRoot,
      botToken,
      chatId: "777",
      text: "x".repeat(4097),
    })).resolves.toEqual([101, 102])
    await deleteTelegramWebhook({ apiRoot: fake.apiRoot, botToken })

    expect(fake.calls.map((call) => call.method)).toEqual([
      "getMe",
      "setWebhook",
      "sendMessage",
      "sendMessage",
      "deleteWebhook",
    ])
    expect(fake.calls[1]?.body).toMatchObject({
      allowed_updates: ["message"],
      secret_token: "webhook-secret",
      url: "https://openwork.example/v1/webhooks/telegram/tgc_test",
    })
    expect(fake.calls[4]?.body).toMatchObject({ drop_pending_updates: true })
  })

  test("keeps every Telegram text chunk within the Bot API limit", () => {
    const chunks = chunkTelegramText(`${"a".repeat(5000)}\nshort`)
    expect(chunks.length).toBe(3)
    expect(chunks.every((chunk) => chunk.length <= 4096)).toBe(true)
    expect(chunks.join("")).toBe(`${"a".repeat(5000)}short`)
  })

  test("bounds long replies and marks the final Telegram message as truncated", async () => {
    const fake = fakeBotApi()

    await expect(sendTelegramText({
      apiRoot: fake.apiRoot,
      botToken: "123456:test-token",
      chatId: "777",
      text: "x".repeat(4096 * 9),
    })).resolves.toHaveLength(8)

    expect(fake.calls.filter((call) => call.method === "sendMessage")).toHaveLength(8)
    expect(fake.calls.at(-1)?.body).toMatchObject({
      text: expect.stringContaining("[Response truncated in Telegram."),
    })
  })
})
