import type { CapabilityMatch, CapabilityToolAnnotations } from "./search.js"

/**
 * A search match in MCP `Tool` shape: `name`, `description`, the
 * `inputSchema` for `execute_capability`'s `arguments`, optional
 * `outputSchema` and `annotations`, plus the Den details a client acts on
 * (kind, connection status, App binding, script path).
 *
 * It also keeps the older fields (method, path, summary, pathParams,
 * queryParams, hasBody, bodySchema, querySchema, argumentsSchema, invocation,
 * readOnly) because desktop releases from before `inputSchema` still read
 * them and pass path, query, and body. Remove them once those have updated.
 * A connection's `path` is its server URL, which can carry credentials, so it
 * is left out; API route templates stay.
 */
export type CapabilityToolMatch = Omit<CapabilityMatch, "annotations" | "path"> & {
  path?: string
  description: string
  inputSchema: Record<string, unknown>
  annotations?: CapabilityToolAnnotations
}

const NO_ARGUMENTS = { type: "object", additionalProperties: false }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isServerUrl(path: string): boolean {
  return URL.canParse(path)
}

/**
 * Den API and native connector operations take `{ path, query, body }`, the
 * same shape as their Code Mode paths. Every other capability takes its own
 * arguments object.
 */
function inputSchemaFor(match: CapabilityMatch, httpArguments: boolean): Record<string, unknown> {
  if (isRecord(match.argumentsSchema)) return match.argumentsSchema
  if (!httpArguments) return match.hasBody ? { type: "object" } : NO_ARGUMENTS
  const properties: Record<string, unknown> = {}
  if (match.pathParams.length > 0) {
    properties.path = {
      type: "object",
      properties: Object.fromEntries(match.pathParams.map((name) => [name, { type: "string" }])),
      required: match.pathParams,
    }
  }
  if (isRecord(match.querySchema)) properties.query = match.querySchema
  else if (match.queryParams.length > 0) {
    properties.query = { type: "object", properties: Object.fromEntries(match.queryParams.map((name) => [name, {}])) }
  }
  if (match.hasBody) properties.body = match.bodySchema ?? { type: "object" }
  if (Object.keys(properties).length === 0) return NO_ARGUMENTS
  return { type: "object", properties, ...(match.pathParams.length > 0 ? { required: ["path"] } : {}), additionalProperties: false }
}

function annotationsFor(match: CapabilityMatch): CapabilityToolAnnotations | undefined {
  if (match.annotations) return match.annotations
  if (match.readOnly !== undefined) return { readOnlyHint: match.readOnly }
  if (match.method === "GET" || match.method === "SKILL") return { readOnlyHint: true }
  return undefined
}

export function capabilityToolMatch(match: CapabilityMatch, httpArguments: boolean): CapabilityToolMatch {
  const annotations = annotationsFor(match)
  const { annotations: _providerAnnotations, path, ...details } = match
  return {
    ...details,
    ...(isServerUrl(path) ? {} : { path }),
    name: match.name,
    description: match.summary,
    inputSchema: inputSchemaFor(match, httpArguments),
    ...(annotations ? { annotations } : {}),
  } as CapabilityToolMatch
}

export type CapabilityArgumentIssue = { path: string; keyword: string; message: string }

/** Map `arguments` onto Den's `path`, `query`, and `body` inputs, or list what is wrong. */
export function splitCapabilityArguments(
  args: unknown,
  httpArguments: boolean,
): { ok: true; path?: unknown; query?: unknown; body?: unknown } | { ok: false; issues: CapabilityArgumentIssue[] } {
  if (!httpArguments) return { ok: true, body: args }
  if (args === undefined || args === null) return { ok: true }
  if (!isRecord(args)) {
    return { ok: false, issues: [{ path: "", keyword: "type", message: "arguments must be an object with the path, query, and body described by inputSchema." }] }
  }
  const misplaced = Object.keys(args).filter((key) => key !== "path" && key !== "query" && key !== "body")
  if (misplaced.length > 0) {
    return { ok: false, issues: misplaced.map((key) => ({ path: `/${key}`, keyword: "additionalProperties", message: `Put ${key} under path, query, or body as described by inputSchema.` })) }
  }
  return { ok: true, path: args.path, query: args.query, body: args.body }
}

type CapabilityCall = { name: string; arguments?: unknown; path?: unknown; query?: unknown; body?: unknown }

/**
 * The input a source executes: `arguments`, when given, replaces the older
 * path/query/body fields. Misplaced arguments become a tool execution error
 * the model can correct.
 *
 * The older fields stay accepted for a while because callers still send them:
 * sessions that listed tools or searched on a Den build from before
 * `arguments` (including old instances still serving during a rollout),
 * Automation instructions written for that form, and outside MCP clients
 * following older guidance. Remove them once those have moved to `arguments`.
 */
export function capabilityCallInput<T extends CapabilityCall>(
  input: T,
  httpArguments: boolean,
): { ok: true; input: T } | { ok: false; error: Record<string, unknown> } {
  if (input.arguments === undefined) return { ok: true, input }
  const split = splitCapabilityArguments(input.arguments, httpArguments)
  if (!split.ok) {
    return {
      ok: false,
      error: {
        error: "invalid_capability_arguments",
        capability: input.name,
        message: "arguments do not match this capability's inputSchema.",
        issues: split.issues,
        retry: { action: "correct_arguments", searchRequired: false },
      },
    }
  }
  return { ok: true, input: { ...input, path: split.path, query: split.query, body: split.body } }
}
