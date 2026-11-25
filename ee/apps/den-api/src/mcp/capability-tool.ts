function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export type CapabilityArgumentIssue = { path: string; keyword: string; message: string }

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
