import type { DynamicToolUIPart, ToolUIPart } from "ai"

import { isToolPartInFlight } from "./tool-activity"

type AnyToolPart = ToolUIPart | DynamicToolUIPart

const startedAtByCallId = new Map<string, number>()
const durationByCallId = new Map<string, number>()

export function trackToolCallDuration(part: AnyToolPart): string | null {
  const callId = part.toolCallId
  const frozen = durationByCallId.get(callId)
  if (frozen !== undefined) return formatToolCallDuration(frozen)

  if (isToolPartInFlight(part)) {
    getToolCallStartedAt(part)
    return null
  }

  const startedAt = startedAtByCallId.get(callId)
  if (startedAt === undefined) return null
  const elapsed = Date.now() - startedAt
  durationByCallId.set(callId, elapsed)
  startedAtByCallId.delete(callId)
  return formatToolCallDuration(elapsed)
}

export function getToolCallStartedAt(part: AnyToolPart): number | null {
  if (!isToolPartInFlight(part)) return null
  const callId = part.toolCallId
  const persisted = part.callProviderMetadata?.openwork?.toolStartedAt
  if (typeof persisted === "number" && Number.isFinite(persisted)) {
    startedAtByCallId.set(callId, persisted)
    return persisted
  }
  const existing = startedAtByCallId.get(callId)
  if (existing !== undefined) return existing
  if (typeof part.callProviderMetadata?.opencode?.partId === "string") return null
  const now = Date.now()
  startedAtByCallId.set(callId, now)
  return now
}

export function formatElapsedSeconds(seconds: number): string {
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  return `${minutes}m ${seconds % 60}s`
}

export function formatToolCallDuration(ms: number): string {
  const seconds = ms / 1000
  if (seconds < 10) return `${Math.max(0.1, Number(seconds.toFixed(1)))}s`
  return formatElapsedSeconds(Math.round(seconds))
}
