import type { CapabilitySourceKind } from "./capability-registry.js"
import { singular, THING_SYNONYM_GROUPS, tokenize, type CapabilityMatch } from "./search.js"

export const ENGINE_LISTED_SOURCE_KINDS: ReadonlySet<CapabilitySourceKind> = new Set([
  "native",
  "externalMcp",
  "remoteSession",
  "slackSendAsBot",
])

export function unlistedCapabilityMatches<Match extends Pick<CapabilityMatch, "kind">>(matches: readonly Match[]): Match[] {
  return matches.filter((match) => match.kind !== "workflow")
}

function words(text: string): Set<string> {
  return new Set(tokenize(text).map(singular))
}

export function withRelatedWords(description: string, toolName: string): string {
  const present = new Set([...words(toolName), ...words(description)])
  const related = new Set(THING_SYNONYM_GROUPS
    .filter((group) => group.some((word) => present.has(word)))
    .flatMap((group) => group.filter((word) => !present.has(word))))
  return related.size > 0 ? `${description} Related words: ${[...related].join(", ")}.` : description
}

export type ConnectService = {
  namespace: string
  name: string
  ready: boolean
}

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

export function engineToolName(name: string): string {
  return name.replace(/[^A-Za-z0-9_-]/g, "_")
}
