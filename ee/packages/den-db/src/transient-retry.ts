import { setTimeout as delay } from "node:timers/promises"
import { Agent, fetch as undiciFetch, type RequestInit as UndiciRequestInit } from "undici"

// This bounds admission, backoff and the second attempt; it does not change
// the SDK's first-attempt timeout or retry a response body after headers arrive.
const RETRY_BUDGET_MS = 250
const SOCKET_ERROR_CODES = new Set(["ECONNRESET", "EPIPE", "UND_ERR_SOCKET"])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function isSocketFailure(error: unknown): boolean {
  const seen = new Set<object>()
  let socketFailure = false
  while (isRecord(error) && !seen.has(error)) {
    seen.add(error)
    // Cancellation and explicit provider responses take precedence over causes.
    if (error.name === "AbortError" || error.name === "TimeoutError" || typeof error.status === "number") return false
    if (typeof error.code === "string" && SOCKET_ERROR_CODES.has(error.code)) socketFailure = true
    error = error.cause
  }
  return socketFailure
}

function isStandaloneRead(body: unknown): boolean {
  if (typeof body !== "string") return false
  try {
    const parsed: unknown = JSON.parse(body)
    if (!isRecord(parsed) || parsed.session !== null || typeof parsed.query !== "string") return false
    // Conservative admission, not an SQL parser. Ambiguous SQL passes through
    // once, including functions, comments, multi-statements and locking reads.
    for (const [, word] of parsed.query.matchAll(/([\w$`]+)\s*\(/g)) {
      if (!word || !["where", "and", "or", "not", "in", "exists"].includes(word.toLowerCase())) return false
    }
    return /^\s*select\s/i.test(parsed.query)
      && !/[;#@]|--|\/\*|\b(?:for|lock|into)\b/i.test(parsed.query)
  } catch {
    return false
  }
}

// PlanetScale's edge sends no Keep-Alive hint, so undici's 4 s default closed
// idle sockets and the next query paid a new TCP and TLS handshake. The edge
// kept idle connections open for at least 90 s when measured; 30 s leaves margin
// against reusing a socket the server is closing.
export const PLANETSCALE_KEEP_ALIVE_MS = 30_000

/** One socket pool per driver client, so separate clients never queue behind each other. */
export function createPlanetScaleDispatcher(): Agent {
  return new Agent({ keepAliveTimeout: PLANETSCALE_KEEP_ALIVE_MS, keepAliveMaxTimeout: 10 * 60_000 })
}

export function createRetryingPlanetScaleFetch(dispatcher: Agent = createPlanetScaleDispatcher()) {
  const send = (input: string, init?: RequestInit) =>
    undiciFetch(input, { ...(init as UndiciRequestInit), dispatcher }) as unknown as Promise<Response>
  return async (input: string, init?: RequestInit): Promise<Response> => {
    const started = performance.now()
    init?.signal?.throwIfAborted()
    try {
      return await send(input, init)
    } catch (originalError) {
      init?.signal?.throwIfAborted()
      if (!isStandaloneRead(init?.body) || !isSocketFailure(originalError)) throw originalError
      const backoff = 25 + Math.floor(Math.random() * 25)
      if (performance.now() - started + backoff >= RETRY_BUDGET_MS) throw originalError
      try {
        await delay(backoff, undefined, { signal: init?.signal ?? undefined })
        init?.signal?.throwIfAborted()
        const remaining = Math.floor(RETRY_BUDGET_MS - (performance.now() - started))
        if (remaining <= 0) throw originalError
        const deadline = AbortSignal.timeout(remaining)
        const signal = init?.signal ? AbortSignal.any([init.signal, deadline]) : deadline
        console.warn("[db] retrying standalone PlanetScale read after socket failure")
        return await send(input, { ...init, signal })
      } catch {
        init?.signal?.throwIfAborted()
        throw originalError
      }
    }
  }
}
