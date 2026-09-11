import { readModelsAnalyticsSettings, appendModelsAnalyticsEvents, type ModelsAnalyticsEvent } from "@openwork-ee/telemetry"
import type { findActiveInferenceKey } from "./keys.js"

type Key = NonNullable<Awaited<ReturnType<typeof findActiveInferenceKey>>>
export type AnalyticsObserver = {
  chunk: (bytes: Uint8Array) => void
  finish: (status: "completed" | "failed" | "cancelled") => void
}

function object(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? Object.fromEntries(Object.entries(value)) : {}
}
function number(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined
}
function identifier(value: string | null, fallback: string) {
  return value && /^[a-zA-Z0-9_.:-]{1,128}$/.test(value) ? value : fallback
}

// Bounded, incremental inspection. Bytes are forwarded unchanged; text, tool
// arguments and content are never retained in the analytics record.
export function observeModelResponse(input: {
  id: string; sessionId: string; taskId: string; startedAt: number; model: string | null; streaming: boolean
}, save: (event: ModelsAnalyticsEvent) => Promise<void>): AnalyticsObserver {
  const decoder = new TextDecoder()
  let pending = ""
  let overflow = false
  let finished = false
  let failed = false
  let event: ModelsAnalyticsEvent = {
    id: input.id, callId: input.id, type: "model.call", timestamp: new Date(input.startedAt).toISOString(),
    sessionId: input.sessionId, taskId: input.taskId, ...(input.model ? { model: input.model } : {}), usageComplete: false,
  }
  function accept(text: string) {
    if (text === "[DONE]") return
    try {
      const payload = object(JSON.parse(text))
      if (payload.error) failed = true
      if (typeof payload.model === "string") event.model = payload.model.slice(0, 255)
      if (typeof payload.provider === "string") event.provider = payload.provider.slice(0, 255)
      const usage = object(payload.usage)
      if (!Object.keys(usage).length) return
      const cache = object(usage.prompt_tokens_details)
      event = { ...event,
        inputTokens: number(usage.prompt_tokens), outputTokens: number(usage.completion_tokens),
        cacheReadTokens: number(cache.cached_tokens), cacheWriteTokens: number(cache.cache_write_tokens), costUsd: number(usage.cost),
        usageComplete: number(usage.prompt_tokens) !== undefined && number(usage.completion_tokens) !== undefined && number(usage.cost) !== undefined,
      }
    } catch { /* A malformed accounting frame never changes the response. */ }
  }
  return {
    chunk(bytes) {
      if (finished || overflow) return
      pending += decoder.decode(bytes, { stream: true })
      if (input.streaming) {
        let end: number
        while ((end = pending.indexOf("\n")) >= 0) {
          const line = pending.slice(0, end).trimEnd()
          pending = pending.slice(end + 1)
          if (line.startsWith("data:")) accept(line.slice(5).trimStart())
        }
      }
      if (pending.length > 1_048_576) { pending = ""; overflow = true }
    },
    finish(status) {
      if (finished) return
      finished = true
      pending += decoder.decode()
      if (!overflow && pending) accept(input.streaming ? pending.replace(/^data:\s*/, "").trim() : pending)
      pending = ""
      event.status = failed ? "failed" : status
      event.durationMs = Math.max(0, Date.now() - input.startedAt)
      if (overflow || event.status !== "completed") event.usageComplete = false
      void save(event).catch(() => {})
    },
  }
}

export async function beginModelAnalytics(input: { key: Key; request: Request; requestId: string; model: string | null; startedAt: number }) {
  const { db } = await import("./db.js")
  const settings = await readModelsAnalyticsSettings(db, input.key.organization_id)
  if (!settings.enabled) return null
  return (streaming: boolean) => observeModelResponse({
    id: input.requestId,
    sessionId: identifier(input.request.headers.get("x-openwork-session-id"), input.requestId),
    taskId: identifier(input.request.headers.get("x-openwork-task-id"), input.requestId),
    startedAt: input.startedAt, model: input.model, streaming,
  }, (event) => appendModelsAnalyticsEvents(db, {
    orgId: input.key.organization_id, memberId: input.key.org_membership_id, source: "inference", events: [event],
  }))
}
