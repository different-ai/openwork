import type { DynamicToolUIPart, ToolUIPart } from "ai"

// Relative so app-less evals specs can import this module without the app's
// "@/" path alias.
import { isToolPartInFlight } from "./tool-activity"

type AnyToolPart = ToolUIPart | DynamicToolUIPart

/**
 * Prefer native timing forwarded through provider metadata. Optimistic parts
 * use first observation until the engine reports its persisted start.
 */
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

/**
 * Epoch ms when this call started. Native timing wins across hydration;
 * optimistic parts retain their first-observed time across component remounts.
 * A restored engine part without timing stays explicitly unknown.
 */
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

/**
 * Live elapsed counters ("Working 12s") tick in whole seconds. Once a run
 * crosses a minute, show minutes and seconds ("Working 6m 43s") instead of
 * an ever-growing raw second count.
 */
export function formatElapsedSeconds(seconds: number): string {
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  return `${minutes}m ${seconds % 60}s`
}

export function formatToolCallDuration(ms: number): string {
  const seconds = ms / 1000
  if (seconds < 10) return `${Math.max(0.1, Number(seconds.toFixed(1)))}s`
  if (seconds < 60) return `${Math.round(seconds)}s`
  const minutes = Math.floor(seconds / 60)
  const rest = Math.round(seconds % 60)
  return `${minutes}m ${rest}s`
}
