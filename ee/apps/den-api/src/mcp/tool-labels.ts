import type { ToolAnnotations } from "@modelcontextprotocol/server"

/**
 * Every tool Connect lists for a connection has a title and a safety hint,
 * whatever its source states. Clients decide from them which calls need
 * confirmation: Claude runs read-only tools without asking, always asks before
 * destructive ones, and lists a connector only when each tool has a title and
 * readOnlyHint or destructiveHint
 * (https://claude.com/docs/connectors/building/review-criteria#provide-tool-annotations).
 */

const TITLE_MAX_CHARS = 100

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** A one-line summary as the title, else the name in words: `list_issues` and `listIssues` become "List issues". */
export function toolTitle(name: string, summary?: string): string {
  const line = summary?.trim()
  if (line && line.length <= TITLE_MAX_CHARS && !line.includes("\n")) return line.replace(/\.$/, "")
  const words = name.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/[^A-Za-z0-9]+/g, " ").trim().toLowerCase()
  return words ? `${words[0]?.toUpperCase()}${words.slice(1)}` : name
}

/**
 * The stated annotations with the missing safety hints filled in. A tool not
 * stated read-only is a write, and a write not stated harmless is destructive,
 * which are MCP's own defaults written out. A read-only tool keeps exactly what
 * its source states: a provider's read-only claim is never extended into a
 * claim that the tool is harmless.
 */
export function withSafetyHints(annotations: unknown): ToolAnnotations {
  const stated: ToolAnnotations = isRecord(annotations) ? annotations as ToolAnnotations : {}
  if (stated.readOnlyHint === true) return stated
  return { ...stated, readOnlyHint: false, destructiveHint: stated.destructiveHint !== false }
}
