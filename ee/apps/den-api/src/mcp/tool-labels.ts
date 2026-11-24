import type { ToolAnnotations } from "@modelcontextprotocol/server"

const TITLE_MAX_CHARS = 100

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export function toolTitle(name: string, summary?: string): string {
  const line = summary?.trim()
  if (line && line.length <= TITLE_MAX_CHARS && !line.includes("\n")) return line.replace(/\.$/, "")
  const words = name.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/[^A-Za-z0-9]+/g, " ").trim().toLowerCase()
  return words ? `${words[0]?.toUpperCase()}${words.slice(1)}` : name
}

export function withSafetyHints(annotations: unknown): ToolAnnotations {
  const stated: ToolAnnotations = isRecord(annotations) ? annotations as ToolAnnotations : {}
  if (stated.readOnlyHint === true) return stated
  return { ...stated, readOnlyHint: false, destructiveHint: stated.destructiveHint !== false }
}
