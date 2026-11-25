import type { McpAppToolBinding } from "@openwork/types/mcp-app"

export type CapabilityAccess = "read" | "unlabeled" | "destructive" | "writes" | "unknown"

type ClickFields = Pick<McpAppToolBinding, "readOnly" | "loadOnOpen">

export function bindingAccess(accesses: CapabilityAccess[], loadOnOpen: boolean | undefined): ClickFields | { refused: string } {
  const readOnly = accesses.every((access) => access === "read")
  if (!loadOnOpen) return { readOnly }
  if (accesses.includes("writes") || accesses.includes("destructive")) {
    return { refused: "it changes data or is marked destructive, so it cannot load on open. Keep it on its own button, or bind a saved Workflow that only reads through it." }
  }
  if (accesses.includes("unknown")) return { refused: "OpenWork could not check a connection it uses, so it cannot load on open. Connect it, then try again." }
  return { readOnly, loadOnOpen: true }
}

export function workflowBindingAccess(mode: McpAppToolBinding["mode"], accesses: CapabilityAccess[], loadOnOpen: boolean | undefined): ClickFields | { refused: string } {
  const access = bindingAccess(accesses.map((reached) => reached === "destructive" ? "unlabeled" : reached), loadOnOpen)
  return "refused" in access ? access : { ...access, readOnly: mode === "live" && access.readOnly }
}

export function runsWithoutClick(binding: ClickFields): boolean {
  return binding.readOnly || binding.loadOnOpen === true
}

export function stillRunsWithoutClick(binding: ClickFields, accesses: CapabilityAccess[]): boolean {
  return binding.readOnly ? accesses.every((access) => access === "read") : !accesses.includes("writes")
}

export const MCP_APP_NEEDS_UPDATE = "app_needs_update"

export function appToolChangeMessage(binding: Pick<McpAppToolBinding, "name" | "readOnly" | "loadOnOpen">, reason: string | undefined): string | null {
  if (reason === "provider_schema_changed") return `${binding.name} now takes different inputs than when this artifact was published, so OpenWork blocked it. An editor of this artifact needs to update its tools.`
  if (binding.loadOnOpen && reason === "provider_destructive") return `${binding.name} is now marked destructive by its provider, so OpenWork blocked it. An editor of this artifact needs to update its tools.`
  if (binding.readOnly && reason === "provider_not_read_only") return `${binding.name} is no longer marked read-only by its provider, so OpenWork blocked it. An editor of this artifact needs to update its tools.`
  return null
}
