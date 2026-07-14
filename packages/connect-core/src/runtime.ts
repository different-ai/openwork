import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js"
import type {
  ConnectCapabilityMatch,
  ConnectCapabilitySource,
  ConnectExecuteInput,
  ConnectRuntime,
  ConnectSearchResult,
  ConnectSearchType,
  ConnectTextContent,
  ConnectToolResult,
} from "./contracts.js"

export const DEFAULT_EXECUTE_CAPABILITY_TIMEOUT_MS = 45_000
export const DEFAULT_EXECUTE_CAPABILITY_TIMEOUT_MESSAGE = "The capability call exceeded 45s. Retry once; if it times out again, narrow the request and report that the service is slow."

export function textContent(text: string): ConnectTextContent[] {
  return [{ type: "text", text }]
}

export function compareCapabilityMatches(a: ConnectCapabilityMatch, b: ConnectCapabilityMatch): number {
  const statusPriority = Number(b.kind === "connection_status") - Number(a.kind === "connection_status")
  return statusPriority || (b.score - a.score) || a.name.localeCompare(b.name)
}

export function capabilitySearchToolResult<T extends ConnectCapabilityMatch>(
  matches: T[],
  coverageHint?: string,
): ConnectToolResult & { structuredContent: { matches: T[]; hint?: string } } {
  const hint = [
    ...(matches.length === 0 ? ["No matches. Try broader or different keywords."] : []),
    ...(coverageHint ? [coverageHint] : []),
  ].join(" ")
  const result = hint ? { matches, hint } : { matches }
  return {
    content: textContent(JSON.stringify(result, null, 2)),
    structuredContent: result,
  }
}

export function unknownCapabilityToolResult(name: string): ConnectToolResult {
  return {
    isError: true,
    content: textContent(JSON.stringify({
      error: "unknown_capability",
      message: `No capability named "${name}". Call search_capabilities to find a valid name.`,
    })),
  }
}

export function ambiguousCapabilityToolResult(name: string, sourceIds: string[]): ConnectToolResult {
  return {
    isError: true,
    content: textContent(JSON.stringify({
      error: "ambiguous_capability",
      message: `Capability "${name}" is owned by more than one source and cannot be executed safely.`,
      sources: [...sourceIds].sort(),
    })),
  }
}

function capabilityTimeoutResult(capability: string, message: string): ConnectToolResult {
  return {
    isError: true,
    content: textContent(JSON.stringify({
      error: "capability_timeout",
      capability,
      message,
    })),
  }
}

function isTimeoutError(error: unknown): boolean {
  if (error instanceof McpError && error.code === ErrorCode.RequestTimeout) {
    return true
  }
  if (error instanceof DOMException && (error.name === "TimeoutError" || error.name === "AbortError")) {
    return true
  }
  return error instanceof Error && /\b(time(?:d)? out|timeout)\b/i.test(error.message)
}

export async function executeCapabilityWithBudget<T extends ConnectToolResult>(input: {
  capability: string
  timeoutMs?: number
  timeoutMessage?: string
  invoke: () => Promise<T>
}): Promise<T | ConnectToolResult> {
  const timeoutMessage = input.timeoutMessage ?? DEFAULT_EXECUTE_CAPABILITY_TIMEOUT_MESSAGE
  let timeout: ReturnType<typeof setTimeout> | undefined
  const timeoutResult = new Promise<ConnectToolResult>((resolve) => {
    timeout = setTimeout(
      () => resolve(capabilityTimeoutResult(input.capability, timeoutMessage)),
      input.timeoutMs ?? DEFAULT_EXECUTE_CAPABILITY_TIMEOUT_MS,
    )
  })
  try {
    const invocation = input.invoke()
    void invocation.catch(() => undefined)
    return await Promise.race([invocation, timeoutResult])
  } catch (error) {
    if (isTimeoutError(error)) {
      return capabilityTimeoutResult(input.capability, timeoutMessage)
    }
    throw error
  } finally {
    if (timeout) clearTimeout(timeout)
  }
}

function boundedLimit(limit?: number): number {
  return Math.max(1, Math.min(20, Math.trunc(limit ?? 5) || 5))
}

function sourceSupportsType(source: ConnectCapabilitySource, type: ConnectSearchType): boolean {
  return type === "all" || source.types.includes(type)
}

export function createConnectRuntime(options: {
  sources: readonly ConnectCapabilitySource[]
  executeTimeoutMs?: number
  executeTimeoutMessage?: string
}): ConnectRuntime {
  const sourceIds = new Set<string>()
  for (const source of options.sources) {
    if (sourceIds.has(source.id)) {
      throw new Error(`Duplicate Connect capability source id: ${source.id}`)
    }
    sourceIds.add(source.id)
  }

  return {
    async search(input): Promise<ConnectSearchResult> {
      const limit = boundedLimit(input.limit)
      const type = input.type ?? "all"
      const selectedSources = options.sources.filter((source) => sourceSupportsType(source, type))
      const sourceResults = await Promise.all(selectedSources.map((source) => source.search({
        query: input.query,
        limit,
        type,
      })))
      const matches = sourceResults
        .flatMap((result) => result.matches)
        .sort(compareCapabilityMatches)
        .slice(0, limit)
      const hint = sourceResults
        .map((result) => result.hint?.trim())
        .filter((value): value is string => Boolean(value))
        .join(" ") || undefined
      return { matches, ...(hint ? { hint } : {}) }
    },

    async execute(input): Promise<ConnectToolResult> {
      const ownership = await Promise.all(options.sources.map(async (source) => ({
        source,
        owns: await source.canExecute(input.name),
      })))
      const owners = ownership.filter((candidate) => candidate.owns).map((candidate) => candidate.source)
      if (owners.length === 0) {
        return unknownCapabilityToolResult(input.name)
      }
      if (owners.length > 1) {
        return ambiguousCapabilityToolResult(input.name, owners.map((source) => source.id))
      }
      const source = owners[0]
      if (!source) {
        return unknownCapabilityToolResult(input.name)
      }
      return executeCapabilityWithBudget({
        capability: input.name,
        timeoutMs: options.executeTimeoutMs,
        timeoutMessage: options.executeTimeoutMessage,
        invoke: () => source.execute(input),
      })
    },
  }
}
