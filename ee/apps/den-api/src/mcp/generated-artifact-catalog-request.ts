export function needsGeneratedArtifactCatalog(method: string | null, params: unknown): boolean {
  if (method === "tools/list" || method === "resources/list") return true
  if (method !== "tools/call" || typeof params !== "object" || params === null) return false
  if (!("name" in params) || typeof params.name !== "string") return false
  let name = params.name
  if (name === "execute_capability" && "arguments" in params
    && typeof params.arguments === "object" && params.arguments !== null
    && "name" in params.arguments && typeof params.arguments.name === "string") {
    name = params.arguments.name
  }
  return /^(?:render|run|preview)_artifact_arv_[0-9a-hjkmnp-tv-z]{26}$/.test(name)
}
