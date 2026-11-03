import { isToolUIPart, type UIMessage } from "ai";
import { isTaskToolPart, taskChildSessionId, type TaskToolPart } from "./build-in-tools";

/** Native task associations form verified edges; a visited set protects cycles. */
export function agentInventory(parent: string, messages: UIMessage[], records: Record<string, {
  childSessionIds: string[]; runStartedAt: number;
}> = {}): TaskToolPart[] {
  const byChild = new Map<string, TaskToolPart>();
  for (const message of messages) for (const part of message.parts) {
    if (!isToolUIPart(part) || !isTaskToolPart(part)) continue;
    const child = taskChildSessionId(part);
    if (child && child !== parent) byChild.set(child, part);
  }
  const visited = new Set([parent]);
  const pending = [...byChild.keys(), ...(records[parent]?.childSessionIds ?? [])];
  while (pending.length) {
    const child = pending.shift()!;
    if (visited.has(child)) continue;
    visited.add(child);
    if (!byChild.has(child)) byChild.set(child, {
      type: "dynamic-tool", toolName: "task", toolCallId: `inventory:${child}`, state: "input-available",
      input: { description: "Agent", prompt: "", subagent_type: "" },
      callProviderMetadata: { openwork: { childSessionId: child, inventoryOnly: true } },
    });
    pending.push(...(records[child]?.childSessionIds ?? []));
  }
  return [...byChild.values()].sort((left, right) => {
    const start = (part: TaskToolPart) => part.callProviderMetadata?.openwork?.toolStartedAt
      ?? records[taskChildSessionId(part) ?? ""]?.runStartedAt ?? 0;
    return Number(start(left)) - Number(start(right));
  });
}
