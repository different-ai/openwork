/**
 * [INPUT]: 依赖 Telegram webhook header/body、共享 secret、队列 claim 与配对操作
 * [OUTPUT]: 对外提供请求限流、常量时间校验、update 去重入队与配对消费助手
 * [POS]: capability-sources 的 Telegram HTTP 信任边界，在确认请求前完成认证和持久去重
 * [PROTOCOL]: 变更时更新此头部，然后检查 AGENTS.md
 */
import { createHash, timingSafeEqual } from "node:crypto"
import { bodyLimit } from "hono/body-limit"

export const TELEGRAM_WEBHOOK_MAX_BODY_BYTES = 256 * 1024

export const telegramWebhookBodyLimit = bodyLimit({
  maxSize: TELEGRAM_WEBHOOK_MAX_BODY_BYTES,
  onError: (c) => c.json({ error: "payload_too_large" }, 413),
})

export function verifyTelegramWebhookSecret(received: string, expected: string): boolean {
  const encoder = new TextEncoder()
  const receivedBytes = encoder.encode(received)
  const expectedBytes = encoder.encode(expected)
  if (receivedBytes.length !== expectedBytes.length) return false
  return timingSafeEqual(receivedBytes, expectedBytes)
}

export function hashTelegramPairingCode(code: string): string {
  return createHash("sha256").update(code).digest("hex")
}

export function telegramPromptMessageId(updateRowId: string): string {
  return `msg_${createHash("sha256").update(updateRowId).digest("hex").slice(0, 32)}`
}

export function isTelegramConnectionGenerationCurrent(
  connection: { status: string; webhookRegistered: boolean; webhookSecret: string } | null,
  expectedGeneration: string,
): boolean {
  return Boolean(
    connection
    && connection.status === "active"
    && connection.webhookRegistered
    && connection.webhookSecret === expectedGeneration,
  )
}

export function telegramPairingCode(text: string): string | null {
  const match = text.trim().match(/^\/start(?:@[A-Za-z0-9_]+)?(?:\s+([^\s]+))?$/)
  return match?.[1] ?? null
}

/**
 * Dedupe must finish before acknowledging Telegram, while queued work must not
 * be awaited. Keeping that boundary in one helper makes the webhook contract
 * straightforward to test without a real database or worker.
 */
export async function claimAndQueueTelegramUpdate<T>(input: {
  claim: () => Promise<{ claimed: boolean; value: T }>
  queue: (value: T) => void
}): Promise<
  | { ok: true; accepted: true }
  | { ok: true; accepted: false; reason: "duplicate update" }
> {
  const result = await input.claim()
  if (!result.claimed) {
    return { ok: true, accepted: false, reason: "duplicate update" }
  }
  input.queue(result.value)
  return { ok: true, accepted: true }
}

/** A successful pairing is durable even when the confirmation send fails. */
export async function consumeAndConfirmTelegramPairing<T>(input: {
  confirm: (pairing: T) => Promise<void>
  consume: () => Promise<T>
}): Promise<T> {
  const pairing = await input.consume()
  await input.confirm(pairing)
  return pairing
}
