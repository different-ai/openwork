import { LIMITS } from "./actions"
import { CdpConnection, readBrowserVersion } from "./cdp"
import { CloudBrowserError, isCloudBrowserError, type BrowserEndpoint, type BrowserHost, type BrowserKey } from "./contract"
import {
  act,
  activeTabSocket,
  capture,
  dispatchInput,
  navigate,
  observe,
  openUrl,
  readStatus,
  rememberLogins,
  type ActReceipt,
  type BrowserSession,
  type BrowserStatus,
  type NavigationResult,
  type Observation,
  type ScreenshotOptions,
} from "./page"

/**
 * One member's cloud browser, addressed by key: a `BrowserHost` (where Chrome
 * runs) composed with the stateless page operations (what the agent and the
 * person do with it). This is the only surface Den needs.
 *
 * `open` and `navigate` start a stopped browser; every other call works only
 * on a running browser and never starts one.
 */
export interface CloudBrowser {
  readonly hostId: string
  open(key: BrowserKey, input: { url: string }): Promise<NavigationResult>
  navigate(key: BrowserKey, input: { tabId?: string; url: string }): Promise<NavigationResult>
  observe(key: BrowserKey, input?: { tabId?: string; includeImage?: boolean }): Promise<Observation>
  act(key: BrowserKey, input: { tabId?: string; observationId: string; action: unknown }): Promise<ActReceipt>
  status(key: BrowserKey): Promise<BrowserStatus>
  /** The active tab as an image, or `null` when the browser is not running. */
  screenshot(key: BrowserKey, input?: ScreenshotOptions): Promise<Buffer | null>
  /** The person's take-over input. */
  input(key: BrowserKey, events: unknown): Promise<void>
  rememberLogins(key: BrowserKey): Promise<{ remembered: number }>
}

export type CloudBrowserOptions = {
  /** Bound for one page operation (default 30 s, as on desktop). */
  operationMs?: number
  /** Bound for starting a stopped browser (default 80 s, so start plus page load fits a 120 s headless tool call). */
  startMs?: number
  fetch?: typeof fetch
}

const NOT_RUNNING = "The cloud browser is not running. Open a website first."
const SOCKET_URL_CACHE_SIZE = 256
/** A live view keeps its tab socket this long after the last frame. */
const LIVE_VIEW_IDLE_MS = 15_000
const LIVE_VIEW_CAPACITY = 256
const FRAME_TIMEOUT_MS = 8_000

type LiveView = { socketUrl: string; socket: Promise<CdpConnection>; idle: ReturnType<typeof setTimeout> | undefined }

function asCloudBrowserError(error: unknown): CloudBrowserError {
  if (isCloudBrowserError(error)) return error
  return new CloudBrowserError("browser_operation_failed", "The browser operation could not finish. Observe the page before deciding what remains.", { cause: error })
}

function deadline<T>(work: Promise<T>, timeoutMs: number, onTimeout: () => CloudBrowserError): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  work.catch(() => undefined)
  return Promise.race([
    work,
    new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(onTimeout()), timeoutMs)
    }),
  ]).finally(() => clearTimeout(timer))
}

export function createCloudBrowser(host: BrowserHost, options: CloudBrowserOptions = {}): CloudBrowser {
  const operationMs = options.operationMs ?? LIMITS.operationMs
  const startMs = options.startMs ?? 80_000
  // Chrome's browser socket URL is stable for its lifetime: skip `/json/version` on warm calls.
  const socketUrls = new Map<string, string>()
  // The live view polls about twice a second. Reusing the active tab's own
  // socket between frames saves a TLS handshake and upgrade per frame (about
  // five times faster through a remote proxy). Only screenshots use it.
  const liveViews = new Map<string, LiveView>()

  function closeLiveView(cdpUrl: string) {
    const view = liveViews.get(cdpUrl)
    if (!view) return
    liveViews.delete(cdpUrl)
    if (view.idle !== undefined) clearTimeout(view.idle)
    view.socket.then((socket) => socket.close(), () => undefined)
  }

  function liveSocket(endpoint: BrowserEndpoint, socketUrl: string): { socket: Promise<CdpConnection>; reused: boolean } {
    const current = liveViews.get(endpoint.cdpUrl)
    if (current && current.socketUrl !== socketUrl) closeLiveView(endpoint.cdpUrl)
    let view = liveViews.get(endpoint.cdpUrl)
    const reused = view !== undefined
    if (!view) {
      const opened: LiveView = { socketUrl, socket: CdpConnection.connect(socketUrl, { headers: endpoint.headers, timeoutMs: FRAME_TIMEOUT_MS }), idle: undefined }
      opened.socket.catch(() => {
        if (liveViews.get(endpoint.cdpUrl) === opened) liveViews.delete(endpoint.cdpUrl)
      })
      liveViews.set(endpoint.cdpUrl, opened)
      if (liveViews.size > LIVE_VIEW_CAPACITY) {
        const oldest = liveViews.keys().next().value
        if (oldest !== undefined) closeLiveView(oldest)
      }
      view = opened
    }
    if (view.idle !== undefined) clearTimeout(view.idle)
    view.idle = setTimeout(() => closeLiveView(endpoint.cdpUrl), LIVE_VIEW_IDLE_MS)
    view.idle.unref?.()
    return { socket: view.socket, reused }
  }

  async function liveFrame(endpoint: BrowserEndpoint, input: ScreenshotOptions): Promise<Buffer> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const tab = await activeTabSocket({ endpoint, fetch: options.fetch })
      if (!tab) throw new CloudBrowserError("tab_not_found", "No page is open.")
      const { socket, reused } = liveSocket(endpoint, tab.socketUrl)
      try {
        const connection = await socket
        if (connection.closed) throw new CloudBrowserError("browser_operation_failed", "The live view connection closed.")
        return await capture(connection, undefined, input, FRAME_TIMEOUT_MS)
      } catch (error) {
        closeLiveView(endpoint.cdpUrl)
        // A socket left over from an earlier frame may have gone stale; retry once on a new one.
        if (!reused) throw error
      }
    }
    throw new CloudBrowserError("browser_operation_failed", "The live view could not be captured.")
  }

  async function connect(endpoint: BrowserEndpoint, signal: AbortSignal): Promise<CdpConnection> {
    const cached = socketUrls.get(endpoint.cdpUrl)
    if (cached) {
      const reused = await CdpConnection.connect(cached, { headers: endpoint.headers, signal }).catch(() => null)
      if (reused) return reused
      socketUrls.delete(endpoint.cdpUrl)
    }
    const version = await readBrowserVersion(endpoint, { signal, fetch: options.fetch })
    socketUrls.set(endpoint.cdpUrl, version.webSocketDebuggerUrl)
    if (socketUrls.size > SOCKET_URL_CACHE_SIZE) {
      const oldest = socketUrls.keys().next().value
      if (oldest !== undefined) socketUrls.delete(oldest)
    }
    return CdpConnection.connect(version.webSocketDebuggerUrl, { headers: endpoint.headers, signal })
  }

  /** One operation on its own connection; the deadline closes it so nothing is sent late. */
  async function withSession<T>(endpoint: BrowserEndpoint, timeoutMs: number, run: (session: BrowserSession) => Promise<T>): Promise<T> {
    const controller = new AbortController()
    const progress = { dispatched: false }
    const state: { session: BrowserSession | null } = { session: null }
    const work = (async () => {
      const cdp = await connect(endpoint, controller.signal)
      state.session = { endpoint, cdp, fetch: options.fetch, progress }
      if (controller.signal.aborted) cdp.close()
      return run(state.session)
    })()
    try {
      return await deadline(work, timeoutMs, () => {
        controller.abort()
        state.session?.cdp.close()
        return new CloudBrowserError("timeout", "The browser did not finish in time. Observe the page before deciding what remains.", { dispatched: progress.dispatched })
      })
    } catch (error) {
      const failure = asCloudBrowserError(error)
      if (progress.dispatched && !failure.dispatched) {
        throw new CloudBrowserError(failure.code, failure.message, { dispatched: true, cause: failure })
      }
      throw failure
    } finally {
      state.session?.cdp.close()
    }
  }

  async function start(key: BrowserKey): Promise<BrowserEndpoint> {
    const controller = new AbortController()
    try {
      return await deadline(host.open(key, { signal: controller.signal }), startMs, () => {
        controller.abort()
        return new CloudBrowserError("timeout", "The cloud browser took too long to start. Try again in a minute.")
      })
    } catch (error) {
      if (isCloudBrowserError(error)) throw error
      throw new CloudBrowserError("browser_start_failed", "The cloud browser could not start. Try again in a minute.", { cause: error })
    }
  }

  async function running(key: BrowserKey): Promise<BrowserEndpoint | null> {
    try {
      return await host.peek(key)
    } catch (error) {
      if (isCloudBrowserError(error)) throw error
      throw new CloudBrowserError("browser_unavailable", "The cloud browser is unavailable right now.", { cause: error })
    }
  }

  async function requireRunning(key: BrowserKey): Promise<BrowserEndpoint> {
    const endpoint = await running(key)
    if (!endpoint) throw new CloudBrowserError("not_running", NOT_RUNNING)
    return endpoint
  }

  /** Reads that treat a browser that just went away as not running. */
  async function whileRunning<T>(key: BrowserKey, read: (endpoint: BrowserEndpoint) => Promise<T>, stopped: T): Promise<T> {
    const endpoint = await running(key)
    if (!endpoint) return stopped
    try {
      return await read(endpoint)
    } catch (error) {
      const failure = asCloudBrowserError(error)
      if (failure.code === "not_running" || failure.code === "tab_not_found") return stopped
      throw failure
    }
  }

  return {
    hostId: host.id,
    async open(key, input) {
      return withSession(await start(key), operationMs, (session) => openUrl(session, input))
    },
    async navigate(key, input) {
      return withSession(await start(key), operationMs, (session) => navigate(session, input))
    },
    async observe(key, input = {}) {
      return withSession(await requireRunning(key), operationMs, (session) => observe(session, input))
    },
    async act(key, input) {
      return withSession(await requireRunning(key), operationMs, (session) => act(session, input))
    },
    async status(key) {
      return whileRunning(key, (endpoint) => readStatus({ endpoint, fetch: options.fetch }), { running: false, url: null, title: null })
    },
    async screenshot(key, input = {}) {
      return whileRunning<Buffer | null>(key, (endpoint) => liveFrame(endpoint, input), null)
    },
    async input(key, events) {
      await withSession(await requireRunning(key), 10_000, (session) => dispatchInput(session, { events }))
    },
    async rememberLogins(key) {
      return withSession(await requireRunning(key), 10_000, (session) => rememberLogins(session))
    },
  }
}
