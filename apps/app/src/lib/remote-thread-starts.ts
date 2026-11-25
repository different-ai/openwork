import type { DynamicToolUIPart, UIMessage } from "ai"

import { codeModeToolCalls } from "@/lib/code-mode-tools"
import {
  remoteThreadFollowUpFromToolPart,
  remoteThreadFromToolPart,
  remoteToolCallStartedAt,
  type RemoteThreadFollowUp,
  type RemoteThreadStart,
} from "@/lib/remote-session-thread"

export function codeModeCallsWithResults(part: DynamicToolUIPart): DynamicToolUIPart[] | null {
  const calls = codeModeToolCalls(part)
  const only = calls?.length === 1 ? calls[0] : undefined
  if (!only || only.state !== "output-available" || only.output !== undefined || part.state !== "output-available") return calls
  return [{ ...only, output: part.output }]
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
