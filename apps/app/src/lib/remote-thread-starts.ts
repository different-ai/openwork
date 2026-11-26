import type { DynamicToolUIPart, UIMessage } from "ai"

import { codeModeToolCalls } from "@/lib/code-mode-tools"
import {
  mergeRemoteThreadStart,
  remoteSessionOutputMatchesCall,
  remoteThreadActivitiesFromToolPart,
  remoteThreadFollowUpFromToolPart,
  remoteThreadFromToolPart,
  remoteToolCallStartedAt,
  type RemoteThreadActivity,
  type RemoteThreadFollowUp,
  type RemoteThreadStart,
} from "@/lib/remote-session-thread"

export function codeModeCallsWithResults(part: DynamicToolUIPart): DynamicToolUIPart[] | null {
  const calls = codeModeToolCalls(part)
  if (!calls || calls.length === 0 || part.state !== "output-available") return calls
  if (calls.length === 1) {
    const only = calls[0]
    if (!only || only.state !== "output-available" || only.output !== undefined) return calls
    return [{ ...only, output: part.output }]
  }
  const matchingIndex = calls.reduce<number>(
    (found, call, index) => (
      call.state === "output-available"
      && call.output === undefined
      && remoteSessionOutputMatchesCall(call, part.output)
        ? index
        : found
    ),
    -1,
  )
  if (matchingIndex < 0) return calls
  return calls.map((call, index) => (index === matchingIndex && call.state === "output-available" ? { ...call, output: part.output } : call))
}

export function remoteThreadStartsInParts(parts: UIMessage["parts"]): { start: RemoteThreadStart; part: DynamicToolUIPart }[] {
  const starts = new Map<string, { start: RemoteThreadStart; part: DynamicToolUIPart }>()
  for (const part of parts) {
    if (part.type !== "dynamic-tool") continue
    for (const call of codeModeCallsWithResults(part) ?? [part]) {
      const start = remoteThreadFromToolPart(call)
      if (start && !starts.has(start.key)) starts.set(start.key, { start, part: call })
    }
  }
  return [...starts.values()]
}

export function remoteThreadActivitiesInParts(
  parts: UIMessage["parts"],
): { start: RemoteThreadStart; part: DynamicToolUIPart; kind: RemoteThreadActivity["kind"]; startedAt: number | null }[] {
  const activities = new Map<string, { start: RemoteThreadStart; part: DynamicToolUIPart; kind: RemoteThreadActivity["kind"]; startedAt: number | null }>()
  const rank: Record<RemoteThreadActivity["kind"], number> = { observed: 0, interaction: 1, create: 2 }
  for (const part of parts) {
    if (part.type !== "dynamic-tool") continue
    const scriptStartedAt = remoteToolCallStartedAt(part)
    for (const call of codeModeCallsWithResults(part) ?? [part]) {
      const startedAt = remoteToolCallStartedAt(call) ?? scriptStartedAt
      for (const activity of remoteThreadActivitiesFromToolPart(call)) {
        const existing = activities.get(activity.start.key)
        if (!existing) {
          activities.set(activity.start.key, { start: activity.start, part: call, kind: activity.kind, startedAt })
          continue
        }
        const preferred = rank[activity.kind] >= rank[existing.kind] ? activity.kind : existing.kind
        const merged = activity.kind === "create"
          ? mergeRemoteThreadStart(activity.start, existing.start)
          : mergeRemoteThreadStart(existing.start, activity.start)
        const latestAt = existing.startedAt === null
          ? startedAt
          : startedAt === null ? existing.startedAt : Math.max(existing.startedAt, startedAt)
        activities.set(activity.start.key, {
          start: merged,
          part: activity.kind === "create" ? call : existing.part,
          kind: preferred,
          startedAt: latestAt,
        })
      }
    }
  }
  return [...activities.values()]
}

export function remoteThreadFollowUpsInPart(part: DynamicToolUIPart): RemoteThreadFollowUp[] {
  const scriptStartedAt = remoteToolCallStartedAt(part)
  return (codeModeCallsWithResults(part) ?? [part]).flatMap((call) => {
    const followUp = remoteThreadFollowUpFromToolPart(call)
    if (!followUp) return []
    return [{ ...followUp, sentAt: followUp.sentAt ?? scriptStartedAt }]
  })
}

export function remoteThreadFollowUpsInParts(parts: UIMessage["parts"]): RemoteThreadFollowUp[] {
  return parts.flatMap((part) => part.type === "dynamic-tool" ? remoteThreadFollowUpsInPart(part) : [])
}
