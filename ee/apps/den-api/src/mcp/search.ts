import { getJsonRequestBodySchema, getParameters, getQueryParameterSchema, hasJsonRequestBody, pathParameterNamesFromTemplate, type McpToolOperation } from "./catalog.js"

export const SEARCH_CAPABILITIES_TOOL_NAME = "search_capabilities"
export const EXECUTE_CAPABILITY_TOOL_NAME = "execute_capability"
export type SearchCapabilityType = "all" | "api" | "admin" | "mcp" | "marketplace" | "skills"

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
  pathParams: string[]
  queryParams: string[]
  hasBody: boolean
  bodySchema?: unknown
  querySchema?: unknown
  outputSchema?: Record<string, unknown>
  argumentsSchema?: unknown
  invocation?: { argumentsField: "body" }
  readOnly?: boolean
  annotations?: CapabilityToolAnnotations
  scriptPath?: string
  kind?: string
  mcpApp?: { resourceUri: string }
}

export function compareCapabilityMatches(a: CapabilityMatch, b: CapabilityMatch): number {
  const statusPriority = Number("kind" in b && b.kind === "connection_status")
    - Number("kind" in a && a.kind === "connection_status")
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

export function tokenize(value: string): string[] {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 0)
}

const STOP_WORDS = new Set(["a", "an", "and", "any", "at", "for", "i", "in", "me", "my", "of", "on", "or", "our", "please", "some", "that", "the", "this", "to", "with", "your"])

export const THING_SYNONYM_GROUPS: readonly (readonly string[])[] = [
  ["email", "mail", "gmail", "inbox"],
  ["meeting", "event", "appointment"],
  ["ticket", "issue"],
  ["doc", "document", "file"],
  ["teammate", "colleague", "member", "user", "people", "person"],
  ["sprint", "cycle", "iteration"],
  ["pr", "pull"],
  ["repo", "repository"],
  ["spreadsheet", "sheet"],
  ["folder", "directory"],
]

const SYNONYM_GROUPS: readonly (readonly string[])[] = [
  ...THING_SYNONYM_GROUPS,
  ["find", "search", "lookup"],
  ["get", "read", "fetch", "retrieve", "view"],
  ["create", "add", "new", "make"],
  ["update", "edit", "modify", "change"],
  ["delete", "remove"],
  ["send", "post"],
  ["reply", "respond"],
]

export function singular(token: string): string {
  if (token.length > 4 && token.endsWith("ies")) return `${token.slice(0, -3)}y`
  if (token.length > 4 && /(?:ss|x|z|ch|sh)es$/.test(token)) return token.slice(0, -2)
  if (token.length > 3 && token.endsWith("s") && !/(?:ss|us|is)$/.test(token)) return token.slice(0, -1)
  return token
}

const SYNONYMS = new Map(SYNONYM_GROUPS.flatMap((group) => group.map((word) =>
  [word, group.filter((other) => other !== word)] as const)))

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

  const aliases = operation.operation["x-mcp-search-aliases"]
  const aliasTokens = Array.isArray(aliases)
    ? aliases.filter((alias): alias is string => typeof alias === "string").flatMap(tokenize)
    : []
  const nameTokens = [...tokenize(operation.name), ...aliasTokens]
  const summaryTokens = tokenize(summaryFor(operation))
  const pathTokens = tokenize(operation.path)
  const score = scoreText(nameTokens, summaryTokens, queryTokens, pathTokens)
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

const WORKFLOW_WORDS = new Set(["workflow", "workflows"])

export function workflowSearchBoost(input: { isWorkflow: boolean; ownedByCaller: boolean; queryTokens: readonly string[] }): number {
  if (!input.isWorkflow || !input.queryTokens.some((token) => WORKFLOW_WORDS.has(token))) return 0
  return input.ownedByCaller ? 2 : 1
}
