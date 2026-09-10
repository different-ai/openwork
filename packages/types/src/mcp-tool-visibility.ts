/** Missing visibility serves both audiences; malformed declarations serve neither. */
export function mcpToolVisibleTo(tool: { _meta?: unknown }, audience: "model" | "app"): boolean {
  const meta = tool._meta;
  if (typeof meta !== "object" || meta === null || !("ui" in meta)) return true;
  const ui = meta.ui;
  if (typeof ui !== "object" || ui === null || !("visibility" in ui)) return true;
  const visibility = ui.visibility;
  if (visibility === undefined) return true;
  return Array.isArray(visibility)
    && visibility.every((entry) => entry === "model" || entry === "app")
    && visibility.includes(audience);
}
