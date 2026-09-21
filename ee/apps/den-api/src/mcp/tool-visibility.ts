function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** Omitted visibility includes the model; explicit app-only tools stay private. */
export function toolVisibleToModel(tool: { _meta?: unknown }): boolean {
  const meta = isRecord(tool._meta) ? tool._meta : {}
  const ui = isRecord(meta.ui) ? meta.ui : {}
  return ui.visibility === undefined || (Array.isArray(ui.visibility) && ui.visibility.includes("model"))
}
