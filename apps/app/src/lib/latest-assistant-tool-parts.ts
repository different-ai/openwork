import type { DynamicToolUIPart, UIMessage } from "ai";

export function collectLatestAssistantToolParts(messages: UIMessage[]): DynamicToolUIPart[] {
  let latestUserIndex = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === "user") {
      latestUserIndex = index;
      break;
    }
  }

  for (let index = messages.length - 1; index > latestUserIndex; index -= 1) {
    const message = messages[index];
    if (message?.role !== "assistant") continue;
    return message.parts.filter(
      (part): part is DynamicToolUIPart => part.type === "dynamic-tool",
    );
  }

  return [];
}
