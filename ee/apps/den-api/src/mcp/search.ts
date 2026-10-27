import { getJsonRequestBodySchema, getParameters, getQueryParameterSchema, hasJsonRequestBody, pathParameterNamesFromTemplate, type McpToolOperation } from "./catalog.js"

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
export const EXECUTE_CAPABILITY_TOOL_NAME = "execute_capability"
export type SearchCapabilityType = "all" | "api" | "admin" | "mcp" | "marketplace" | "skills"

/** MCP `Tool.annotations` hints. They come from providers, so clients treat them as untrusted. */
export type CapabilityToolAnnotations = {
  title?: string
  readOnlyHint?: boolean
  destructiveHint?: boolean
  idempotentHint?: boolean
  openWorldHint?: boolean
}

export type CapabilityMatch = {
  name: string
  method: string
  path: string
  score: number
  summary: string
  /** Path parameter names this tool's `path` template requires, e.g. ["workerId"]. */
  pathParams: string[]
  /** Query parameter names this tool documents, if any. */
  queryParams: string[]
  /** Whether calling this tool requires a JSON `body`. */
  hasBody: boolean
  /** Exact OpenAPI JSON schema for `body`, present only for JSON mutations. */
  bodySchema?: unknown
  /** Exact OpenAPI JSON schema for the query string parameters, present only when the operation documents any. */
  querySchema?: unknown
  outputSchema?: Record<string, unknown>
  /** Exact MCP arguments schema returned by a live MCP tool list. */
  argumentsSchema?: unknown
  /** Tells generic execute callers where MCP arguments must be supplied. */
  invocation?: { argumentsField: "body" }
  /** For a connection tool: whether its provider marks it read-only and not destructive. */
  readOnly?: boolean
  /** For a connection tool: the provider's own MCP tool annotations, unchanged. */
  annotations?: CapabilityToolAnnotations
  /** Exact confined-script path when Code Mode scripts are enabled. */
  scriptPath?: string
  /** Callable capability or a source-specific advisory/content kind. */
  kind?: string
  /** Standard MCP App binding advertised by the matched provider tool. */
  mcpApp?: { resourceUri: string }
}

export function compareCapabilityMatches(a: CapabilityMatch, b: CapabilityMatch): number {
  const statusPriority = Number("kind" in b && b.kind === "connection_status")
    - Number("kind" in a && a.kind === "connection_status")
  // Relevance leads globally; an actionable status only wins an equal-score tie.
  return (b.score - a.score) || statusPriority || a.name.localeCompare(b.name)
}

export function searchCapabilitySourceFilter(type?: SearchCapabilityType) {
  const capabilityType = type ?? "all"
  return {
    api: capabilityType === "all" || capabilityType === "api",
    admin: capabilityType === "all" || capabilityType === "admin",
    mcp: capabilityType === "all" || capabilityType === "mcp",
    marketplace: capabilityType === "all" || capabilityType === "marketplace" || capabilityType === "skills",
    skills: capabilityType === "all" || capabilityType === "skills",
  }
}

/**
 * Lowercase words, with camelCase / PascalCase split like snake_case, so a
 * provider tool `searchMessages` and a query `createConfigObject` match by word.
 */
export function tokenize(value: string): string[] {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 0)
}

/** Filler words in natural queries; scored, they prefix-match unrelated names ("to" → "today"). */
const STOP_WORDS = new Set(["a", "an", "and", "any", "at", "for", "i", "in", "me", "my", "of", "on", "or", "our", "please", "some", "that", "the", "this", "to", "with", "your"])

/**
 * Words people use for the same capability. A synonym earns less than the
 * word itself, so a direct match still ranks first.
 */
const SYNONYM_GROUPS: readonly (readonly string[])[] = [
  ["email", "mail", "gmail", "inbox"],
  ["meeting", "event", "appointment"],
  ["ticket", "issue"],
  ["doc", "document", "file"],
  ["teammate", "colleague", "member", "user", "people", "person"],
  ["sprint", "cycle", "iteration"],
  ["pr", "pull"],
  ["repo", "repository"],
  ["find", "search", "lookup"],
  ["get", "read", "fetch", "retrieve", "view"],
  ["create", "add", "new", "make"],
  ["update", "edit", "modify", "change"],
  ["delete", "remove"],
  ["send", "post"],
  ["reply", "respond"],
  ["spreadsheet", "sheet"],
  ["folder", "directory"],
]

/** Singular form of a plural word ("issues" → "issue", "entries" → "entry", "searches" → "search"). */
function singular(token: string): string {
  if (token.length > 4 && token.endsWith("ies")) return `${token.slice(0, -3)}y`
  if (token.length > 4 && /(?:ss|x|z|ch|sh)es$/.test(token)) return token.slice(0, -2)
  if (token.length > 3 && token.endsWith("s") && !/(?:ss|us|is)$/.test(token)) return token.slice(0, -1)
  return token
}

const SYNONYMS = new Map(SYNONYM_GROUPS.flatMap((group) => group.map((word) =>
  [word, group.filter((other) => other !== word)] as const)))

/** The query words that carry meaning: no filler words and no repeats, unless that leaves nothing. */
function searchTerms(queryTokens: string[]): string[] {
  const words = [...new Set(queryTokens)]
  const meaningful = words.filter((word) => !STOP_WORDS.has(word))
  return meaningful.length > 0 ? meaningful : words
}

export function scoreText(
  nameTokens: string[],
  summaryTokens: string[],
  queryTokens: string[],
  extraTokens: string[] = [],
): number {
  const names = nameTokens.map(singular)
  const nameSet = new Set(names)
  const summary = new Set(summaryTokens.map(singular))
  const extra = new Set(extraTokens.map(singular))
  let score = 0
  for (const word of searchTerms(queryTokens)) {
    const term = singular(word)
    let termScore = 0
    if (nameSet.has(term)) {
      // The same word form as asked keeps "pull requests" on the list tool
      // ahead of create_pull_request.
      termScore += nameTokens.includes(word) ? 6 : 5
    } else if (term.length >= 3 && names.some((token) => token.length >= 3 && (token.startsWith(term) || term.startsWith(token)))) {
      termScore += 3
    }
    if (summary.has(term)) {
      termScore += 2
    }
    if (extra.has(term)) {
      termScore += 1
    }
    if (termScore === 0) {
      const synonyms = SYNONYMS.get(term) ?? []
      if (synonyms.some((synonym) => nameSet.has(synonym))) termScore += 3
      if (synonyms.some((synonym) => summary.has(synonym))) termScore += 1
    }
    score += termScore
  }
  return score
}

function summaryFor(operation: McpToolOperation): string {
  return operation.operation.summary ?? operation.operation.description ?? `${operation.method} ${operation.path}`
}

function scoreOperation(operation: McpToolOperation, queryTokens: string[], exactName: string): number {
  if (queryTokens.length === 0) {
    return 0
  }

  // Curated operation aliases describe user intent without indexing arbitrary
  // request schemas (which would make generic fields match unrelated tools).
  const aliases = operation.operation["x-mcp-search-aliases"]
  const aliasTokens = Array.isArray(aliases)
    ? aliases.filter((alias): alias is string => typeof alias === "string").flatMap(tokenize)
    : []
  const nameTokens = [...tokenize(operation.name), ...aliasTokens]
  const summaryTokens = tokenize(summaryFor(operation))
  const pathTokens = tokenize(operation.path)
  const score = scoreText(nameTokens, summaryTokens, queryTokens, pathTokens)
  // Ordinary matches earn at most 6 + 2 + 1 per token. Promote an exact callable
  // name before source-local truncation, retaining priority in the aggregate sort.
  return score + (operation.name.toLowerCase() === exactName ? queryTokens.length * (6 + 2 + 1) + 1 : 0)
}

export function searchCapabilities(
  catalog: McpToolOperation[],
  query: string,
  limit = 5,
): CapabilityMatch[] {
  const queryTokens = tokenize(query)
  const exactName = query.trim().toLowerCase()
  const boundedLimit = Math.max(1, Math.min(20, Math.trunc(limit) || 5))

  return catalog
    .map((operation) => {
      const bodySchema = getJsonRequestBodySchema(operation.operation)
      const querySchema = getQueryParameterSchema(operation.operation)
      return {
        name: operation.name,
        method: operation.method,
        path: operation.path,
        score: scoreOperation(operation, queryTokens, exactName),
        summary: summaryFor(operation),
        pathParams: pathParameterNamesFromTemplate(operation.path),
        queryParams: getParameters(operation.operation, "query").map((parameter) => parameter.name as string),
        hasBody: hasJsonRequestBody(operation.operation),
        ...(bodySchema === undefined ? {} : { bodySchema }),
        ...(querySchema === undefined ? {} : { querySchema }),
        ...(operation.outputSchema === undefined ? {} : { outputSchema: operation.outputSchema }),
      }
    })
    .filter((match) => match.score > 0)
    .sort(compareCapabilityMatches)
    .slice(0, boundedLimit)
}
