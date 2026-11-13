import type { McpAppToolBinding } from "@openwork/types/mcp-app"

/**
 * What one capability a tool reaches does, as far as Den can tell: an
 * OpenWork read or a connection tool its provider marks read-only reads; an
 * OpenWork write or a kind of capability Den cannot inspect writes; a
 * connection tool its provider marks destructive might, though a broad tool
 * carries that label even where a Workflow only reads through it; a connection
 * tool Den could not look up for this member is unknown; any other connection
 * tool is unlabeled.
 */
export type CapabilityAccess = "read" | "unlabeled" | "destructive" | "writes" | "unknown"

type ClickFields = Pick<McpAppToolBinding, "readOnly" | "loadOnOpen">

/**
 * How a tool may run from an App, given what each capability it reaches does.
 * It is read-only only when everything it reaches reads. Its author may ask to
 * load it on open, without a click, unless anything it reaches writes or is
 * marked destructive.
 */
export function bindingAccess(accesses: CapabilityAccess[], loadOnOpen: boolean | undefined): ClickFields | { refused: string } {
  const readOnly = accesses.every((access) => access === "read")
  if (!loadOnOpen) return { readOnly }
  if (accesses.includes("writes") || accesses.includes("destructive")) {
    return { refused: "it changes data or is marked destructive, so it cannot load on open. Keep it on its own button, or bind a saved Workflow that only reads through it." }
  }
  if (accesses.includes("unknown")) return { refused: "OpenWork could not check a connection it uses, so it cannot load on open. Connect it, then try again." }
  return { readOnly, loadOnOpen: true }
}

/**
 * How a saved Workflow may run from an App. Only a live one is read-only,
 * because Den supplies its input. Either mode is judged by what it reaches
 * when its author asks to load it on open, and a destructive label does not
 * decide that: the label covers all a broad tool can do, not what this
 * Workflow does with it, so the author's judgment stands, as for an unlabeled tool.
 */
export function workflowBindingAccess(mode: McpAppToolBinding["mode"], accesses: CapabilityAccess[], loadOnOpen: boolean | undefined): ClickFields | { refused: string } {
  const access = bindingAccess(accesses.map((reached) => reached === "destructive" ? "unlabeled" : reached), loadOnOpen)
  return "refused" in access ? access : { ...access, readOnly: mode === "live" && access.readOnly }
}

/**
 * Read-only tools, including connection tools their provider marks read-only,
 * advertise it so hosts can run them without a click, and so do tools their
 * author chose to load on open, which Den refused to bind if they write.
 */
export function runsWithoutClick(binding: ClickFields): boolean {
  return binding.readOnly || binding.loadOnOpen === true
}

/**
 * Whether a Workflow that skips the click may still run, given what it reaches
 * now that nothing unknown remains: a read-only one still only reads, and one
 * its author loads on open reaches nothing that writes.
 */
export function stillRunsWithoutClick(binding: ClickFields, accesses: CapabilityAccess[]): boolean {
  return binding.readOnly ? accesses.every((access) => access === "read") : !accesses.includes("writes")
}

/** The reason on an App tool's refusal when the App itself must change before the call can run. */
export const MCP_APP_NEEDS_UPDATE = "app_needs_update"

/**
 * Why a call to one of the App's tools was refused because the tool changed
 * at its provider since the App was published, or null for any other
 * refusal. Only an editor updating the App can fix these; retrying cannot.
 */
export function appToolChangeMessage(binding: Pick<McpAppToolBinding, "name" | "readOnly" | "loadOnOpen">, reason: string | undefined): string | null {
  if (reason === "provider_schema_changed") return `${binding.name} now takes different inputs than when this artifact was published, so OpenWork blocked it. An editor of this artifact needs to update its tools.`
  if (binding.loadOnOpen && reason === "provider_destructive") return `${binding.name} is now marked destructive by its provider, so OpenWork blocked it. An editor of this artifact needs to update its tools.`
  if (binding.readOnly && reason === "provider_not_read_only") return `${binding.name} is no longer marked read-only by its provider, so OpenWork blocked it. An editor of this artifact needs to update its tools.`
  return null
}
