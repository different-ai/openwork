import type { ToolAnnotations } from "@modelcontextprotocol/server"

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export function withSafetyHints(annotations: unknown): ToolAnnotations {
  const stated: ToolAnnotations = isRecord(annotations) ? annotations as ToolAnnotations : {}
  if (stated.readOnlyHint === true) return stated
  return { ...stated, readOnlyHint: false, destructiveHint: stated.destructiveHint !== false }
}
