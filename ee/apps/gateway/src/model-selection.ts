// Provider-specific server-side routing features can select a second model
// after the gateway's check. These are not covered by a grant for body.model.
export function hasAlternateModelSelection(body: Record<string, unknown>, providerId: string): boolean {
  if (["modelId", "model_id", "deployment", "deployment_id", "models", "fallbacks"].some((key) => Object.hasOwn(body, key))) return true
  if (providerId !== "openrouter") return false
  if (["preset", "route"].some((key) => Object.hasOwn(body, key))) return true
  const object = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value)
  if (Array.isArray(body.plugins)) for (const plugin of body.plugins) {
    if (!object(plugin)) continue
    if (typeof plugin.id === "string" && plugin.id.trim().toLowerCase() === "fusion") return true
    for (const value of [plugin, plugin.parameters]) {
      if (object(value) && ["model", "analysis_models", "allowed_models"].some((key) => Object.hasOwn(value, key))) return true
    }
  }
  if (Array.isArray(body.tools)) for (const tool of body.tools) {
    if (!object(tool) || typeof tool.type !== "string") continue
    if (["openrouter:advisor", "openrouter:subagent", "openrouter:fusion", "openrouter:image_generation"]
      .includes(tool.type.trim().toLowerCase().replace(/-/g, "_"))) return true
  }
  return false
}
