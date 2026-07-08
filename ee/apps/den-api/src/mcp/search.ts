import { getParameters, hasJsonRequestBody, pathParameterNamesFromTemplate, type McpToolOperation } from "./catalog.js"
import { rankCapabilities } from "./ranking.js"
import type { CapabilityCandidate, CapabilityMatch } from "./ranking.js"

/**
 * `search_capabilities` is the "search" half of a search+execute facade laid
 * on top of the existing OpenAPI-derived catalog (`catalog.ts`) and its
 * existing in-process "execute" path (`invoke.ts`).
 *
 * Two consumers use this:
 * - The rich `/mcp` endpoint (`index.ts`), where matches are informational —
 *   the harness can call the matched tool name directly, since every
 *   catalog operation is also individually registered there.
 * - The minimal `/mcp/agent` endpoint (`agent.ts`), where matches are the
 *   *only* way to discover what's callable — that endpoint exposes nothing
 *   but `search_capabilities` and a generic `execute_capability`, so each
 *   match carries enough shape (`pathParams`/`queryParams`/`hasBody`) for the
 *   caller to construct a valid `execute_capability` call without guessing.
 */

export const SEARCH_CAPABILITIES_TOOL_NAME = "search_capabilities"

export type { CapabilityCandidate, CapabilityMatch } from "./ranking.js"
export { tokenizeText as tokenize } from "./ranking.js"

function summaryFor(operation: McpToolOperation): string {
  return operation.operation.summary ?? operation.operation.description ?? `${operation.method} ${operation.path}`
}

function parameterNames(parameters: ReturnType<typeof getParameters>): string[] {
  return parameters.flatMap((parameter) => typeof parameter.name === "string" ? [parameter.name] : [])
}

export function buildRestCandidates(catalog: McpToolOperation[]): CapabilityCandidate[] {
  return catalog.map((operation) => {
    const summary = summaryFor(operation)
    return {
      match: {
        name: operation.name,
        method: operation.method,
        path: operation.path,
        summary,
        pathParams: pathParameterNamesFromTemplate(operation.path),
        queryParams: parameterNames(getParameters(operation.operation, "query")),
        hasBody: hasJsonRequestBody(operation.operation),
        source: "rest",
      },
      searchText: {
        name: operation.name,
        summary,
        path: operation.path,
        keywords: operation.operation.tags ?? [],
      },
    }
  })
}

export function searchCapabilities(
  catalog: McpToolOperation[],
  query: string,
  limit = 5,
): CapabilityMatch[] {
  return rankCapabilities(query, buildRestCandidates(catalog), { limit })
}
