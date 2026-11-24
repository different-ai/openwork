import { isToolUIPart, type UIMessage } from "ai";
import type { Part } from "@opencode-ai/sdk/v2/client";

type ToolLink = { messageID: string; callID: string };

export function isTerminalToolPart(part: Part): part is Extract<Part, { type: "tool" }> {
  return part.type === "tool" && (part.state.status === "completed" || part.state.status === "error");
}

export function terminalToolCallIds(messages: ReadonlyArray<{ parts: ReadonlyArray<Part> }>): Set<string> {
  const ids = new Set<string>();
  for (const message of messages) {
    for (const part of message.parts) if (isTerminalToolPart(part)) ids.add(part.callID);
  }
  return ids;
}

export function terminalTranscriptToolCallIds(messages: ReadonlyArray<UIMessage>): Set<string> {
  const ids = new Set<string>();
  for (const message of messages) {
    for (const part of message.parts) {
      if (isToolUIPart(part) && (part.state === "output-available" || part.state === "output-error")) ids.add(part.toolCallId);
    }
  }
  return ids;
}

export function isOrphanedInteraction(tool: ToolLink | undefined, terminalCallIds: ReadonlySet<string>): boolean {
  return tool !== undefined && terminalCallIds.has(tool.callID);
}
