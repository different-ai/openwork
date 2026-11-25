import { DESKTOP_VIEWS, type DesktopView, type ToolResult, type ToolSpec } from "./types.js"

const NAMES: Record<DesktopView, string> = { browser: "the browser", computer: "the desktop's native applications" }

const narrowed = (views: DesktopView[] | null) => (views && !DESKTOP_VIEWS.every((view) => views.includes(view)) ? views : null)

export function desktopPrompt(views: DesktopView[] | null) {
  const only = narrowed(views)
  const where = only ? `${only.map((view) => NAMES[view]).join(" and ")} (view ${only.join(" or ")} only; the organization has not enabled the rest of the desktop)` : "the visible browser and native applications"
  return `Use desktop to work in ${where}. The organization enabled this computer: use it directly when needed. If the person takes control, wait for them to return it before continuing desktop operations.`
}

export function desktopToolsFor(tools: ToolSpec[], views: DesktopView[] | null): ToolSpec[] {
  const only = narrowed(views)
  if (!only) return tools
  const browserOnly = !only.includes("computer")
  return tools.map((tool) => {
    const properties = tool.inputSchema.properties as Record<string, { enum?: string[] }> | undefined
    const operations = properties?.operation?.enum
    if (!properties || !operations) return tool
    return {
      ...tool,
      description: `Only view ${only.join(" or ")} is available in this conversation; ignore the other view's operations.\n${tool.description}`,
      inputSchema: {
        ...tool.inputSchema,
        properties: {
          ...properties,
          view: { ...properties.view, enum: [...only] },
          operation: { ...properties.operation, enum: operations.filter((name) => name === "computer_run" || name.startsWith("computer_") !== browserOnly) },
        },
      },
    }
  })
}

export function desktopViewRefused(views: DesktopView[] | null, input: Record<string, unknown>): ToolResult | null {
  const only = narrowed(views)
  if (!only || only.includes(input.view as DesktopView)) return null
  return { output: `Only view ${only.join(" or ")} is available in this conversation. The organization has not enabled the other desktop view.`, isError: true }
}
