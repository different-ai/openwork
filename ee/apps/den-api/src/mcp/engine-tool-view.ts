import type { CapabilitySourceKind } from "./capability-registry.js"
import { singular, THING_SYNONYM_GROUPS, tokenize, type CapabilityMatch } from "./search.js"

/**
 * Connect for OpenWork's own engine (`connectEngineTools`, connect-tool-view.ts).
 *
 * The engine searches MCP tools itself: its Code Mode lists a catalog and
 * ranks `search()` results by the words in each tool's path, description and
 * parameters (OpenCode v2 `packages/codemode/src/tool-runtime.ts`). So the
 * engine gets the full view, every connection action, Workflow, App and remote
 * session as its own tool, served on the one OpenWork Connect server so
 * OpenWork's own handling of those calls (sign-in cards, Apps, labels) is
 * unchanged. On top of the full view it gets:
 *
 * - capability search and execute for what has no tool of its own: OpenWork's
 *   operations and skills;
 * - a directory of connected services in the instructions, because the catalog
 *   groups every tool under the one server;
 * - related words in tool descriptions, because the engine's ranking knows no
 *   synonyms and Den's does.
 */

/** Sources whose capabilities the full view lists as tools, so capability search leaves them out. */
export const ENGINE_LISTED_SOURCE_KINDS: ReadonlySet<CapabilitySourceKind> = new Set([
  "native",
  "externalMcp",
  "remoteSession",
  "slackSendAsBot",
])

/** Matches that have no tool of their own: saved Workflows are `run-workflow.*` tools. */
export function unlistedCapabilityMatches<Match extends Pick<CapabilityMatch, "kind">>(matches: readonly Match[]): Match[] {
  return matches.filter((match) => match.kind !== "workflow")
}

function words(text: string): Set<string> {
  return new Set(tokenize(text).map(singular))
}

/**
 * A tool description with the other names for the things it mentions, so a
 * keyword search for "ticket" finds `create_issue`. Only names for things are
 * added: verbs would be added to nearly every tool and rank nothing.
 */
export function withRelatedWords(description: string, toolName: string): string {
  const present = new Set([...words(toolName), ...words(description)])
  const related = new Set(THING_SYNONYM_GROUPS
    .filter((group) => group.some((word) => present.has(word)))
    .flatMap((group) => group.filter((word) => !present.has(word))))
  return related.size > 0 ? `${description} Related words: ${[...related].join(", ")}.` : description
}

export type ConnectService = {
  /** The first segment of the service's tool names (`linear` for `linear.list_issues`). */
  namespace: string
  name: string
  /** False while the member has not connected it: its tools are not listed yet. */
  ready: boolean
}

/**
 * The connected services the instructions name, within `budgetChars`, ending
 * with a pointer to search() for the ones that do not fit; with no room for
 * that pointer there is no directory. Engines show tool names with dots as
 * underscores, so each service is named by the prefix `<namespace>_`.
 */
export function serviceDirectoryInstructions(services: readonly ConnectService[], budgetChars: number): string {
  if (services.length === 0) return ""
  const header = "Connected services, by the prefix of their tool names; find a service's tools with search():"
  const more = (count: number) => `- …and ${count} more; search() finds them.`
  if (header.length + 1 + more(services.length).length > budgetChars) return ""
  const ordered = [...services].sort((left, right) => Number(right.ready) - Number(left.ready) || left.namespace.localeCompare(right.namespace))
  const lines: string[] = []
  let used = header.length
  for (const [index, service] of ordered.entries()) {
    const line = service.ready
      ? `- ${service.namespace}_: ${service.name}`
      : `- ${service.namespace}_: ${service.name}, not connected for you yet (connection_status shows how)`
    const pointer = index === ordered.length - 1 ? 0 : more(ordered.length - index - 1).length + 1
    if (used + line.length + 1 + pointer > budgetChars) {
      lines.push(more(ordered.length - index))
      break
    }
    lines.push(line)
    used += line.length + 1
  }
  return [header, ...lines].join("\n")
}

/** A tool's name as OpenWork's engine shows it: OpenCode replaces characters outside `[A-Za-z0-9_-]` with `_`. */
export function engineToolName(name: string): string {
  return name.replace(/[^A-Za-z0-9_-]/g, "_")
}
