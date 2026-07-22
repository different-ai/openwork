import type { DenMemory } from "@/app/lib/den";

/**
 * Memories the panel should show = the server list minus any pending optimistic
 * deletes. Keeping the server list untouched in the query cache and filtering
 * through this "veil" means a background refetch can never resurrect a row that
 * is mid-delete (it stays hidden until the server delete confirms or is undone).
 */
export function visibleMemories(memories: DenMemory[], pendingDeleteIds: ReadonlySet<string>): DenMemory[] {
  return memories.filter((memory) => !pendingDeleteIds.has(memory.id));
}
