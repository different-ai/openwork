import type { McpAppToolBinding } from "@openwork/types/mcp-app"

/**
 * What one capability a tool reaches does, as far as Den can tell: an
 * OpenWork read or a connection tool its provider marks read-only reads; an
 * OpenWork write, a tool its provider marks destructive, or anything Den
 * cannot inspect writes; any other connection tool is unlabeled.
 */
export type CapabilityAccess = "read" | "unlabeled" | "writes"

/**
 * How a tool may run from an App, given what each capability it reaches does.
 * It is read-only only when everything it reaches reads. Its author may ask to
 * load it on open, without a click, unless anything it reaches writes.
 */
export function bindingAccess(accesses: CapabilityAccess[], loadOnOpen: boolean | undefined): { readOnly: boolean; loadOnOpen?: true } | { refused: string } {
  const readOnly = accesses.every((access) => access === "read")
  if (!loadOnOpen) return { readOnly }
  if (accesses.includes("writes")) return { refused: "it changes data or is marked destructive, so it cannot load on open. Keep it on its own button." }
  return { readOnly, loadOnOpen: true }
}

/**
 * Read-only tools, including connection tools their provider marks read-only,
 * advertise it so hosts can run them without a click, and so do tools their
 * author chose to load on open, which Den refused to bind if they write.
 */
export function runsWithoutClick(binding: Pick<McpAppToolBinding, "readOnly" | "loadOnOpen">): boolean {
  return binding.readOnly || binding.loadOnOpen === true
}
