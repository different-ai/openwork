import type { UIMessage } from "ai";
import { agentInventory } from "./agent-inventory";
import { taskChildSessionId } from "./build-in-tools";

/** Check both the observed association and current native ancestry before Stop. */
export async function verifyChildTarget(
  parentId: string,
  childId: string,
  messages: UIMessage[],
  records: Parameters<typeof agentInventory>[2],
  readSession: (id: string) => Promise<{ parentID?: string | null }>,
) {
  if (!agentInventory(parentId, messages, records).some(part => taskChildSessionId(part) === childId)) {
    throw new Error("This agent is no longer associated with this conversation.");
  }
  const visited = new Set<string>();
  let ancestor = (await readSession(childId)).parentID;
  while (ancestor && ancestor !== parentId && !visited.has(ancestor)) {
    visited.add(ancestor);
    ancestor = (await readSession(ancestor)).parentID;
  }
  if (ancestor !== parentId) throw new Error("The agent's parent could not be verified.");
}
