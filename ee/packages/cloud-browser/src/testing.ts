import assert from "node:assert/strict"
import { validateAction, validateHumanInput } from "./actions"
import type { CloudBrowser } from "./browser"
import { readBrowserVersion, withBrowser } from "./cdp"
import { CloudBrowserError, browserKeyId, type BrowserEndpoint, type BrowserHost, type BrowserKey } from "./contract"
import { rememberLogins, type BrowserStatus, type Observation } from "./page"
import { displayUrl, parseNavigableUrl } from "./url"

/** Smallest valid JPEG (1×1, white): a stand-in screenshot for tests. */
export const TINY_JPEG_BASE64 =
  "/9j/2wBDABALDA4MChAODQ4SERATGCgaGBYWGDEjJR0oOjM9PDkzODdASFxOQERXRTc4UG1RV19iZ2hnPk1xeXBkeFxlZ2P/2wBDARESEhgVGC8aGi9jQjhCY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2P/wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAf/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFAEBAAAAAAAAAAAAAAAAAAAAAP/EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAMAwEAAhEDEQA/AKAAD//Z"

export type FakeBrowserHost = BrowserHost & {
  readonly opened: BrowserKey[]
  readonly stopped: BrowserKey[]
  isRunning(key: BrowserKey): boolean
}

/** A host that starts nothing; `endpoint` decides what each key's browser answers on. */
export function createFakeBrowserHost(options: { endpoint?: (key: BrowserKey) => BrowserEndpoint; openError?: CloudBrowserError } = {}): FakeBrowserHost {
  const running = new Set<string>()
  const opened: BrowserKey[] = []
  const stopped: BrowserKey[] = []
  const endpoint = options.endpoint ?? (() => ({ cdpUrl: "http://127.0.0.1:9", headers: {}, expiresAt: null }))
  return {
    id: "fake",
    opened,
    stopped,
    isRunning: (key) => running.has(browserKeyId(key)),
    async open(key) {
      opened.push(key)
      if (options.openError) throw options.openError
      running.add(browserKeyId(key))
      return endpoint(key)
    },
    async peek(key) {
      return running.has(browserKeyId(key)) ? endpoint(key) : null
    },
    async stop(key) {
      stopped.push(key)
      running.delete(browserKeyId(key))
    },
  }
}

export type FakeCloudBrowserCall = { method: keyof CloudBrowser; key: BrowserKey; input?: unknown }

export type FakeCloudBrowser = CloudBrowser & {
  readonly calls: FakeCloudBrowserCall[]
  /** The next call to `method` throws `error`. */
  failNext(method: keyof CloudBrowser, error: CloudBrowserError): void
  /** Pretend the page asks for a password. */
  setSignInPage(key: BrowserKey, value: boolean): void
}

/** An in-memory `CloudBrowser` with the real input validation, for route and tool tests. */
export function createFakeCloudBrowser(): FakeCloudBrowser {
  const pages = new Map<string, { url: string; title: string; signIn: boolean }>()
  const failures = new Map<keyof CloudBrowser, CloudBrowserError>()
  const calls: FakeCloudBrowserCall[] = []
  let observations = 0

  function record(method: keyof CloudBrowser, key: BrowserKey, input?: unknown) {
    calls.push({ method, key, input })
    const failure = failures.get(method)
    if (failure) {
      failures.delete(method)
      throw failure
    }
  }

  function running(key: BrowserKey) {
    const page = pages.get(browserKeyId(key))
    if (!page) throw new CloudBrowserError("not_running", "The cloud browser is not running. Open a website first.")
    return page
  }

  function visit(key: BrowserKey, url: string) {
    const parsed = parseNavigableUrl(url)
    const page = { url: parsed.href, title: parsed.hostname, signIn: pages.get(browserKeyId(key))?.signIn ?? false }
    pages.set(browserKeyId(key), page)
    return { ok: true as const, tabId: "tab-1", url: displayUrl(page.url), title: page.title, loaded: true, next: "observe" as const }
  }

  return {
    hostId: "fake",
    calls,
    failNext: (method, error) => failures.set(method, error),
    setSignInPage(key, value) {
      const page = pages.get(browserKeyId(key))
      if (page) page.signIn = value
    },
    async open(key, input) {
      record("open", key, input)
      return visit(key, input.url)
    },
    async navigate(key, input) {
      record("navigate", key, input)
      return visit(key, input.url)
    },
    async observe(key, input = {}) {
      record("observe", key, input)
      const page = running(key)
      observations += 1
      const observation: Observation = {
        ok: true,
        tabId: "tab-1",
        observationId: `${Date.now().toString(36)}.${observations.toString(16).padStart(12, "0")}`,
        url: displayUrl(page.url),
        title: page.title,
        text: `Welcome to ${page.title}`,
        elements: page.signIn
          ? [
              { ref: "e1", role: "textbox", name: "Email", bounds: { x: 10, y: 10, width: 200, height: 30 }, sensitive: false },
              { ref: "e2", role: "textbox", name: "Password", bounds: { x: 10, y: 50, width: 200, height: 30 }, sensitive: true },
            ]
          : [{ ref: "e1", role: "link", name: "More information", bounds: { x: 10, y: 10, width: 120, height: 20 }, sensitive: false }],
        moreElements: false,
        viewport: { width: 1280, height: 713 },
        scroll: { x: 0, y: 0 },
        hasPasswordField: page.signIn,
        trust: "untrusted-site-content",
        next: page.signIn ? "handoff" : "act",
      }
      if (input.includeImage !== false) {
        if (page.signIn) observation.imageOmitted = "sign_in_page"
        else observation.image = { mimeType: "image/jpeg", data: TINY_JPEG_BASE64 }
      }
      return observation
    },
    async act(key, input) {
      record("act", key, input)
      running(key)
      const action = validateAction(input.action)
      const page = pages.get(browserKeyId(key))
      if (page?.signIn && action.type === "fill" && action.ref === "e2") {
        throw new CloudBrowserError("sign_in_required", "This needs the person: call browser_handoff so they can sign in or enter it themselves.")
      }
      return { ok: true, dispatched: true, outcome: "not_yet_verified", retrySafe: false, tabId: "tab-1", next: "observe", message: "Observe the page and verify the requested outcome before reporting success." }
    },
    async status(key): Promise<BrowserStatus> {
      record("status", key)
      const page = pages.get(browserKeyId(key))
      return page ? { running: true, url: displayUrl(page.url), title: page.title } : { running: false, url: null, title: null }
    },
    async screenshot(key, input) {
      record("screenshot", key, input)
      return pages.has(browserKeyId(key)) ? Buffer.from(TINY_JPEG_BASE64, "base64") : null
    },
    async input(key, events) {
      record("input", key, events)
      running(key)
      validateHumanInput(events)
    },
    async rememberLogins(key) {
      record("rememberLogins", key)
      running(key)
      return { remembered: 1 }
    },
  }
}

export type BrowserHostConformanceCase = { name: string; run: () => Promise<void> }

/**
 * Behaviour every `BrowserHost` must show against a real browser. Runner
 * agnostic: iterate with `test(name, run)`. The factory may return the same
 * host each time; keys are unique per case.
 */
export function browserHostConformanceCases(
  factory: () => Promise<BrowserHost> | BrowserHost,
  options: { keyPrefix?: string } = {},
): BrowserHostConformanceCase[] {
  const prefix = options.keyPrefix ?? `conformance-${Date.now().toString(36)}`
  const key = (name: string): BrowserKey => ({ organizationId: `${prefix}-org`, memberId: `${prefix}-${name}` })

  return [
    {
      name: "peek never starts a browser",
      async run() {
        const host = await factory()
        assert.equal(await host.peek(key("peek")), null)
        assert.equal(await host.peek(key("peek")), null)
      },
    },
    {
      name: "open is idempotent and the browser answers DevTools",
      async run() {
        const host = await factory()
        const first = await host.open(key("open"))
        const second = await host.open(key("open"))
        const [a, b] = await Promise.all([readBrowserVersion(first), readBrowserVersion(second)])
        assert.equal(a.webSocketDebuggerUrl, b.webSocketDebuggerUrl)
        assert.ok(await host.peek(key("open")))
        await host.stop?.(key("open"))
      },
    },
    {
      name: "members get separate browsers",
      async run() {
        const host = await factory()
        const [a, b] = await Promise.all([host.open(key("a")), host.open(key("b"))])
        const [versionA, versionB] = await Promise.all([readBrowserVersion(a), readBrowserVersion(b)])
        assert.notEqual(versionA.webSocketDebuggerUrl, versionB.webSocketDebuggerUrl)
        await Promise.all([host.stop?.(key("a")), host.stop?.(key("b"))])
      },
    },
    {
      name: "remembered sign-ins survive a restart",
      async run() {
        const host = await factory()
        if (!host.stop) return
        const member = key("remember")
        const cookie = { name: "conformance_session", value: "signed-in", url: "https://example.com/", path: "/", secure: true, httpOnly: true }
        const endpoint = await host.open(member)
        await withBrowser(endpoint, async (cdp) => {
          await cdp.send("Storage.setCookies", { cookies: [cookie] })
          const remembered = await rememberLogins({ endpoint, cdp, progress: { dispatched: false } })
          assert.ok(remembered.remembered >= 1)
        })
        await host.stop(member)
        assert.equal(await host.peek(member), null)
        const cookies = await withBrowser(await host.open(member), (cdp) => cdp.send("Storage.getCookies", {}))
        const names = (Array.isArray(cookies.cookies) ? cookies.cookies : [])
          .map((entry: unknown) => (typeof entry === "object" && entry !== null && "name" in entry ? entry.name : null))
        assert.ok(names.includes("conformance_session"), "the session cookie should be on disk after a restart")
        await host.stop(member)
      },
    },
  ]
}
