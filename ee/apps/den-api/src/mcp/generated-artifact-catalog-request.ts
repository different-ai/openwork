/** Static authoring tools register without a catalog; exact resources load separately. */
export function needsGeneratedArtifactCatalog(method: string | null, params: unknown): boolean {
  // SDK v2 server/discover, like legacy initialize, advertises capabilities
  // only; it does not aggregate listings. Static app resources establish the
  // tools/resources capabilities without querying generated views.
  if (method === "tools/list" || method === "resources/list") return true
  if (method !== "tools/call" || typeof params !== "object" || params === null) return false
  if (!("name" in params) || typeof params.name !== "string") return false
  let name = params.name
  // Preserve indirect routing when a client wraps a direct tool invocation.
  if (name === "execute_capability" && "arguments" in params
    && typeof params.arguments === "object" && params.arguments !== null
    && "name" in params.arguments && typeof params.arguments.name === "string") {
    name = params.arguments.name
  }
  return /^(?:render|run|preview)_artifact_arv_[0-9a-hjkmnp-tv-z]{26}$/.test(name)
}
