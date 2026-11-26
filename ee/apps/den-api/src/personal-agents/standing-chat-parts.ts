import {
  REMOTE_SESSION_TRANSCRIPT_PARTS_MAX,
  REMOTE_SESSION_TRANSCRIPT_TEXT_MAX_LENGTH,
  type RemoteSessionTranscriptPart,
} from "@openwork/types/automations"
import type { RunnerMessage } from "../headless-runner/client.js"
import { boundCloudPage } from "../mcp/remote-session-transcript.js"

type ToolResult = Extract<RunnerMessage, { role: "tool" }>
type TurnParts = { id: string; parts: RemoteSessionTranscriptPart[] }

export function standingChatParts(turnIds: ReadonlySet<string>, messages: readonly RunnerMessage[]) {
  const resultsByTurn = new Map<string, Map<string, ToolResult>>()
  for (const message of messages) {
    if (!message.messageId || !turnIds.has(message.messageId) || message.role !== "tool") continue
    const results = resultsByTurn.get(message.messageId) ?? new Map<string, ToolResult>()
    results.set(message.callId, message)
    resultsByTurn.set(message.messageId, results)
  }

  const byTurn = new Map<string, TurnParts>()
  for (const message of messages) {
    if (!message.messageId || !turnIds.has(message.messageId) || message.role !== "assistant") continue
    const turn = byTurn.get(message.messageId) ?? { id: message.messageId, parts: [] }
    if (message.text.trim()) {
      turn.parts.push({ type: "text", text: message.text.slice(0, REMOTE_SESSION_TRANSCRIPT_TEXT_MAX_LENGTH) })
    }
    for (const call of message.toolCalls) {
      const result = resultsByTurn.get(message.messageId)?.get(call.id)
      turn.parts.push({
        type: "tool",
        id: call.id.slice(0, 240),
        name: call.name.slice(0, 240),
        status: result ? result.isError ? "error" : "completed" : "running",
        input: null,
        output: null,
        error: null,
        truncated: false,
      })
    }
    byTurn.set(turn.id, turn)
  }
  return new Map(boundCloudPage([...byTurn.values()].flatMap((turn) => turn.parts.length
    ? [{ ...turn, parts: turn.parts.slice(-REMOTE_SESSION_TRANSCRIPT_PARTS_MAX) }]
    : [])).map(({ id, parts }) => [id, parts]))
}
