import type { Command, Inventory, Request, Transport } from "./types.ts"
import { DEFAULT_OPERATION_TIMEOUT_MS, SessionRunnerError } from "./types.ts"
import { array, integer, object, parseCommand, parseComplete, parseInventory, parseProgress, parseRequest, parseRequestComplete, text } from "./protocol.ts"
import { bounded, throwIfAborted } from "./timeout.ts"

export interface RemoteSessionTransportOptions {
  baseUrl: string
  /** Evaluated for EVERY attempt. Never cached or written to the journal. */
  token: () => string | null
  fetch?: typeof globalThis.fetch
  timeoutMs?: number
}
export interface RemoteSessionTransport extends Transport {
  claimCommand(commandId: string, signal: AbortSignal): Promise<Command>
  claimRequest(requestId: string, signal: AbortSignal): Promise<Request>
  pendingRequests(signal: AbortSignal): Promise<Array<{ kind: "remote_session_request"; requestId: string }>>
  publishInventory(inventory: Inventory, signal: AbortSignal): Promise<void>
}
export class RemoteSessionHttpError extends Error {
  readonly status: number
  constructor(status: number) { super(`Remote-session HTTP request failed (${status}).`); this.name = "RemoteSessionHttpError"; this.status = status }
}
const MAX_RESPONSE_BYTES = 512 * 1024
function safeBase(value: string): URL {
  const url = new URL(value)
  const loopback = url.hostname === "localhost" || url.hostname === "[::1]" || /^127(?:\.\d{1,3}){3}$/.test(url.hostname)
  if ((url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) || url.username || url.password || url.search || url.hash) {
    throw new SessionRunnerError("unsafe_url", "Use HTTPS (or HTTP on loopback), without credentials, query, or fragment.")
  }
  if (!url.pathname.endsWith("/")) url.pathname += "/"
  return url
}
async function smallJson(response: Response, signal: AbortSignal): Promise<unknown> {
  const length = response.headers.get("content-length")
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > MAX_RESPONSE_BYTES)) {
    await response.body?.cancel()
    throw new SessionRunnerError("invalid_response", "Remote-session response exceeds the size limit.")
  }
  if (!response.body) throw new SessionRunnerError("invalid_response", "Remote-session response has no JSON body.")
  const reader = response.body.getReader()
  const decoder = new TextDecoder("utf-8", { fatal: true })
  let size = 0
  let body = ""
  try {
    for (;;) {
      throwIfAborted(signal)
      const chunk = await reader.read()
      if (chunk.done) break
      size += chunk.value.byteLength
      if (size > MAX_RESPONSE_BYTES) throw new SessionRunnerError("invalid_response", "Remote-session response exceeds the size limit.")
      body += decoder.decode(chunk.value, { stream: true })
    }
    body += decoder.decode()
    try { return JSON.parse(body) }
    catch { throw new SessionRunnerError("invalid_response", "Remote-session response is not valid JSON.") }
  } finally {
    // Cancels unread data on parse/size errors; also releases the reader on success.
    await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}

export function createRemoteSessionTransport(options: RemoteSessionTransportOptions): RemoteSessionTransport {
  const base = safeBase(options.baseUrl)
  const fetcher = options.fetch ?? globalThis.fetch
  const timeout = integer(options.timeoutMs ?? DEFAULT_OPERATION_TIMEOUT_MS, 1, 120_000)
  const id = (value: string) => {
    const parsed = text(value, 160)
    if (parsed === "." || parsed === "..") throw new SessionRunnerError("invalid_data", "A route ID cannot be a dot segment.")
    return encodeURIComponent(parsed)
  }
  async function call(path: string, method: "GET" | "POST" | "PUT", body: unknown, signal: AbortSignal): Promise<unknown> {
    return bounded(signal, timeout, async s => {
      const token = options.token()
      if (!token || /[\r\n]/.test(token)) throw new SessionRunnerError("missing_token", "A current runner token is required.")
      const response = await fetcher(new URL(path, base), {
        method, redirect: "error", signal: s,
        headers: { authorization: `Bearer ${token}`, accept: "application/json", ...(body === undefined ? {} : { "content-type": "application/json" }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      })
      if (response.redirected || (response.status >= 300 && response.status < 400)) {
        await response.body?.cancel()
        throw new SessionRunnerError("redirect_refused", "Remote-session requests cannot follow redirects.")
      }
      if (!response.ok) {
        await response.body?.cancel()
        // Provider body can contain secrets/user content; never copy it into an exception or journal.
        throw new RemoteSessionHttpError(response.status)
      }
      return smallJson(response, s)
    })
  }
  return {
    async complete(commandId, body, signal) {
      const parsed = parseComplete(body)
      const response = object(await call(`v1/remote-session-commands/${id(commandId)}/complete`, "POST", parsed, signal))
      const c = object(response.command)
      if (c.id !== commandId || c.status !== parsed.status || (parsed.status === "delivered"
        ? c.sessionId !== parsed.sessionId || c.workspaceId !== parsed.workspaceId
        : c.sessionId !== null || c.workspaceId !== null)) throw new SessionRunnerError("invalid_response", "Command acknowledgement does not match the submitted result.")
    },
    async report(commandId, progress, signal) {
      const response = object(await call(`v1/remote-session-commands/${id(commandId)}/session`, "POST", parseProgress(progress), signal))
      if (response.ok !== true) throw new SessionRunnerError("invalid_response", "Progress acknowledgement is invalid.")
    },
    async completeRequest(requestId, body, signal) {
      const parsed = parseRequestComplete(body)
      const response = object(await call(`v1/remote-session-requests/${id(requestId)}/complete`, "POST", parsed, signal))
      const r = object(response.request)
      if (r.id !== requestId || r.status !== parsed.status) throw new SessionRunnerError("invalid_response", "Request acknowledgement does not match the submitted result.")
    },
    async claimCommand(commandId, signal) {
      const response = object(await call(`v1/remote-session-commands/${id(commandId)}/claim`, "POST", {}, signal))
      const value = parseCommand(response.assignment)
      if (value.commandId !== commandId) throw new SessionRunnerError("invalid_response", "Claimed command ID does not match.")
      return value
    },
    async claimRequest(requestId, signal) {
      const response = object(await call(`v1/remote-session-requests/${id(requestId)}/claim`, "POST", {}, signal))
      const value = parseRequest(response.assignment)
      if (value.requestId !== requestId) throw new SessionRunnerError("invalid_response", "Claimed request ID does not match.")
      return value
    },
    async pendingRequests(signal) {
      const response = object(await call("v1/remote-session-requests/pending", "GET", undefined, signal))
      return array(response.items, 5, value => {
        const item = object(value)
        if (item.kind !== "remote_session_request") throw new SessionRunnerError("invalid_response", "Unexpected pending work kind.")
        return { kind: "remote_session_request", requestId: text(item.requestId, 160) }
      })
    },
    async publishInventory(inventory, signal) {
      const response = object(await call("v1/automation-runner/inventory", "PUT", parseInventory(inventory), signal))
      if (response.ok !== true) throw new SessionRunnerError("invalid_response", "Inventory acknowledgement is invalid.")
      integer(response.updatedAt)
    },
  }
}
