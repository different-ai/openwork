import WebSocket from "ws"
import { CloudBrowserError, type BrowserEndpoint } from "./contract"

/**
 * Minimal Chrome DevTools Protocol client: commands, events, and flat target
 * sessions over one WebSocket. `ws` (not the global WebSocket) so provider
 * headers reach the upgrade request.
 */

export type CdpEvent = {
  method: string
  params: Record<string, unknown>
  /** Flat-mode session the event belongs to; `null` for browser-level events. */
  sessionId: string | null
}

export type CdpSendOptions = {
  sessionId?: string
  timeoutMs?: number
}

export class CdpCommandError extends Error {
  readonly method: string

  constructor(method: string, message: string) {
    super(`${method}: ${message}`)
    this.name = "CdpCommandError"
    this.method = method
  }
}

const DEFAULT_COMMAND_TIMEOUT_MS = 15_000
const DEFAULT_CONNECT_TIMEOUT_MS = 10_000
const MAX_MESSAGE_BYTES = 64 * 1024 * 1024

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export function stringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key]
  return typeof value === "string" ? value : undefined
}

export function numberField(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key]
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

/** `path` on the endpoint's base URL, keeping any provider query parameters. */
export function endpointUrl(endpoint: Pick<BrowserEndpoint, "cdpUrl">, path: string): string {
  const base = new URL(endpoint.cdpUrl)
  base.pathname = `${base.pathname.replace(/\/+$/, "")}${path}`
  return base.toString()
}

/**
 * Chrome reports `ws://127.0.0.1:<port>/devtools/...`, which is unreachable
 * through a proxy such as a Daytona preview URL. Keep Chrome's path and move
 * it onto the endpoint's scheme, host, port and query.
 */
export function debuggerUrlFor(baseUrl: string, webSocketDebuggerUrl: string): string {
  const base = new URL(baseUrl)
  const ws = new URL(webSocketDebuggerUrl)
  ws.protocol = base.protocol === "https:" ? "wss:" : "ws:"
  ws.hostname = base.hostname
  ws.port = base.port
  ws.username = ""
  ws.password = ""
  const basePath = base.pathname.replace(/\/+$/, "")
  if (basePath && !ws.pathname.startsWith(`${basePath}/`)) ws.pathname = `${basePath}${ws.pathname}`
  for (const [name, value] of base.searchParams) ws.searchParams.set(name, value)
  return ws.toString()
}

export type BrowserVersion = {
  browser: string
  webSocketDebuggerUrl: string
}

/** `GET /json/version`; throws `not_running` when nothing answers. */
export async function readBrowserVersion(
  endpoint: BrowserEndpoint,
  options: { timeoutMs?: number; signal?: AbortSignal; fetch?: typeof fetch } = {},
): Promise<BrowserVersion> {
  const timeout = AbortSignal.timeout(options.timeoutMs ?? 5_000)
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout
  const fetchImpl = options.fetch ?? fetch
  let response: Response
  try {
    response = await fetchImpl(endpointUrl(endpoint, "/json/version"), { headers: endpoint.headers, signal })
  } catch (error) {
    throw new CloudBrowserError("not_running", "The browser is not answering.", { cause: error })
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined)
    throw new CloudBrowserError("not_running", `The browser answered with status ${response.status}.`)
  }
  const payload: unknown = await response.json().catch(() => null)
  if (!isRecord(payload) || typeof payload.webSocketDebuggerUrl !== "string") {
    throw new CloudBrowserError("not_running", "The browser did not describe its DevTools endpoint.")
  }
  return {
    browser: stringField(payload, "Browser") ?? "",
    webSocketDebuggerUrl: debuggerUrlFor(endpoint.cdpUrl, payload.webSocketDebuggerUrl),
  }
}

type Pending = {
  method: string
  resolve: (result: Record<string, unknown>) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

function rawText(data: WebSocket.RawData): string {
  if (Buffer.isBuffer(data)) return data.toString("utf8")
  if (Array.isArray(data)) return Buffer.concat(data.map((chunk) => Uint8Array.from(chunk))).toString("utf8")
  return Buffer.from(data).toString("utf8")
}

export class CdpConnection {
  readonly #socket: WebSocket
  readonly #pending = new Map<number, Pending>()
  readonly #listeners = new Set<(event: CdpEvent) => void>()
  #nextId = 1
  #closedError: Error | null = null

  private constructor(socket: WebSocket) {
    this.#socket = socket
    socket.on("message", (data) => this.#onMessage(data))
    socket.on("close", () => this.#onClosed(new CloudBrowserError("browser_operation_failed", "The browser connection closed.")))
    socket.on("error", (error) => this.#onClosed(new CloudBrowserError("browser_operation_failed", "The browser connection failed.", { cause: error })))
  }

  static connect(url: string, options: { headers?: Record<string, string>; timeoutMs?: number; signal?: AbortSignal } = {}): Promise<CdpConnection> {
    const timeoutMs = options.timeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(url, {
        headers: options.headers,
        handshakeTimeout: timeoutMs,
        perMessageDeflate: false,
        maxPayload: MAX_MESSAGE_BYTES,
      })
      let settled = false
      const fail = (error: Error) => {
        if (settled) return
        settled = true
        options.signal?.removeEventListener("abort", onAbort)
        socket.terminate()
        reject(error)
      }
      const onAbort = () => fail(new CloudBrowserError("timeout", "The browser connection was cancelled."))
      if (options.signal?.aborted) return onAbort()
      options.signal?.addEventListener("abort", onAbort, { once: true })
      socket.once("open", () => {
        if (settled) return
        settled = true
        options.signal?.removeEventListener("abort", onAbort)
        resolve(new CdpConnection(socket))
      })
      // Bun's `ws` shim lacks this event (and warns); its "error" covers the same case.
      if (!("Bun" in globalThis)) {
        socket.once("unexpected-response", (_request, response) => {
          response.resume()
          fail(new CloudBrowserError("not_running", `The browser refused the DevTools connection (${response.statusCode ?? "no status"}).`))
        })
      }
      socket.once("error", (error) => fail(new CloudBrowserError("not_running", "Could not connect to the browser.", { cause: error })))
    })
  }

  get closed(): boolean {
    return this.#closedError !== null
  }

  send(method: string, params: Record<string, unknown> = {}, options: CdpSendOptions = {}): Promise<Record<string, unknown>> {
    if (this.#closedError) return Promise.reject(this.#closedError)
    const id = this.#nextId
    this.#nextId += 1
    const timeoutMs = options.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id)
        reject(new CloudBrowserError("timeout", `The browser did not answer ${method} in time.`))
      }, timeoutMs)
      this.#pending.set(id, { method, resolve, reject, timer })
      const message = JSON.stringify({ id, method, params, ...(options.sessionId ? { sessionId: options.sessionId } : {}) })
      this.#socket.send(message, (error) => {
        if (!error) return
        const pending = this.#pending.get(id)
        if (!pending) return
        this.#pending.delete(id)
        clearTimeout(pending.timer)
        reject(new CloudBrowserError("browser_operation_failed", "Could not reach the browser.", { cause: error }))
      })
    })
  }

  /** Subscribe to every event; returns the unsubscribe function. */
  onEvent(listener: (event: CdpEvent) => void): () => void {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  /**
   * Resolves with the first matching event. Subscribe before sending the
   * command that triggers it, and always `cancel()` when no longer needed.
   */
  waitForEvent(predicate: (event: CdpEvent) => boolean, timeoutMs: number): { promise: Promise<CdpEvent>; cancel: () => void } {
    let cancel = () => {}
    const promise = new Promise<CdpEvent>((resolve, reject) => {
      if (this.#closedError) return reject(this.#closedError)
      const finish = () => {
        clearTimeout(timer)
        unsubscribe()
        this.#listeners.delete(onClose)
      }
      const timer = setTimeout(() => {
        finish()
        reject(new CloudBrowserError("timeout", "The page did not finish loading in time."))
      }, timeoutMs)
      const unsubscribe = this.onEvent((event) => {
        if (!predicate(event)) return
        finish()
        resolve(event)
      })
      // A closed connection notifies listeners with a synthetic event.
      const onClose = (event: CdpEvent) => {
        if (event.method !== "__closed__") return
        finish()
        reject(this.#closedError ?? new CloudBrowserError("browser_operation_failed", "The browser connection closed."))
      }
      this.#listeners.add(onClose)
      cancel = () => {
        finish()
        resolve({ method: "__cancelled__", params: {}, sessionId: null })
      }
    })
    return { promise, cancel: () => cancel() }
  }

  close(): void {
    this.#onClosed(new CloudBrowserError("browser_operation_failed", "The browser connection closed."))
    if (this.#socket.readyState === WebSocket.OPEN || this.#socket.readyState === WebSocket.CONNECTING) {
      this.#socket.close()
      const timer = setTimeout(() => this.#socket.terminate(), 1_000)
      timer.unref?.()
    }
  }

  #onMessage(data: WebSocket.RawData) {
    let message: unknown
    try {
      message = JSON.parse(rawText(data))
    } catch {
      return
    }
    if (!isRecord(message)) return
    if (typeof message.id === "number") {
      const pending = this.#pending.get(message.id)
      if (!pending) return
      this.#pending.delete(message.id)
      clearTimeout(pending.timer)
      if (isRecord(message.error)) pending.reject(new CdpCommandError(pending.method, stringField(message.error, "message") ?? "failed"))
      else pending.resolve(isRecord(message.result) ? message.result : {})
      return
    }
    if (typeof message.method !== "string") return
    const event: CdpEvent = {
      method: message.method,
      params: isRecord(message.params) ? message.params : {},
      sessionId: typeof message.sessionId === "string" ? message.sessionId : null,
    }
    for (const listener of [...this.#listeners]) listener(event)
  }

  #onClosed(error: Error) {
    if (this.#closedError) return
    this.#closedError = error
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(error)
    }
    this.#pending.clear()
    for (const listener of [...this.#listeners]) listener({ method: "__closed__", params: {}, sessionId: null })
  }
}

/** Connects to the browser target (not a page), so one socket can drive every tab. */
export async function connectBrowser(
  endpoint: BrowserEndpoint,
  options: { timeoutMs?: number; signal?: AbortSignal; fetch?: typeof fetch } = {},
): Promise<CdpConnection> {
  const version = await readBrowserVersion(endpoint, options)
  return CdpConnection.connect(version.webSocketDebuggerUrl, {
    headers: endpoint.headers,
    timeoutMs: options.timeoutMs,
    signal: options.signal,
  })
}

/** One stateless operation: connect, run, always disconnect. */
export async function withBrowser<T>(
  endpoint: BrowserEndpoint,
  run: (cdp: CdpConnection) => Promise<T>,
  options: { timeoutMs?: number; signal?: AbortSignal; fetch?: typeof fetch } = {},
): Promise<T> {
  const cdp = await connectBrowser(endpoint, options)
  try {
    return await run(cdp)
  } finally {
    cdp.close()
  }
}
