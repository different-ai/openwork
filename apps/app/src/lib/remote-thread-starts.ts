import type { DynamicToolUIPart, UIMessage } from "ai"

import { codeModeToolCalls } from "@/lib/code-mode-tools"
import { remoteThreadFromToolPart, type RemoteThreadStart } from "@/lib/remote-session-thread"

/**
 * A script's calls with their results. A one-call script whose call kept no
 * result of its own returned that call's result, as its row already shows.
 */
export function codeModeCallsWithResults(part: DynamicToolUIPart): DynamicToolUIPart[] | null {
  const calls = codeModeToolCalls(part)
  const only = calls?.length === 1 ? calls[0] : undefined
  if (!only || only.state !== "output-available" || only.output !== undefined || part.state !== "output-available") return calls
  return [{ ...only, output: part.output }]
}

/** Tasks one message's steps started on other computers, directly or from a script, once each. */
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
