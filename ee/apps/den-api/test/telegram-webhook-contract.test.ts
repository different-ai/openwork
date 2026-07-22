import { describe, expect, test } from "bun:test"
import { Hono } from "hono"
import {
  claimAndQueueTelegramUpdate,
  consumeAndConfirmTelegramPairing,
  isTelegramConnectionGenerationCurrent,
  TELEGRAM_WEBHOOK_MAX_BODY_BYTES,
  telegramWebhookBodyLimit,
  telegramPairingCode,
  telegramPromptMessageId,
  verifyTelegramWebhookSecret,
} from "../src/capability-sources/telegram-webhook.js"

describe("Telegram webhook contract", () => {
  test("rejects webhook bodies over 256 KiB before JSON parsing", async () => {
    const app = new Hono()
    app.post("/", telegramWebhookBodyLimit, async (c) => {
      await c.req.json()
      return c.json({ ok: true })
    })

    const response = await app.request("/", {
      body: JSON.stringify({ value: "x".repeat(TELEGRAM_WEBHOOK_MAX_BODY_BYTES) }),
      headers: { "content-type": "application/json" },
      method: "POST",
    })

    expect(response.status).toBe(413)
    await expect(response.json()).resolves.toEqual({ error: "payload_too_large" })
  })

  test("checks secrets without accepting length or content mismatches", () => {
    expect(verifyTelegramWebhookSecret("secret-1", "secret-1")).toBe(true)
    expect(verifyTelegramWebhookSecret("secret-2", "secret-1")).toBe(false)
    expect(verifyTelegramWebhookSecret("short", "a-much-longer-secret")).toBe(false)
  })

  test("extracts only one-time /start pairing payloads", () => {
    expect(telegramPairingCode("/start ow_token")).toBe("ow_token")
    expect(telegramPairingCode("/start@openwork_bot ow_token")).toBe("ow_token")
    expect(telegramPairingCode("/start")).toBeNull()
    expect(telegramPairingCode("hello ow_token")).toBeNull()
  })

  test("rejects queued work from an old connection generation", () => {
    const current = { status: "active", webhookRegistered: true, webhookSecret: "new-secret" }
    expect(isTelegramConnectionGenerationCurrent(current, "new-secret")).toBe(true)
    expect(isTelegramConnectionGenerationCurrent(current, "old-secret")).toBe(false)
    expect(isTelegramConnectionGenerationCurrent(null, "new-secret")).toBe(false)
  })

  test("derives a stable OpenCode message id from the durable update row", () => {
    expect(telegramPromptMessageId("tgu_1")).toBe(telegramPromptMessageId("tgu_1"))
    expect(telegramPromptMessageId("tgu_1")).not.toBe(telegramPromptMessageId("tgu_2"))
    expect(telegramPromptMessageId("tgu_1")).toMatch(/^msg_[a-f0-9]{32}$/)
  })

  test("acknowledges after a durable claim without awaiting queued work", async () => {
    let queued = false
    const neverFinishes = new Promise<void>(() => undefined)
    const response = await claimAndQueueTelegramUpdate({
      claim: async () => ({ claimed: true, value: "tgu_1" }),
      queue: () => {
        queued = true
        void neverFinishes
      },
    })
    expect(response).toEqual({ ok: true, accepted: true })
    expect(queued).toBe(true)
  })

  test("treats an already-claimed update as a duplicate and never queues it", async () => {
    let queued = false
    const response = await claimAndQueueTelegramUpdate({
      claim: async () => ({ claimed: false, value: "tgu_existing" }),
      queue: () => {
        queued = true
      },
    })
    expect(response).toEqual({ ok: true, accepted: false, reason: "duplicate update" })
    expect(queued).toBe(false)
  })

  test("keeps a consumed pairing durable when confirmation delivery fails", async () => {
    let bindingExists = false
    await expect(consumeAndConfirmTelegramPairing({
      consume: async () => {
        bindingExists = true
        return { paired: true }
      },
      confirm: async () => {
        throw new Error("Telegram unavailable")
      },
    })).rejects.toThrow("Telegram unavailable")
    expect(bindingExists).toBe(true)
  })
})
