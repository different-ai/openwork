import { DESKTOP_VIEWS, type DesktopView, type ToolResult, type ToolSpec } from "./types.js"

const NAMES: Record<DesktopView, string> = { browser: "the browser", computer: "the desktop's native applications" }

/** The views a conversation may use, or null when it may use all of them. */
const narrowed = (views: DesktopView[] | null) => (views && !DESKTOP_VIEWS.every((view) => views.includes(view)) ? views : null)

/** What the model is told about the visible desktop, naming only the views this conversation may use. */
export function desktopPrompt(views: DesktopView[] | null) {
  const only = narrowed(views)
  const where = only ? `${only.map((view) => NAMES[view]).join(" and ")} (view ${only.join(" or ")} only; the organization has not enabled the rest of the desktop)` : "the visible browser and native applications"
  return `Use desktop to work in ${where}. The organization enabled this computer: use it directly when needed. If the person takes control, wait for them to return it before continuing desktop operations.`
}

/**
 * The desktop tool, narrowed to the views this conversation may use: its `view` and `operation` choices list only
 * those, and its description says so first. Unchanged when every view is allowed.
 */
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
          // computer_run works on either view; the other computer_* operations are the native desktop's.
          operation: { ...properties.operation, enum: operations.filter((name) => name === "computer_run" || name.startsWith("computer_") !== browserOnly) },
        },
      },
    }
  })
}

/** A refusal for a desktop call on a view this conversation may not use; null when the call may go ahead. */
export function desktopViewRefused(views: DesktopView[] | null, input: Record<string, unknown>): ToolResult | null {
  const only = narrowed(views)
  if (!only || only.includes(input.view as DesktopView)) return null
  return { output: `Only view ${only.join(" or ")} is available in this conversation. The organization has not enabled the other desktop view.`, isError: true }
}
