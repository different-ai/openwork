import { afterAll, describe, expect, jest, spyOn, test } from "bun:test"
import { GlobalRegistrator } from "@happy-dom/global-registrator"
import { act, createElement } from "react"
import { createRoot } from "react-dom/client"
import { AppBridge } from "@modelcontextprotocol/ext-apps/app-bridge"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js"
import type { DynamicToolUIPart } from "ai"

import {
  createOpenworkServerClient,
  normalizeMcpAppHostOrigin,
  OpenworkServerError,
  type OpenworkMcpAppResource,
  type OpenworkServerClient,
} from "../src/app/lib/openwork-server"
import { formatMcpAppDiagnostic, safeMcpAppDiagnosticMessage } from "../src/components/chat/mcp-app-diagnostics"
import type { McpAppSandboxViewProps } from "../src/components/chat/mcp-app-frame"
import type { ChatConnectionDecisionBinding } from "../src/react-app/domains/session/surface/mcp-chat-reconnect"
import * as mcpAppOrigin from "../src/components/chat/mcp-app-origin"

GlobalRegistrator.register({ url: "https://web.example/" })
afterAll(() => GlobalRegistrator.unregister())
const { MessageListProvider } = await import("../src/components/chat/message-list-provider")
const { WorkspaceProvider } = await import("../src/react-app/shell/workspace-provider")
const { useUiStateStore } = await import("../src/react-app/shell/ui-state-store")
const { usePanelTabStore } = await import("../src/react-app/domains/session/panel/panel-tab-store")
const { useSessionActivityStore } = await import("../src/react-app/domains/session/status/session-activity-store")
const { McpAppTile } = await import("../src/react-app/domains/dashboard/mcp-app-tile")
const { removeDashboardTileCache } = await import("../src/react-app/domains/dashboard/dashboard-tile-cache")
const { flushDashboardTileCacheStorage } = await import("../src/app/lib/dashboard-cache-storage")
const {
  buildMcpAppCsp,
  hasPreservedMcpAppResult,
  gatewayMcpAppLaunch,
  isActionableMcpAppResolutionError,
  McpAppFrame,
  McpAppSandboxView,
  secureMcpAppHtml,
} = await import("../src/components/chat/mcp-app-frame")

function fixture(overrides: Partial<OpenworkMcpAppResource> = {}): OpenworkMcpAppResource {
  return {
    launchId: "launch_fixture",
    serverName: "fixture",
    toolName: "render",
    resourceUri: "ui://fixture/view.html",
    html: "<!doctype html><html><head><title>Fixture</title></head><body>ok</body></html>",
    csp: {
      connectDomains: [],
      resourceDomains: [],
      frameDomains: [],
      baseUriDomains: [],
    },
    prefersBorder: true,
    ...overrides,
  }
}

function toolDelivery(revision: number): Pick<McpAppSandboxViewProps, "inputArguments" | "result"> {
  return {
    inputArguments: { query: `input-${revision}` },
    result: {
      content: [{ type: "text", text: `result-${revision}` }],
      structuredContent: { revision, rows: [{ value: revision }] },
      _meta: { revision, detail: "view-only" },
      isError: false,
    },
  }
}

async function startupFixture(options: Pick<McpAppSandboxViewProps, "presentation" | "initialHeight" | "updateMode"> = {}) {
  const previousAct = Reflect.get(globalThis, "IS_REACT_ACT_ENVIRONMENT")
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true)
  const container = document.body.appendChild(document.createElement("div"))
  const root = createRoot(container)
  const srcDescriptor = Object.getOwnPropertyDescriptor(HTMLIFrameElement.prototype, "src")
  if (!srcDescriptor?.set) throw new Error("Missing iframe src setter")
  const srcAssignments: Array<{ frame: HTMLIFrameElement; url: string }> = []
  Object.defineProperty(HTMLIFrameElement.prototype, "src", {
    ...srcDescriptor,
    set: function (this: HTMLIFrameElement, url: string) {
      srcAssignments.push({ frame: this, url })
      srcDescriptor.set?.call(this, url)
    },
  })
  const timers = new Map<number, { at: number; run: () => void }>()
  const deadlines: number[] = []
  let now = 0
  let timerId = 0
  const dateSpy = spyOn(Date, "now").mockImplementation(() => 1_000 + now)
  const heightChanges: Array<{ id: number; height: number }> = []
  const failures: number[] = []
  const timerSpy = spyOn(window, "setTimeout").mockImplementation((callback, delay = 0, ...args) => {
    if (typeof callback !== "function") throw new Error("Expected a timer callback")
    timers.set(++timerId, { at: now + delay, run: () => callback(...args) })
    if (delay === 10_000) deadlines.push(now + delay)
    return timerId
  })
  const clearSpy = spyOn(window, "clearTimeout").mockImplementation(id => { if (id !== undefined) timers.delete(id) })
  const bridges: AppBridge[] = []
  const connectSpy = spyOn(AppBridge.prototype, "connect").mockImplementation(async function () { bridges.push(this) })
  const resourceSpy = spyOn(AppBridge.prototype, "sendSandboxResourceReady").mockResolvedValue(undefined)
  const inputSpy = spyOn(AppBridge.prototype, "sendToolInput").mockResolvedValue(undefined)
  const resultSpy = spyOn(AppBridge.prototype, "sendToolResult").mockResolvedValue(undefined)
  const teardownSpy = spyOn(AppBridge.prototype, "teardownResource").mockResolvedValue({})
  const closeSpy = spyOn(AppBridge.prototype, "close").mockResolvedValue(undefined)
  const errorSpy = spyOn(console, "error").mockImplementation(() => {})
  const addListenerSpy = spyOn(window, "addEventListener")
  const removeListenerSpy = spyOn(window, "removeEventListener")
  const client: OpenworkServerClient = {
    ...createOpenworkServerClient({ baseUrl: "http://localhost:1" }),
    mcpAppSandbox: app => ({ url: `about:blank#${app.toolName}`, expectedOrigin: "https://sandbox.example", sandbox: "allow-scripts allow-same-origin" }),
  }
  const sandboxSpy = spyOn(client, "mcpAppSandbox")
  const views = Array.from({ length: 6 }, (_, index) => createElement(McpAppSandboxView, {
    key: index,
    origin: { client, workspaceId: `workspace-${index % 2}`, sessionId: null, readOnly: true },
    app: fixture({ toolName: `render-${index}` }), toolName: `render-${index}`,
    inputArguments: {}, result: { content: [] }, unavailableNotice: "Unavailable",
    ...options,
    onHeightChange: height => { heightChanges.push({ id: index, height }) },
    onError: () => { failures.push(index) },
  }))
  const render = async (ids: number[]) => { await act(async () => root.render(createElement("div", null, ids.map(id => views[id])))) }
  let viewProps = views[0].props
  const renderView = async (overrides: Partial<McpAppSandboxViewProps> = {}) => {
    viewProps = { ...viewProps, ...overrides }
    await act(async () => root.render(createElement(McpAppSandboxView, viewProps)))
  }
  const frame = (id: number) => {
    const iframe = container.querySelector<HTMLIFrameElement>(`iframe[title="render-${id} interactive view"]`)
    if (!iframe?.contentWindow) throw new Error(`Missing iframe ${id}`)
    return iframe
  }
  const notify = async (id: number, method: string, origin = "https://sandbox.example", params: Record<string, unknown> = {}) => {
    await act(async () => { window.dispatchEvent(new MessageEvent("message", { source: frame(id).contentWindow, origin, data: { method, params } })) })
  }
  const advance = async (ms: number) => {
    const target = now + ms
    for (;;) {
      const next = [...timers.entries()].filter(([, timer]) => timer.at <= target).sort((a, b) => a[1].at - b[1].at)[0]
      if (!next) break
      now = next[1].at
      timers.delete(next[0])
      await act(async () => next[1].run())
    }
    now = target
  }
  return {
    render, renderView, frame, notify, advance, bridges, deadlines, timers, container, client, heightChanges, failures, srcAssignments,
    renderElement: async (element: ReturnType<typeof createElement>) => { await act(async () => root.render(element)) },
    connectSpy, sandboxSpy, resourceSpy, inputSpy, resultSpy, teardownSpy, closeSpy, errorSpy,
    async dispose() {
      try {
        await act(async () => root.unmount())
        expect(timers.size).toBe(0)
        const added = addListenerSpy.mock.calls.filter(([name]) => name === "message").map(([, listener]) => listener)
        const removed = removeListenerSpy.mock.calls.filter(([name]) => name === "message").map(([, listener]) => listener)
        expect(removed).toEqual(expect.arrayContaining(added))
      } finally {
        for (const spy of [dateSpy, timerSpy, clearSpy, connectSpy, sandboxSpy, resourceSpy, inputSpy, resultSpy, teardownSpy, closeSpy, errorSpy, addListenerSpy, removeListenerSpy]) spy.mockRestore()
        Object.defineProperty(HTMLIFrameElement.prototype, "src", srcDescriptor)
        container.remove()
        Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", previousAct)
      }
    },
  }
}

describe("MCP App startup scheduling", () => {
  test("starts at most two Apps across workspaces and advances FIFO only after initialization", async () => {
    const host = await startupFixture()
    try {
      await host.render([0, 1, 2, 3, 4])
      expect([0, 1, 2, 3, 4].map(id => host.frame(id).getAttribute("src"))).toEqual(["about:blank#render-0", "about:blank#render-1", null, null, null])
      expect(host.deadlines).toEqual([10_000, 10_000])
      await host.notify(2, "ui/notifications/sandbox-proxy-ready")
      await host.notify(0, "ui/notifications/sandbox-proxy-ready", "https://wrong.example")
      expect(host.connectSpy).not.toHaveBeenCalled()
      await host.notify(0, "ui/notifications/sandbox-proxy-ready")
      await host.notify(1, "ui/notifications/sandbox-proxy-ready")
      expect(host.resourceSpy).toHaveBeenCalledTimes(2)
      expect(host.frame(2).getAttribute("src")).toBeNull()
      await act(async () => { host.bridges[1].oninitialized?.() })
      expect(host.frame(2).getAttribute("src")).toBe("about:blank#render-2")
      expect(host.frame(3).getAttribute("src")).toBeNull()
      await act(async () => { host.bridges[1].oninitialized?.() })
      expect(host.frame(3).getAttribute("src")).toBeNull()
      await act(async () => { host.bridges[0].oninitialized?.() })
      expect(host.frame(3).getAttribute("src")).toBe("about:blank#render-3")
      expect(host.frame(4).getAttribute("src")).toBeNull()
      expect(host.inputSpy).toHaveBeenCalledTimes(2)
      expect(host.resultSpy).toHaveBeenCalledTimes(2)
      await host.advance(10_000)
      expect(host.errorSpy.mock.calls.map(([, diagnostic]) => diagnostic.toolName)).toEqual(["render-2", "render-3"])
      expect(host.frame(0).getAttribute("src")).toBe("about:blank#render-0")
      expect(host.frame(1).getAttribute("src")).toBe("about:blank#render-1")
    } finally { await host.dispose() }
  })

  test("gives each navigation ten seconds, excludes queue time, and never retries a timed-out startup", async () => {
    const host = await startupFixture()
    try {
      await host.render([0, 1, 2, 3, 4])
      await host.advance(9_999)
      expect(host.errorSpy).not.toHaveBeenCalled()
      await host.advance(1)
      expect(host.errorSpy).toHaveBeenCalledTimes(2)
      expect(host.deadlines).toEqual([10_000, 10_000, 20_000, 20_000])
      expect(host.frame(2).getAttribute("src")).toBe("about:blank#render-2")
      expect(host.frame(4).getAttribute("src")).toBeNull()
      await host.advance(9_999)
      expect(host.errorSpy).toHaveBeenCalledTimes(2)
      await host.advance(1)
      expect(host.errorSpy).toHaveBeenCalledTimes(4)
      expect(host.deadlines).toEqual([10_000, 10_000, 20_000, 20_000, 30_000])
      await host.advance(9_999)
      expect(host.errorSpy).toHaveBeenCalledTimes(4)
      await host.advance(1)
      expect(host.errorSpy).toHaveBeenCalledTimes(5)
      for (const [, diagnostic] of host.errorSpy.mock.calls) {
        expect(diagnostic).toMatchObject({ code: "MCP_APP_SANDBOX_PROXY_TIMEOUT", message: expect.stringContaining("within 10 seconds") })
      }
      await host.advance(60_000)
      expect(host.deadlines).toHaveLength(5)
      expect(host.timers.size).toBe(0)
      expect(host.connectSpy).not.toHaveBeenCalled()
      expect(host.teardownSpy).not.toHaveBeenCalled()
      expect(host.closeSpy).toHaveBeenCalledTimes(5)
    } finally { await host.dispose() }
  })

  test("cancels queued unmounts and does not navigate siblings during a whole-view teardown", async () => {
    const host = await startupFixture()
    try {
      await host.render([0, 1, 2, 3, 4])
      await host.render([0, 1, 3, 4])
      expect(host.deadlines).toHaveLength(2)
      await host.render([1, 3, 4])
      expect(host.frame(3).getAttribute("src")).toBe("about:blank#render-3")
      expect(host.frame(4).getAttribute("src")).toBeNull()
      expect(host.deadlines).toHaveLength(3)
      await host.render([])
      expect(host.deadlines).toHaveLength(3)
      expect(host.timers.size).toBe(0)
      await host.render([0, 1, 2])
      expect(host.frame(0).getAttribute("src")).toBe("about:blank#render-0")
      expect(host.frame(1).getAttribute("src")).toBe("about:blank#render-1")
      expect(host.frame(2).getAttribute("src")).toBeNull()
    } finally { await host.dispose() }
  })

  test.each(["failure", "initialize-timeout", "teardown"])("releases a startup slot on %s and ignores late callbacks", async mode => {
    const host = await startupFixture()
    try {
      await host.render([0, 1, 2])
      await host.notify(0, "ui/notifications/sandbox-proxy-ready")
      await host.notify(1, "ui/notifications/sandbox-proxy-ready")
      await host.notify(0, "ui/notifications/sandbox-resource-accepted")
      await host.notify(1, "ui/notifications/sandbox-resource-accepted")
      if (mode === "failure") await host.notify(0, "ui/notifications/sandbox-diagnostic")
      else if (mode === "teardown") await act(async () => { await host.bridges[0].onrequestteardown?.({}) })
      else {
        await host.advance(10_000)
        expect(host.errorSpy).toHaveBeenCalledTimes(2)
        for (const [, diagnostic] of host.errorSpy.mock.calls) expect(diagnostic.code).toBe("MCP_APP_INITIALIZE_TIMEOUT")
      }
      expect(host.frame(2).getAttribute("src")).toBe("about:blank#render-2")
      const timerCount = host.timers.size
      await act(async () => { host.bridges[0].oninitialized?.() })
      expect(host.inputSpy).not.toHaveBeenCalled()
      expect(host.timers.size).toBe(timerCount)
      expect(host.resourceSpy).toHaveBeenCalledTimes(2)
      expect(host.failures).toEqual(mode === "teardown" ? [] : mode === "failure" ? [0] : [0, 1])
    } finally { await host.dispose() }
  })

  test.each(["connect", "delivery"])("unmount during pending %s cannot deliver or recreate startup timers", async mode => {
    const host = await startupFixture()
    let finish: (() => void) | undefined
    const pending = new Promise<void>(resolve => { finish = resolve })
    try {
      if (mode === "connect") host.connectSpy.mockImplementationOnce(() => pending)
      else host.resourceSpy.mockImplementationOnce(() => pending)
      await host.render([0, 1, 2])
      await host.notify(0, "ui/notifications/sandbox-proxy-ready")
      await host.render([1, 2])
      expect(host.frame(2).getAttribute("src")).toBe("about:blank#render-2")
      await act(async () => { finish?.() })
      expect(host.resourceSpy).toHaveBeenCalledTimes(mode === "connect" ? 0 : 1)
      expect(host.timers.size).toBe(2)
      await host.render([])
      await host.advance(60_000)
      expect(host.errorSpy).not.toHaveBeenCalled()
      expect(host.timers.size).toBe(0)
    } finally { finish?.(); await host.dispose() }
  })
})

describe("MCP App retry ownership", () => {
  test("standalone retry preserves the connection host adapter and retires the failed bridge", async () => {
    const host = await startupFixture()
    const connectionController = {
      observeBinding: () => {},
      callTool: jest.fn(async () => ({ content: [] })),
    }
    const context = {
      requestId: 1, signal: new AbortController().signal,
      sendNotification: async () => {}, sendRequest: async () => { throw new Error("Unexpected request") },
    }
    try {
      await host.renderView({
        origin: { client: host.client, workspaceId: "fixture", sessionId: "session", readOnly: false },
        connectionController,
      })
      await host.notify(0, "ui/notifications/sandbox-proxy-ready")
      const original = host.frame(0)
      await host.notify(0, "ui/notifications/sandbox-diagnostic")
      const retry = host.container.querySelector<HTMLButtonElement>("button")
      if (!retry) throw new Error("Missing Retry")
      await act(async () => retry.click())
      expect(host.frame(0)).not.toBe(original)
      await host.notify(0, "ui/notifications/sandbox-proxy-ready")
      expect(host.bridges).toHaveLength(2)
      await expect(host.bridges[1].oncalltool?.({
        name: "connection_action_intent", arguments: { action: "skip" }, _meta: { "openwork/userInteraction": true },
      }, context)).resolves.toEqual({ content: [] })
      expect(connectionController.callTool).toHaveBeenCalledWith(
        expect.anything(), expect.anything(), "connection_action_intent", { action: "skip" }, true,
      )
      expect(host.closeSpy).toHaveBeenCalled()
    } finally { await host.dispose() }
  })

  test.each([false, true])("standalone retry only restarts its iframe (readOnly: %j)", async readOnly => {
    const host = await startupFixture()
    const resolveSpy = spyOn(host.client, "resolveMcpApp")
    const callSpy = spyOn(host.client, "callMcpAppTool")
    const releaseSpy = spyOn(host.client, "releaseMcpApp")
    try {
      await host.renderView({ origin: { client: host.client, workspaceId: "fixture", sessionId: null, readOnly } })
      const original = host.frame(0)
      await host.notify(0, "ui/notifications/sandbox-diagnostic")
      expect(host.container.querySelector("iframe")).toBeNull()
      const retry = host.container.querySelector<HTMLButtonElement>("button")
      expect(retry?.textContent).toBe("Retry")
      expect(retry?.getAttribute("data-slot")).toBe("button")
      await act(async () => retry?.click())
      expect(host.frame(0)).not.toBe(original)
      expect(host.srcAssignments).toHaveLength(2)
      expect(resolveSpy).not.toHaveBeenCalled()
      expect(callSpy).not.toHaveBeenCalled()
      expect(releaseSpy).not.toHaveBeenCalled()
    } finally {
      await host.dispose()
      for (const spy of [resolveSpy, callSpy, releaseSpy]) spy.mockRestore()
    }
  })

  test("owner retry keeps the diagnostic mounted until the owner replaces the view", async () => {
    const host = await startupFixture()
    const retryOwner = jest.fn()
    try {
      await host.renderView({ onRetry: retryOwner })
      await host.notify(0, "ui/notifications/sandbox-diagnostic")
      const diagnostic = host.container.querySelector('[role="status"]')
      const retry = host.container.querySelector<HTMLButtonElement>("button")
      expect(retry?.textContent).toBe("Retry")
      await act(async () => retry?.click())
      await host.renderView()
      expect(retryOwner).toHaveBeenCalledTimes(1)
      expect(host.container.querySelector('[role="status"]')).toBe(diagnostic)
      expect(host.container.querySelector("iframe")).toBeNull()
      expect(host.srcAssignments).toHaveLength(1)
      expect(host.sandboxSpy).toHaveBeenCalledTimes(1)
    } finally { await host.dispose() }
  })

  test.each(["safe", "approval", "denied"])("dashboard child retry replaces the failed lease without restarting its healthy sibling (%s)", async policy => {
    const host = await startupFixture()
    const pending = Promise.withResolvers<{ app: OpenworkMcpAppResource }>()
    const resolutions = [0, 0]
    const released: string[] = []
    const calls: Array<Parameters<OpenworkServerClient["callMcpAppTool"]>[1]> = []
    const resolveSpy = spyOn(host.client, "resolveMcpApp").mockImplementation(async (_workspace, name) => {
      const index = name === "render-0" ? 0 : 1
      const attempt = ++resolutions[index]
      if (index === 0 && attempt === 2) return pending.promise
      return { app: fixture({ toolName: name, launchId: `${name}-${attempt}` }) }
    })
    const releaseSpy = spyOn(host.client, "releaseMcpApp").mockImplementation(async (_workspace, id) => {
      released.push(id)
      return { released: true }
    })
    const callSpy = spyOn(host.client, "callMcpAppTool").mockImplementation(async (_workspace, request) => {
      calls.push(request)
      if (request.launchId && released.includes(request.launchId)) throw new Error("Released lease reused")
      if (request.launchId === "render-0-2" && request.name === "render-0") {
        if (policy === "denied") throw new OpenworkServerError(403, "tool_denied", "Forbidden")
        if (policy === "approval" && !request.approved) throw new OpenworkServerError(422, "tool_requires_approval", "Approval required")
      }
      return { content: [] }
    })
    const disabled = jest.fn()
    const scope = `retry-ownership-${policy}`
    const tile = (id: number) => createElement(McpAppTile, {
      key: id,
      entry: { kind: "mcp", id: `retry-${id}`, title: `Retry ${id}`, serverName: "fixture", toolName: `render-${id}`,
        projectedToolName: `render-${id}`, resourceUri: fixture().resourceUri, autoLaunch: true },
      cacheScopeKey: scope, onAutoLaunchDisabled: disabled,
    })
    const shell = (id: number) => {
      const element = host.container.querySelector<HTMLElement>(`[data-dashboard-tile="retry-${id}"]`)
      if (!element) throw new Error(`Missing tile ${id}`)
      return element
    }
    try {
      await host.renderElement(createElement(WorkspaceProvider, {
        client: null, openworkServerClient: host.client, workspaceId: "fixture", selectedWorkspaceRoot: "/fixture",
      }, tile(0), tile(1)))
      await host.notify(0, "ui/notifications/sandbox-proxy-ready")
      await host.notify(1, "ui/notifications/sandbox-proxy-ready")
      await act(async () => { host.bridges[0].oninitialized?.(); host.bridges[1].oninitialized?.() })
      const healthyFrame = host.frame(1)
      const failedBridge = host.bridges[0]
      expect(shell(0).querySelector("header")).toBeNull()
      await host.notify(0, "ui/notifications/sandbox-diagnostic")
      expect(released).toEqual(["render-0-1"])
      expect(shell(0).querySelector("iframe")).toBeNull()
      expect(resolutions).toEqual([1, 1])
      expect(calls).toHaveLength(2)
      const retry = Array.from(shell(0).querySelectorAll("button")).find(button => button.textContent === "Retry")
      if (!retry) throw new Error("Missing child Retry")
      await act(async () => retry.click())
      expect(resolutions).toEqual([2, 1])
      expect(shell(0).querySelector("iframe")).toBeNull()
      expect(host.srcAssignments).toHaveLength(2)
      expect(host.frame(1)).toBe(healthyFrame)
      await act(async () => { failedBridge.oninitialized?.() })
      expect(shell(0).querySelector("[data-dashboard-loading]")).not.toBeNull()
      const actionContext = {
        requestId: 1, signal: new AbortController().signal,
        sendNotification: async () => {}, sendRequest: async () => { throw new Error("Unexpected request") },
      }
      await expect(failedBridge.oncalltool?.({ name: "read_detail" }, actionContext)).rejects.toThrow("closed or changed")
      expect(calls).toHaveLength(2)
      await act(async () => pending.resolve({ app: fixture({ toolName: "render-0", launchId: "render-0-2" }) }))
      const retried = calls.filter(call => call.launchId === "render-0-2")
      expect(retried.map(call => call.approved)).toEqual(policy === "approval" ? [undefined, true] : [undefined])
      expect(disabled).toHaveBeenCalledTimes(policy === "approval" ? 1 : 0)
      if (policy === "denied") {
        expect(shell(0).textContent).toContain("Forbidden")
        expect(shell(0).querySelector("iframe")).toBeNull()
        expect(released).toEqual(["render-0-1", "render-0-2"])
        expect(host.srcAssignments).toHaveLength(2)
      } else {
        await host.notify(0, "ui/notifications/sandbox-proxy-ready")
        await act(async () => { host.bridges[2].oninitialized?.() })
        expect(shell(0).querySelector("header")).toBeNull()
        expect(shell(0).querySelector("[data-dashboard-loading]")).toBeNull()
        expect(shell(0).getAttribute("aria-busy")).toBe("false")
        expect(host.srcAssignments).toHaveLength(3)
        expect(released).toEqual(["render-0-1"])
        await expect(host.bridges[2].oncalltool?.({ name: "read_detail" }, actionContext)).resolves.toEqual({ content: [] })
        expect(calls.at(-1)).toMatchObject({ launchId: "render-0-2", name: "read_detail" })
      }
      expect(host.frame(1)).toBe(healthyFrame)
      expect(shell(1).querySelector("header")).toBeNull()
      expect(resolutions).toEqual([2, 1])
      expect(calls.filter(call => call.launchId === "render-1-1")).toHaveLength(1)
      expect(released).not.toContain("render-1-1")
    } finally {
      for (const id of [0, 1]) removeDashboardTileCache(scope, `retry-${id}`)
      flushDashboardTileCacheStorage()
      try { await host.dispose() } finally {
        for (const spy of [resolveSpy, releaseSpy, callSpy]) spy.mockRestore()
      }
    }
    expect([...released].sort()).toEqual(["render-0-1", "render-0-2", "render-1-1"])
  })
})

describe("MCP App data continuity", () => {
  test("notify delivers complete changed results without replacing the bridge or document, and reports readiness once through the current callback", async () => {
    const connect = AppBridge.prototype.connect
    const sendToolInput = AppBridge.prototype.sendToolInput
    const sendToolResult = AppBridge.prototype.sendToolResult
    const [viewTransport, hostTransport] = InMemoryTransport.createLinkedPair()
    const messages: JSONRPCMessage[] = []
    viewTransport.onmessage = message => { messages.push(message) }
    const host = await startupFixture({ updateMode: "notify", presentation: "dashboard" })
    host.connectSpy.mockImplementation(function () { host.bridges.push(this); return connect.call(this, hostTransport) })
    host.inputSpy.mockImplementation(function (params) { return sendToolInput.call(this, params) })
    host.resultSpy.mockImplementation(function (params) { return sendToolResult.call(this, params) })
    const initial = toolDelivery(1)
    const updated = toolDelivery(2).result
    const staleReady = jest.fn()
    const ready = jest.fn()
    try {
      await viewTransport.start()
      await host.renderView({ ...initial, onReady: staleReady })
      const iframe = host.frame(0)
      await host.notify(0, "ui/notifications/sandbox-proxy-ready")
      await host.notify(0, "ui/notifications/sandbox-resource-loaded", "https://sandbox.example", {
        readyState: "complete", hasHtmlRoot: true, scriptCount: 1,
      })
      await act(async () => { host.bridges[0].onsizechange?.({ height: 320 }) })
      expect(staleReady).not.toHaveBeenCalled()
      expect(host.inputSpy).not.toHaveBeenCalled()
      await host.renderView({ onReady: ready })
      await act(async () => { await viewTransport.send({
        jsonrpc: "2.0", id: 1, method: "ui/initialize", params: {
          appInfo: { name: "fixture", version: "1" }, appCapabilities: {}, protocolVersion: "2026-01-26",
        },
      }) })
      expect(messages).toContainEqual(expect.objectContaining({ id: 1, result: expect.objectContaining({ hostCapabilities: {} }) }))
      expect(ready).not.toHaveBeenCalled()
      await act(async () => { await viewTransport.send({ jsonrpc: "2.0", method: "ui/notifications/initialized" }) })
      expect(staleReady).not.toHaveBeenCalled()
      expect(ready).toHaveBeenCalledTimes(1)
      const appDocument = iframe.contentDocument
      if (!appDocument) throw new Error("Missing App document")
      appDocument.body.textContent = "local selection"
      await host.renderView({ result: updated })
      expect(host.inputSpy.mock.calls).toEqual([
        [{ arguments: initial.inputArguments }], [{ arguments: initial.inputArguments }],
      ])
      expect(host.resultSpy.mock.calls).toEqual([[initial.result], [updated]])
      await host.renderView()
      await host.renderView({ inputArguments: structuredClone(initial.inputArguments), result: structuredClone(updated) })
      await act(async () => { host.bridges[0].oninitialized?.() })
      expect(host.resultSpy).toHaveBeenCalledTimes(2)
      expect(host.inputSpy).toHaveBeenCalledTimes(2)
      expect(messages.filter(message => "method" in message && message.method.startsWith("ui/notifications/tool-"))).toEqual([
        { jsonrpc: "2.0", method: "ui/notifications/tool-input", params: { arguments: initial.inputArguments } },
        { jsonrpc: "2.0", method: "ui/notifications/tool-result", params: initial.result },
        { jsonrpc: "2.0", method: "ui/notifications/tool-input", params: { arguments: initial.inputArguments } },
        { jsonrpc: "2.0", method: "ui/notifications/tool-result", params: updated },
      ])
      expect(messages.filter(message => "id" in message && message.id === 1)).toHaveLength(1)
      expect(ready).toHaveBeenCalledTimes(1)
      expect(host.frame(0)).toBe(iframe)
      expect(iframe.contentDocument).toBe(appDocument)
      expect(appDocument.body.textContent).toBe("local selection")
      expect(host.srcAssignments).toEqual([{ frame: iframe, url: "about:blank#render-0" }])
      expect(host.sandboxSpy).toHaveBeenCalledTimes(1)
      expect(host.connectSpy).toHaveBeenCalledTimes(1)
      expect(host.resourceSpy).toHaveBeenCalledTimes(1)
      expect(host.teardownSpy).not.toHaveBeenCalled()
      expect(host.closeSpy).not.toHaveBeenCalled()
      expect(host.errorSpy).not.toHaveBeenCalled()
    } finally {
      try { await host.dispose() } finally { await viewTransport.close() }
    }
  })

  test("notify uses the latest pre-initialization data and serializes complete input/result pairs while coalescing pending changes", async () => {
    const host = await startupFixture({ updateMode: "notify" })
    const finishInputs: Array<() => void> = []
    const finishResults: Array<() => void> = []
    const deliveries: unknown[] = []
    host.inputSpy.mockImplementation(params => {
      deliveries.push({ input: params })
      return new Promise(resolve => { finishInputs.push(resolve) })
    })
    host.resultSpy.mockImplementation(params => {
      deliveries.push({ result: params })
      return new Promise(resolve => { finishResults.push(resolve) })
    })
    const staleReady = jest.fn()
    const ready = jest.fn()
    const beforeInit = toolDelivery(3)
    const latest = toolDelivery(6)
    try {
      await host.renderView({ ...toolDelivery(1), onReady: staleReady })
      await host.renderView(toolDelivery(2))
      await host.notify(0, "ui/notifications/sandbox-proxy-ready")
      await host.renderView(beforeInit)
      expect(deliveries).toEqual([])
      await act(async () => { host.bridges[0].oninitialized?.() })
      expect(deliveries).toEqual([{ input: { arguments: beforeInit.inputArguments } }])
      await host.renderView(toolDelivery(4))
      await host.renderView({ ...toolDelivery(5), onReady: ready })
      expect(host.inputSpy).toHaveBeenCalledTimes(1)
      expect(host.resultSpy).not.toHaveBeenCalled()
      expect(ready).not.toHaveBeenCalled()
      await act(async () => { finishInputs[0]?.() })
      expect(deliveries).toEqual([
        { input: { arguments: beforeInit.inputArguments } }, { result: beforeInit.result },
      ])
      await host.renderView(latest)
      expect(host.inputSpy).toHaveBeenCalledTimes(1)
      await act(async () => { finishResults[0]?.() })
      expect(host.inputSpy).toHaveBeenLastCalledWith({ arguments: latest.inputArguments })
      expect(host.resultSpy).toHaveBeenCalledTimes(1)
      expect(ready).not.toHaveBeenCalled()
      await act(async () => { finishInputs[1]?.() })
      expect(host.resultSpy).toHaveBeenLastCalledWith(latest.result)
      expect(ready).not.toHaveBeenCalled()
      await act(async () => { finishResults[1]?.() })
      expect(deliveries).toEqual([
        { input: { arguments: beforeInit.inputArguments } }, { result: beforeInit.result },
        { input: { arguments: latest.inputArguments } }, { result: latest.result },
      ])
      expect(staleReady).not.toHaveBeenCalled()
      expect(ready).toHaveBeenCalledTimes(1)
      expect(host.srcAssignments).toHaveLength(1)
      expect(host.deadlines).toEqual([10_000])
      expect(host.connectSpy).toHaveBeenCalledTimes(1)
      expect(host.resourceSpy).toHaveBeenCalledTimes(1)
      expect(host.teardownSpy).not.toHaveBeenCalled()
    } finally {
      await host.dispose()
      finishInputs.forEach(finish => finish())
      finishResults.forEach(finish => finish())
    }
  })

  test("does not replay a pending delivery when intervening updates return to equivalent data", async () => {
    const host = await startupFixture({ updateMode: "notify" })
    const initial = toolDelivery(1)
    const ready = jest.fn()
    let finish: (() => void) | undefined
    host.resultSpy.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    try {
      await host.renderView({ ...initial, onReady: ready })
      await host.notify(0, "ui/notifications/sandbox-proxy-ready")
      await act(async () => { host.bridges[0].oninitialized?.() })
      await host.renderView(toolDelivery(2))
      await host.renderView(structuredClone(initial))
      expect(ready).not.toHaveBeenCalled()
      await act(async () => { finish?.() })
      expect(host.inputSpy.mock.calls).toEqual([[{ arguments: initial.inputArguments }]])
      expect(host.resultSpy.mock.calls).toEqual([[initial.result]])
      expect(ready).toHaveBeenCalledTimes(1)
      expect(host.srcAssignments).toHaveLength(1)
    } finally { await host.dispose(); finish?.() }
  })

  test.each(["input", "result"])("does not report readiness when initial %s delivery fails", async stage => {
    const host = await startupFixture({ updateMode: "notify" })
    const ready = jest.fn()
    const notification = stage === "input" ? host.inputSpy : host.resultSpy
    notification.mockRejectedValueOnce(new Error("Notification failed"))
    try {
      await host.renderView({ ...toolDelivery(1), onReady: ready })
      await host.notify(0, "ui/notifications/sandbox-proxy-ready")
      await act(async () => { host.bridges[0].oninitialized?.() })
      expect(ready).not.toHaveBeenCalled()
      expect(host.errorSpy.mock.calls[0]?.[1]).toMatchObject({
        code: "MCP_APP_TOOL_RESULT_DELIVERY_FAILED", stage: "tool-result-delivery",
      })
      expect(host.resultSpy).toHaveBeenCalledTimes(stage === "input" ? 0 : 1)
      await host.renderView(toolDelivery(2))
      await act(async () => { host.bridges[0].oninitialized?.() })
      expect(ready).not.toHaveBeenCalled()
      expect(host.inputSpy).toHaveBeenCalledTimes(1)
      expect(host.errorSpy).toHaveBeenCalledTimes(1)
      expect(host.teardownSpy).toHaveBeenCalledTimes(1)
      expect(host.closeSpy).toHaveBeenCalledTimes(1)
    } finally { await host.dispose() }
  })

  test.each(["input", "result"])("default replace reinitializes the document for a meaningful %s change", async change => {
    const host = await startupFixture()
    const initial = toolDelivery(1)
    const updated = toolDelivery(2)
    const ready = jest.fn()
    try {
      await host.renderView({ ...initial, onReady: ready })
      const iframe = host.frame(0)
      await host.notify(0, "ui/notifications/sandbox-proxy-ready")
      await act(async () => { host.bridges[0].oninitialized?.() })
      await host.renderView(change === "input" ? { inputArguments: updated.inputArguments } : { result: updated.result })
      expect(host.srcAssignments).toEqual([
        { frame: iframe, url: "about:blank#render-0" }, { frame: iframe, url: "about:blank#render-0" },
      ])
      expect(host.sandboxSpy).toHaveBeenCalledTimes(2)
      expect(host.teardownSpy).toHaveBeenCalledTimes(1)
      expect(host.closeSpy).toHaveBeenCalledTimes(1)
      expect(ready).toHaveBeenCalledTimes(1)
      await host.notify(0, "ui/notifications/sandbox-proxy-ready")
      await act(async () => { host.bridges[0].oninitialized?.(); host.bridges[1].oninitialized?.() })
      expect(host.connectSpy).toHaveBeenCalledTimes(2)
      expect(host.resourceSpy).toHaveBeenCalledTimes(2)
      expect(host.inputSpy).toHaveBeenCalledTimes(2)
      expect(host.resultSpy).toHaveBeenCalledTimes(2)
      expect(host.inputSpy).toHaveBeenLastCalledWith({ arguments: change === "input" ? updated.inputArguments : initial.inputArguments })
      expect(host.resultSpy).toHaveBeenLastCalledWith(change === "result" ? updated.result : initial.result)
      expect(ready).toHaveBeenCalledTimes(2)
    } finally { await host.dispose() }
  })

  test.each(["app", "resource", "origin", "session", "engine", "workspace", "client", "read-only", "presentation", "update-mode"])("notify retires actions and pending delivery when %s changes", async change => {
    const host = await startupFixture({ updateMode: "notify" })
    const createActions = mcpAppOrigin.createMcpAppActions
    const scopes: Array<ReturnType<typeof createActions>> = []
    const actionsSpy = spyOn(mcpAppOrigin, "createMcpAppActions").mockImplementation((origin, app) => {
      const actions = createActions(origin, app)
      scopes.push(actions)
      return actions
    })
    const calls: unknown[] = []
    let finishAction: (() => void) | undefined
    let finishInput: (() => void) | undefined
    host.inputSpy.mockImplementationOnce(() => new Promise(resolve => { finishInput = resolve }))
    const client: OpenworkServerClient = {
      ...host.client,
      callMcpAppTool: (...args) => {
        calls.push(args)
        return new Promise(resolve => { finishAction = () => resolve({ content: [] }) })
      },
    }
    const origin: McpAppSandboxViewProps["origin"] = { client, workspaceId: "workspace-0", sessionId: "session-0", engine: "v1", readOnly: false }
    const app = fixture({ toolName: "render-0" })
    const changes: Record<string, Partial<McpAppSandboxViewProps>> = {
      app: { app: { ...app, launchId: "launch_replacement" } },
      resource: { app: { ...app, resourceUri: "ui://fixture/replacement.html", html: "<p>Replacement</p>" } },
      origin: { origin: { ...origin } },
      session: { origin: { ...origin, sessionId: "session-1" } },
      engine: { origin: { ...origin, engine: "v2" } },
      workspace: { origin: { ...origin, workspaceId: "workspace-1" } },
      client: { origin: { ...origin, client: { ...client } } },
      "read-only": { origin: { ...origin, readOnly: true } },
      presentation: { presentation: "dashboard" },
      "update-mode": { updateMode: "replace" },
    }
    const ready = jest.fn()
    try {
      await host.renderView({ origin, app, ...toolDelivery(1), onReady: ready })
      await host.notify(0, "ui/notifications/sandbox-proxy-ready")
      await act(async () => { host.bridges[0].oninitialized?.() })
      const pendingAction = scopes[0].callTool("read_detail", { value: "old scope" }, true).catch((cause: unknown) => cause)
      expect(calls).toEqual([["workspace-0", {
        launchId: "launch_fixture", sessionId: "session-0", engine: "v1", serverName: "fixture",
        resourceUri: app.resourceUri, name: "read_detail", arguments: { value: "old scope" }, approved: true,
      }]])
      await host.renderView({ ...toolDelivery(2), ...changes[change] })
      expect(scopes).toHaveLength(2)
      expect(() => scopes[0].assertActive()).toThrow("closed or changed")
      await expect(scopes[0].callTool("read_detail")).rejects.toThrow("closed or changed")
      finishAction?.()
      expect(await pendingAction).toMatchObject({ message: expect.stringContaining("closed or changed") })
      await act(async () => { finishInput?.(); host.bridges[0].oninitialized?.() })
      expect(host.resultSpy).not.toHaveBeenCalled()
      expect(ready).not.toHaveBeenCalled()
      expect(host.teardownSpy).toHaveBeenCalledTimes(1)
      expect(host.closeSpy).toHaveBeenCalledTimes(1)
      expect(host.srcAssignments).toHaveLength(2)
      expect(calls).toHaveLength(1)
      await host.notify(0, "ui/notifications/sandbox-proxy-ready")
      await act(async () => { host.bridges[1].oninitialized?.() })
      expect(host.resultSpy.mock.calls).toEqual([[toolDelivery(2).result]])
      expect(ready).toHaveBeenCalledTimes(1)
      expect(host.connectSpy).toHaveBeenCalledTimes(2)
      expect(host.resourceSpy).toHaveBeenCalledTimes(2)
    } finally {
      try { await host.dispose() } finally {
        actionsSpy.mockRestore()
        finishInput?.()
        finishAction?.()
      }
    }
  })

  test.each(["unmount", "teardown", "replacement"])("ignores a completed old result after %s and never reports stale readiness", async change => {
    const host = await startupFixture({ updateMode: "notify" })
    let finish: (() => void) | undefined
    host.resultSpy.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    const ready = jest.fn()
    try {
      await host.renderView({ ...toolDelivery(1), onReady: ready })
      await host.notify(0, "ui/notifications/sandbox-proxy-ready")
      await act(async () => { host.bridges[0].oninitialized?.() })
      await host.renderView(toolDelivery(2))
      if (change === "unmount") await host.render([])
      else if (change === "teardown") await act(async () => { await host.bridges[0].onrequestteardown?.({}) })
      else await host.renderView({ app: fixture({ toolName: "render-0", launchId: "launch_new" }) })
      await act(async () => { finish?.() })
      expect(ready).not.toHaveBeenCalled()
      expect(host.inputSpy).toHaveBeenCalledTimes(1)
      expect(host.resultSpy).toHaveBeenCalledTimes(1)
      expect(host.teardownSpy).toHaveBeenCalledTimes(1)
      expect(host.closeSpy).toHaveBeenCalledTimes(1)
      expect(host.errorSpy).not.toHaveBeenCalled()
    } finally { await host.dispose(); finish?.() }
  })
})

describe("MCP App sandbox presentation", () => {
  test.each([undefined, "dashboard"] satisfies Array<McpAppSandboxViewProps["presentation"]>)("normalizes malformed and out-of-bounds initial heights for %s without reporting an unmeasured height", async presentation => {
    const minimum = 1
    const cases: Array<[unknown, number]> = [
      [undefined, 320], [null, 320], [NaN, 320], [Infinity, 320], [-Infinity, 320],
      ["240", 320], [true, 320], [{ height: 240 }, 320],
      [-40, minimum], [0, minimum], [0.25, minimum], [72.25, Math.max(minimum, 73)],
      [216.25, 217], [799.25, 800], [1_200, 800],
    ]
    for (const [initialHeight, expected] of cases) {
      const options: Pick<McpAppSandboxViewProps, "presentation" | "initialHeight"> = { presentation }
      Reflect.set(options, "initialHeight", initialHeight)
      const host = await startupFixture(options)
      try {
        await host.render([0])
        expect(host.frame(0).style.height).toBe(`${expected}px`)
        expect(host.heightChanges).toEqual([])
      } finally { await host.dispose() }
    }
  })

  test("preserves a short measured height across presentation changes without inventing a measurement", async () => {
    const host = await startupFixture({ presentation: "dashboard", initialHeight: 73, updateMode: "notify" })
    try {
      await host.renderView()
      await host.notify(0, "ui/notifications/sandbox-proxy-ready")
      await act(async () => { host.bridges[0].oninitialized?.(); host.bridges[0].onsizechange?.({ height: 73 }) })
      expect(host.frame(0).style.height).toBe("73px")
      expect(host.heightChanges).toEqual([{ id: 0, height: 73 }])
      await host.renderView({ presentation: "inline" })
      expect(host.frame(0).style.height).toBe("73px")
      expect(host.heightChanges).toEqual([{ id: 0, height: 73 }])
      expect(host.srcAssignments).toHaveLength(2)
      await host.notify(0, "ui/notifications/sandbox-proxy-ready")
      await act(async () => { host.bridges[1].oninitialized?.(); host.bridges[1].onsizechange?.({ height: 73 }) })
      expect(host.heightChanges).toEqual([{ id: 0, height: 73 }])
    } finally { await host.dispose() }
  })

  test("fits an inline App to its content as details expand and collapse", async () => {
    const host = await startupFixture({ initialHeight: 320 })
    try {
      await host.render([0])
      await host.notify(0, "ui/notifications/sandbox-proxy-ready")
      const bridge = host.bridges[0]
      await act(async () => { bridge.oninitialized?.(); bridge.onsizechange?.({ height: 104 }) })
      expect(host.frame(0).style.height).toBe("104px")
      for (const height of [220, 104, 72]) {
        await host.advance(100)
        await act(async () => { bridge.onsizechange?.({ height }) })
        expect(host.frame(0).style.height).toBe(`${height}px`)
      }
      expect(host.heightChanges.map(change => change.height)).toEqual([104, 220, 104, 72])
      expect(host.connectSpy).toHaveBeenCalledTimes(1)
    } finally { await host.dispose() }
  })

  test("reports the first useful measurement but suppresses normalized no-ops, including pending updates back to the current height", async () => {
    const host = await startupFixture({ initialHeight: 320 })
    const nextHeight = jest.fn()
    try {
      await host.renderView()
      const iframe = host.frame(0)
      await host.notify(0, "ui/notifications/sandbox-proxy-ready")
      const bridge = host.bridges[0]
      await act(async () => { bridge.oninitialized?.(); bridge.onsizechange?.({ height: 319.1 }) })
      expect(host.heightChanges).toEqual([{ id: 0, height: 320 }])
      await host.advance(50)
      await act(async () => { bridge.onsizechange?.({ height: 500 }) })
      await host.advance(25)
      await act(async () => { bridge.onsizechange?.({ height: 319.8 }) })
      await host.advance(75)
      expect(iframe.style.height).toBe("320px")
      expect(host.heightChanges).toEqual([{ id: 0, height: 320 }])
      await host.renderView({ onHeightChange: nextHeight })
      await host.advance(100)
      await act(async () => { bridge.onsizechange?.({ height: 320 }) })
      expect(nextHeight).not.toHaveBeenCalled()
      await host.advance(100)
      await act(async () => { bridge.onsizechange?.({ height: 410.1 }); bridge.onsizechange?.({ height: 410.9 }) })
      await host.advance(100)
      expect(iframe.style.height).toBe("411px")
      expect(nextHeight.mock.calls).toEqual([[411]])
      expect(host.heightChanges).toEqual([{ id: 0, height: 320 }])
      expect(host.srcAssignments).toHaveLength(1)
      expect(host.connectSpy).toHaveBeenCalledTimes(1)
    } finally { await host.dispose() }
  })

  test("holds the remembered height until the app initializes, then honors the guest's real measurement", async () => {
    // A restored dashboard tile knows it was 717px last time. The guest's
    // startup shell measures ~238px before it renders the result; applying
    // that would collapse the tile and grow it back a moment later.
    const host = await startupFixture({ presentation: "dashboard", initialHeight: 717 })
    try {
      await host.renderView()
      const iframe = host.frame(0)
      expect(iframe.style.height).toBe("717px")
      await host.notify(0, "ui/notifications/sandbox-proxy-ready")
      const bridge = host.bridges[0]
      // Shrink before initialization/result delivery: ignored.
      await act(async () => { bridge.onsizechange?.({ height: 238 }) })
      await host.advance(150)
      expect(iframe.style.height).toBe("717px")
      expect(host.heightChanges).toEqual([])
      // Growth before delivery is still honored (content can be taller than remembered).
      await act(async () => { bridge.onsizechange?.({ height: 760 }) })
      await host.advance(150)
      expect(iframe.style.height).toBe("760px")
      // Once the app has initialized its measurements are real, including a shrink.
      await act(async () => { bridge.oninitialized?.() })
      await host.advance(150)
      await act(async () => { bridge.onsizechange?.({ height: 711 }) })
      await host.advance(150)
      expect(iframe.style.height).toBe("711px")
      expect(host.heightChanges.map(change => change.height)).toEqual([760, 711])
      expect(host.srcAssignments).toHaveLength(1)
    } finally { await host.dispose() }
  })

  test("a newer leading height cancels the older trailing update without losing the next trailing measurement", async () => {
    const host = await startupFixture()
    try {
      await host.render([0])
      const iframe = host.frame(0)
      await host.notify(0, "ui/notifications/sandbox-proxy-ready")
      const bridge = host.bridges[0]
      await act(async () => { bridge.oninitialized?.(); bridge.onsizechange?.({ height: 200 }) })
      await host.advance(50)
      await act(async () => { bridge.onsizechange?.({ height: 450 }) })
      await host.advance(50)
      await act(async () => { bridge.onsizechange?.({ height: 600 }) })
      expect(iframe.style.height).toBe("600px")
      await host.advance(25)
      await act(async () => { bridge.onsizechange?.({ height: 700 }) })
      await host.advance(25)
      expect(iframe.style.height).toBe("600px")
      expect(host.heightChanges).toEqual([{ id: 0, height: 200 }, { id: 0, height: 600 }])
      await host.advance(75)
      expect(iframe.style.height).toBe("700px")
      expect(host.heightChanges).toEqual([{ id: 0, height: 200 }, { id: 0, height: 600 }, { id: 0, height: 700 }])
      expect(host.timers.size).toBe(0)
    } finally { await host.dispose() }
  })

  test.each([undefined, "dashboard"] satisfies Array<McpAppSandboxViewProps["presentation"]>)("keeps %s chrome, short-height bounds, maximum height and trailing size notifications", async presentation => {
    const host = await startupFixture({ presentation, initialHeight: 217 });
    try {
      await host.render([0]);
      const iframe = host.frame(0);
      const wrapper = iframe.parentElement;
      if (!wrapper) throw new Error("Missing sandbox wrapper");
      expect(iframe.style.height).toBe("217px");
      expect(host.heightChanges).toEqual([]);
      expect(wrapper.classList.contains("overflow-hidden")).toBe(true);
      for (const token of ["mt-3", "rounded-xl", "bg-background", "border", "border-border"]) {
        expect(wrapper.classList.contains(token)).toBe(presentation !== "dashboard");
      }
      await host.notify(0, "ui/notifications/sandbox-proxy-ready");
      const bridge = host.bridges[0];
      await act(async () => { bridge.oninitialized?.(); });
      const shortHeight = 73;
      await act(async () => { bridge.onsizechange?.({ height: 72.25 }); });
      expect(iframe.style.height).toBe(`${shortHeight}px`);
      expect(host.heightChanges).toEqual([{ id: 0, height: shortHeight }]);
      await act(async () => {
        bridge.onsizechange?.({ height: 410.1 });
        bridge.onsizechange?.({ height: 450.25 });
      });
      await host.advance(99);
      expect(iframe.style.height).toBe(`${shortHeight}px`);
      expect(host.heightChanges).toHaveLength(1);
      await host.advance(1);
      expect(iframe.style.height).toBe("451px");
      expect(host.heightChanges).toEqual([{ id: 0, height: shortHeight }, { id: 0, height: 451 }]);
      const minimum = 1;
      const sizes = [[0.25, minimum], [799.25, 800], [1_200, 800]];
      for (const [height, expected] of sizes) {
        await host.advance(100);
        await act(async () => { bridge.onsizechange?.({ height }); });
        expect(iframe.style.height).toBe(`${expected}px`);
        expect(host.heightChanges.at(-1)).toEqual({ id: 0, height: expected });
      }
      expect(host.heightChanges).toEqual([
        { id: 0, height: shortHeight }, { id: 0, height: 451 },
        { id: 0, height: minimum }, { id: 0, height: 800 },
      ]);
      for (const height of [undefined, NaN, Infinity, -Infinity, 0, -20]) {
        await act(async () => { bridge.onsizechange?.({ height }); });
      }
      await host.advance(100);
      expect(iframe.style.height).toBe("800px");
      expect(host.heightChanges).toHaveLength(4);
      await host.render([0]);
      expect(host.frame(0)).toBe(iframe);
      expect(iframe.style.height).toBe("800px");
      expect(host.connectSpy).toHaveBeenCalledTimes(1);
      expect(host.failures).toEqual([]);
      expect(host.errorSpy).not.toHaveBeenCalled();
    } finally { await host.dispose(); }
  });

  test.each([undefined, "dashboard"] satisfies Array<McpAppSandboxViewProps["presentation"]>)("notifies %s diagnostic failure once without restarting or applying late size callbacks", async presentation => {
    const host = await startupFixture({ presentation });
    try {
      await host.render([0]);
      const iframe = host.frame(0);
      const source = iframe.contentWindow;
      expect(iframe.style.height).toBe("320px");
      await host.notify(0, "ui/notifications/sandbox-proxy-ready");
      const bridge = host.bridges[0];
      await act(async () => { bridge.oninitialized?.(); bridge.onsizechange?.({ height: 200 }); });
      await act(async () => { bridge.onsizechange?.({ height: 450 }); });
      await host.notify(0, "ui/notifications/sandbox-diagnostic", "https://wrong.example");
      expect(host.failures).toEqual([]);
      await host.notify(0, "ui/notifications/sandbox-diagnostic", "https://sandbox.example", {
        code: "MCP_APP_DOCUMENT_RUNTIME_ERROR", message: "View failed: Bearer fixture-secret",
      });
      const notice = host.container.querySelector('[role="status"]');
      expect(notice?.textContent).toContain("Unavailable");
      expect(notice?.textContent).toContain("MCP_APP_DOCUMENT_RUNTIME_ERROR");
      expect(notice?.textContent).not.toContain("fixture-secret");
      expect(host.container.querySelector("iframe")).toBeNull();
      expect(host.failures).toEqual([0]);
      expect(host.errorSpy).toHaveBeenCalledTimes(1);
      expect(host.errorSpy.mock.calls[0]?.[1]).toMatchObject({
        code: "MCP_APP_DOCUMENT_RUNTIME_ERROR", stage: "app-initialization", toolName: "render-0",
      });
      await act(async () => {
        window.dispatchEvent(new MessageEvent("message", { source, origin: "https://sandbox.example", data: { method: "ui/notifications/sandbox-diagnostic" } }));
        bridge.oninitialized?.();
        bridge.onsizechange?.({ height: 700 });
      });
      await host.render([0]);
      await host.advance(60_000);
      expect(host.failures).toEqual([0]);
      expect(host.heightChanges).toEqual([{ id: 0, height: 200 }]);
      expect(host.errorSpy).toHaveBeenCalledTimes(1);
      expect(host.connectSpy).toHaveBeenCalledTimes(1);
      expect(host.resourceSpy).toHaveBeenCalledTimes(1);
      expect(host.inputSpy).toHaveBeenCalledTimes(1);
      expect(host.resultSpy).toHaveBeenCalledTimes(1);
      expect(host.deadlines).toEqual([10_000]);
      expect(host.timers.size).toBe(0);
    } finally { await host.dispose(); }
  });
});

describe("MCP App resolution", () => {
  test.each(["success", "timeout"])("allows slow discovery for sixty seconds while config keeps ten seconds (%s)", async outcome => {
    jest.useFakeTimers()
    const requests: Array<{ signal: AbortSignal; resolve: (response: Response) => void }> = []
    const fetchSpy = spyOn(globalThis, "fetch").mockImplementation((_input, init) => new Promise<Response>((resolve, reject) => {
      const signal = init?.signal
      if (!signal) throw new Error("Missing request AbortSignal")
      requests.push({ signal, resolve })
      signal.addEventListener("abort", () => reject(signal.reason), { once: true })
    }))
    try {
      const client = createOpenworkServerClient({ baseUrl: "https://server.example" })
      let settled = false
      const resolution = client.resolveMcpApp("fixture", "fixture_render")
        .then(value => { settled = true; return value }, (cause: unknown) => { settled = true; return cause })
      const config = client.getConnectState().catch((cause: unknown) => cause)
      expect(requests).toHaveLength(2)
      jest.advanceTimersByTime(10_000)
      expect(await config).toMatchObject({ message: "Request timed out." })
      expect(requests[1].signal.aborted).toBe(true)
      expect(requests[0].signal.aborted).toBe(false)
      expect(settled).toBe(false)
      jest.advanceTimersByTime(49_999)
      await Promise.resolve()
      expect(requests[0].signal.aborted).toBe(false)
      expect(settled).toBe(false)
      if (outcome === "success") {
        requests[0].resolve(Response.json({ app: fixture() }))
        expect(await resolution).toEqual({ app: fixture() })
        jest.advanceTimersByTime(60_000)
        expect(requests[0].signal.aborted).toBe(false)
      } else {
        jest.advanceTimersByTime(1)
        expect(await resolution).toMatchObject({ message: "Request timed out." })
        expect(requests[0].signal.aborted).toBe(true)
      }
      expect(fetchSpy).toHaveBeenCalledTimes(2)
    } finally {
      fetchSpy.mockRestore()
      jest.useRealTimers()
    }
  })

  function resolutionFixture(explicit: boolean) {
    const previousAct = Reflect.get(globalThis, "IS_REACT_ACT_ENVIRONMENT")
    Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true)
    const container = document.body.appendChild(document.createElement("div"))
    const root = createRoot(container)
    const client = createOpenworkServerClient({ baseUrl: "https://server.example" })
    const resolveSpy = spyOn(client, "resolveMcpApp").mockResolvedValue({ app: null })
    const callSpy = spyOn(client, "callMcpAppTool").mockResolvedValue({ content: [] })
    const releaseSpy = spyOn(client, "releaseMcpApp").mockResolvedValue({ released: true })
    const sandboxSpy = spyOn(client, "mcpAppSandbox").mockReturnValue({ url: "about:blank", expectedOrigin: "https://sandbox.example", sandbox: "allow-scripts allow-same-origin" })
    const errorSpy = spyOn(console, "error").mockImplementation(() => {})
    const providerRetry = jest.fn()
    const part: DynamicToolUIPart = {
      type: "dynamic-tool", toolName: "fixture_render", toolCallId: "launch", state: "output-available",
      input: {}, output: "Provider fallback", callProviderMetadata: { openwork: { mcpResult: {
        content: [{ type: "text", text: "Provider fallback" }],
        ...(explicit ? { _meta: { "openwork/mcpApp": {
          connectionId: "emc_fixture", toolName: "render", resourceUri: "ui://fixture/view.html", arguments: {},
        } } } : {}),
      } } },
    }
    const render = async (nextPart = part) => { await act(async () => root.render(createElement(MessageListProvider, {
      client, workspaceId: "fixture", sessionId: "session_fixture", mcpAppEngine: "v2",
      showThinking: false, developerMode: false, displaySuggestions: false, providerConnectedCount: 0,
      dispatchAction: () => {}, setPrompt: () => {}, onRevertToUserMessage: () => {},
      onForkAtMessage: () => {}, onEditUserMessage: () => {},
      onMcpReconnect: async () => { throw new Error("Unexpected reconnect") },
      onMcpReopenAuthorization: async () => {}, onMcpRetry: providerRetry,
      children: createElement(McpAppFrame, { part: nextPart }),
    }))) }
    return {
      part, container, resolveSpy, callSpy, releaseSpy, errorSpy, providerRetry, render,
      async unmountFrame() { await act(async () => root.render(null)) },
      async dispose() {
        try { await act(async () => root.unmount()) } finally {
          for (const spy of [resolveSpy, callSpy, releaseSpy, sandboxSpy, errorSpy]) spy.mockRestore()
          container.remove()
          Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", previousAct)
        }
      },
    }
  }

  test("connection status without launch metadata stays ordinary text without a native card", async () => {
    const part: DynamicToolUIPart = {
      type: "dynamic-tool", toolName: "openwork-cloud_execute_capability", toolCallId: "status-probe",
      state: "output-available", input: { name: "mcp:emc_notes:*" },
      output: { schemaVersion: "1", connectionId: "emc_notes", connectionName: "Notes", state: "needs_connection",
        actor: "member", message: "Connect Notes to continue.",
        action: { type: "connect", label: "Connect Notes", surface: "openwork_your_connections" } },
    }
    expect(hasPreservedMcpAppResult(part)).toBe(false)
    const host = resolutionFixture(false)
    try {
      await host.render(part)
      expect(host.container.querySelector("iframe")).toBeNull()
      expect(host.container.querySelector("button")).toBeNull()
      expect(host.container.textContent).toBe("")
      expect(host.resolveSpy).not.toHaveBeenCalled()
    } finally { await host.dispose() }
  })

  test.each(["mcp_auth_required", "mcp_access_denied"])("%s stays actionable without automatic retry or native connection fallback", async code => {
    const host = resolutionFixture(false)
    const timerSpy = spyOn(window, "setTimeout")
    host.resolveSpy.mockRejectedValue(new OpenworkServerError(403, code, "Connection requires attention"))
    try {
      await host.render()
      await host.render()
      expect(host.resolveSpy).toHaveBeenCalledTimes(1)
      expect(timerSpy.mock.calls.filter(([, delay]) => delay === 1_000 || delay === 3_000)).toHaveLength(0)
      expect(host.container.textContent).toContain("MCP_APP_RESOURCE_RESOLUTION_FAILED")
      expect(host.container.textContent).toContain(code)
      expect(host.container.querySelector("iframe")).toBeNull()
      const retry = Array.from(host.container.querySelectorAll("button")).find(button => button.textContent === "Retry")
      if (!retry) throw new Error("Missing resolution Retry")
      await act(async () => retry.click())
      expect(host.resolveSpy).toHaveBeenCalledTimes(2)
      expect(host.callSpy).not.toHaveBeenCalled()
      expect(host.providerRetry).not.toHaveBeenCalled()
    } finally {
      await host.dispose()
      timerSpy.mockRestore()
    }
  })

  test.each([
    new Error("Request timed out."),
    new OpenworkServerError(500, "unexpected_failure", "Discovery failed: Bearer fixture-secret"),
  ])("shows explicit launch failures with sanitized diagnostics and discovery-only Retry (%s)", async cause => {
    const host = resolutionFixture(true)
    host.resolveSpy.mockRejectedValueOnce(cause).mockResolvedValue({ app: fixture() })
    try {
      await host.render()
      const status = host.container.querySelector('[role="status"]')
      expect(status?.textContent).toContain("Interactive view unavailable. The normal tool result is still available.")
      expect(status?.textContent).toContain(safeMcpAppDiagnosticMessage(cause, "fallback"))
      expect(status?.textContent).toContain("MCP_APP_RESOURCE_RESOLUTION_FAILED")
      expect(status?.textContent).toContain("Stage: resource-resolution")
      expect(status?.textContent).not.toContain("fixture-secret")
      expect(JSON.stringify(host.errorSpy.mock.calls)).not.toContain("fixture-secret")
      if (cause instanceof OpenworkServerError) expect(status?.textContent).toContain(`Cause code: ${cause.code}`)
      expect(host.resolveSpy).toHaveBeenCalledTimes(1)
      expect(host.container.querySelector("iframe")).toBeNull()
      const retry = Array.from(host.container.querySelectorAll("button")).find(button => button.textContent === "Retry")
      if (!retry) throw new Error("Missing resolution Retry")
      await act(async () => retry.click())
      expect(host.resolveSpy).toHaveBeenCalledTimes(2)
      expect(host.resolveSpy.mock.calls[1]).toEqual(host.resolveSpy.mock.calls[0])
      expect(host.container.querySelector('[role="status"]')).toBeNull()
      expect(host.container.querySelector("iframe")).not.toBeNull()
      expect(host.callSpy).not.toHaveBeenCalled()
      expect(host.providerRetry).not.toHaveBeenCalled()
    } finally { await host.dispose() }
  })

  test.each([
    new Error("Request timed out."),
    new OpenworkServerError(500, "unexpected_failure", "Discovery failed"),
    null,
  ])("keeps ordinary results silent for unknown errors and null resolution (%s)", async cause => {
    const host = resolutionFixture(false)
    if (cause) host.resolveSpy.mockRejectedValue(cause)
    try {
      await host.render()
      expect(host.resolveSpy).toHaveBeenCalledTimes(1)
      expect(host.container.textContent).toBe("")
      expect(host.container.querySelector("iframe")).toBeNull()
      expect(host.errorSpy).not.toHaveBeenCalled()
      expect(host.callSpy).not.toHaveBeenCalled()
      expect(host.providerRetry).not.toHaveBeenCalled()
    } finally { await host.dispose() }
  })

  test.each([false, true])("catalog-shaped preserved data uses only standard resource resolution (advertised: %s)", async advertised => {
    const host = resolutionFixture(false)
    if (advertised) host.resolveSpy.mockResolvedValue({ app: fixture() })
    try {
      const part: DynamicToolUIPart = {
        ...host.part, toolName: "openwork-cloud_search_capabilities", input: { type: "connectors", query: "Slack" },
        callProviderMetadata: { openwork: { mcpResult: {
          content: [{ type: "text", text: "Catalog history" }],
          structuredContent: { connectorCatalog: { version: 1, selectedIds: ["slack"], entries: [{ id: "slack", name: "Slack", description: "Work chat", setup: "oauth_client", serviceUrl: "https://slack.com", setupUrl: "https://example.com/dashboard/mcp-connections?quickAdd=slack" }] } },
        } } },
      }
      await host.render(part)
      expect(host.resolveSpy).toHaveBeenCalledTimes(1)
      expect(Boolean(host.container.querySelector("iframe"))).toBe(advertised)
      expect(host.container.querySelector('[data-testid="connector-catalog"]')).toBeNull()
      for (const text of ["Suggested connector", "Quick-add connectors", "Added to your organization", "Set up"]) {
        expect(host.container.textContent).not.toContain(text)
      }
      expect(host.callSpy).not.toHaveBeenCalled()
      expect(host.errorSpy).not.toHaveBeenCalled()
    } finally { await host.dispose() }
  })

  test.each(["draft", "snapshot", "preview", "both"])("resolves %s metadata inline without opening or redirecting the side panel", async mode => {
    const host = resolutionFixture(true)
    const resourceUri = "ui://openwork/artifacts/arv_fixture/views/avr_fixture/index.html"
    const toolName = mode === "snapshot" ? "openwork-cloud_render_artifact_fixture"
      : mode === "preview" ? "openwork-cloud_preview_artifact_fixture" : "openwork-cloud_save_artifact_view"
    const launch = { toolName, resourceUri, arguments: {} }
    const part: DynamicToolUIPart = {
      ...host.part, toolName,
      callProviderMetadata: { openwork: { mcpResult: {
        content: [{ type: "text", text: "App result retained" }],
        structuredContent: { artifact: { title: "Fixture preview", receiptId: "receipt_fixture" } },
        _meta: {
          "openwork/mcpApp": launch,
          ...(mode !== "snapshot" ? { "openwork/appDraft": { appId: "arv_fixture", revisionId: "avr_fixture", title: "Fixture preview", receiptId: "receipt_fixture" } } : {}),
          ...(mode !== "draft" ? { artifactViewId: "arv_fixture", viewRevisionId: "avr_fixture", appTitle: "Fixture preview" } : {}),
        },
      } } },
    }
    const openTab = spyOn(usePanelTabStore.getState(), "openTab").mockImplementation(() => {})
    const openPanel = spyOn(useUiStateStore.getState(), "setSidePanelState").mockImplementation(() => {})
    const activity = spyOn(useSessionActivityStore.getState(), "getStatus").mockReturnValue("responding")
    host.resolveSpy.mockResolvedValue({ app: fixture({ resourceUri }) })
    try {
      expect(hasPreservedMcpAppResult(part)).toBe(true)
      await host.render(part)
      expect(host.resolveSpy).toHaveBeenCalledWith("fixture", toolName, launch, expect.objectContaining({ sessionId: "session_fixture" }))
      expect(host.container.querySelector("iframe")).not.toBeNull()
      expect(host.container.querySelector("[data-mcp-app-resource]")?.getAttribute("data-mcp-app-resource")).toBe(resourceUri)
      expect(host.container.textContent).not.toContain("Open preview")
      expect(openTab).not.toHaveBeenCalled()
      expect(openPanel).not.toHaveBeenCalled()
      expect(host.callSpy).not.toHaveBeenCalled()
      expect(host.errorSpy).not.toHaveBeenCalled()
    } finally {
      await host.dispose()
      openTab.mockRestore()
      openPanel.mockRestore()
      activity.mockRestore()
    }
  })

  test.each(["mcpResult", "mcpApp"])("keeps draft-only %s metadata on the ordinary resolution path", async alias => {
    const host = resolutionFixture(false)
    try {
      await host.render({
        ...host.part, toolName: "openwork-cloud_save_artifact_view",
        callProviderMetadata: { openwork: { [alias]: {
          content: [], _meta: { "openwork/appDraft": { appId: "arv_fixture", revisionId: "avr_fixture", title: "Draft" } },
        } } },
      })
      expect(host.resolveSpy).toHaveBeenCalledTimes(1)
      expect(host.container.textContent).toBe("")
      expect(host.container.querySelector("iframe")).toBeNull()
      expect(host.callSpy).not.toHaveBeenCalled()
    } finally { await host.dispose() }
  })

  test.each(["skill-created", "plugin-flow"].flatMap(resource =>
    ["openwork_", "openwork-cloud_"].flatMap(prefix =>
      ["mcpResult", "mcpApp"].map(alias => ({ resource, prefix, alias })))
  ))("suppresses retained historical $resource for $prefix through $alias before resolution", async ({ resource, prefix, alias }) => {
    const host = resolutionFixture(true)
    host.resolveSpy.mockResolvedValue({ app: fixture() })
    try {
      await host.render({
        ...host.part, toolName: `${prefix}execute_capability`,
        callProviderMetadata: { openwork: { [alias]: {
          content: [{ type: "text", text: "Historical result" }],
          _meta: { "openwork/mcpApp": { toolName: "historical", resourceUri: `ui://openwork/${resource}/v1/view.html`, arguments: {} } },
        } } },
      })
      expect(host.resolveSpy).not.toHaveBeenCalled()
      expect(host.container.textContent).toBe("")
      expect(host.container.querySelector("iframe")).toBeNull()
      expect(host.errorSpy).not.toHaveBeenCalled()
      expect(host.callSpy).not.toHaveBeenCalled()
    } finally { await host.dispose() }
  })

  test.each([
    { toolName: "provider_render", connectionId: undefined, resourceUri: "ui://openwork/skill-created/v1/view.html", code: "tool_not_found" },
    { toolName: "openwork-cloud_execute_capability", connectionId: "emc_fixture", resourceUri: "ui://openwork/plugin-flow/v1/view.html", code: "tool_not_found" },
    { toolName: "openwork-cloud_execute_capability", connectionId: undefined, resourceUri: "ui://provider/view.html", code: "tool_not_found" },
    { toolName: "openwork-cloud_execute_capability", connectionId: "emc_fixture", resourceUri: "ui://openwork/skill-created/v1/view.html", code: "invalid_resource_csp" },
    { toolName: "provider_create_skill", connectionId: undefined, resourceUri: "ui://openwork/skill-created/v1/view.html", code: "resource_read_failed" },
    { toolName: "openwork-cloud_unknown", connectionId: undefined, resourceUri: "ui://openwork/skill-created/v1/view.html", code: "tool_not_found" },
  ])("preserves provider and security diagnostics for $toolName $resourceUri $code", async ({ toolName, connectionId, resourceUri, code }) => {
    const host = resolutionFixture(true)
    host.resolveSpy.mockRejectedValue(new OpenworkServerError(404, code, "Resolution failed"))
    try {
      await host.render({
        ...host.part, toolName,
        callProviderMetadata: { openwork: { mcpResult: {
          content: [], _meta: { "openwork/mcpApp": { toolName: "render", resourceUri, arguments: {}, ...(connectionId ? { connectionId } : {}) } },
        } } },
      })
      expect(host.container.textContent).toContain("MCP_APP_RESOURCE_RESOLUTION_FAILED")
      expect(host.resolveSpy).toHaveBeenCalledTimes(1)
      expect(host.callSpy).not.toHaveBeenCalled()
    } finally { await host.dispose() }
  })

  test.each(["skill-created", "plugin-flow"].flatMap(resource => [
    { resource, toolName: "openwork-cloud_execute_capability", connectionId: "emc_fixture" },
    { resource, toolName: "openwork_create_skill", connectionId: "emc_fixture" },
    { resource, toolName: "provider_create_skill", connectionId: undefined },
    { resource, toolName: "openwork-other_execute_capability", connectionId: undefined },
    { resource, toolName: "openwork-cloud_execute_capability", connectionId: "" },
    { resource, toolName: "openwork-cloud_render_artifact_fixture", connectionId: undefined },
    { resource, toolName: "openwork-cloud_preview_artifact_fixture", connectionId: undefined },
  ]))("still renders external $toolName $resource through the standard sandbox", async ({ resource, toolName, connectionId }) => {
    const host = resolutionFixture(true)
    const resourceUri = `ui://openwork/${resource}/v1/view.html`
    host.resolveSpy.mockResolvedValue({ app: fixture({ resourceUri }) })
    try {
      await host.render({
        ...host.part, toolName,
        callProviderMetadata: { openwork: { mcpResult: {
          content: [], _meta: { "openwork/mcpApp": { toolName: "render", resourceUri, arguments: {}, ...(connectionId !== undefined ? { connectionId } : {}) } },
        } } },
      })
      expect(host.container.querySelector("iframe")).not.toBeNull()
      expect(host.errorSpy).not.toHaveBeenCalled()
    } finally { await host.dispose() }
  })

  test.each(["openwork_", "openwork-cloud_"].flatMap(prefix =>
    ["create_skill", "update_skill", "plugin_flow"].flatMap(name =>
      ["mcpResult", "mcpApp"].flatMap(alias => [false, true].map(launch => ({ prefix, name, alias, launch }))))
  ))("suppresses backend binding $prefix$name ($alias, launch: $launch) without embedding or resolving", async ({ prefix, name, alias, launch }) => {
    const host = resolutionFixture(false)
    const resourceUri = `ui://openwork/${name === "plugin_flow" ? "plugin-flow" : "skill-created"}/v1/view.html`
    host.resolveSpy.mockResolvedValue({ app: fixture({ resourceUri }) })
    const part: DynamicToolUIPart = {
      ...host.part, toolName: `${prefix}${name}`,
      callProviderMetadata: { openwork: { [alias]: {
        content: [{ type: "text", text: "Created successfully" }],
        _meta: { ui: { resourceUri }, ...(launch ? { "openwork/mcpApp": { toolName: name, resourceUri, arguments: {} } } : {}) },
      } } },
    }
    try {
      expect(hasPreservedMcpAppResult(part)).toBe(true)
      expect(McpAppFrame({ part })).toBeNull()
      await host.render(part)
      expect(host.resolveSpy).not.toHaveBeenCalled()
      expect(host.container.querySelector("iframe")).toBeNull()
      expect(host.container.textContent).toBe("")
      expect(host.errorSpy).not.toHaveBeenCalled()
    } finally { await host.dispose() }
  })

  test.each([
    { toolName: "openwork-cloud_execute_capability", arguments: null, connectionId: undefined },
    { toolName: "openwork_execute_capability", arguments: {}, connectionId: null },
    { toolName: "openwork-cloud_unknown", arguments: {}, connectionId: undefined },
  ])("keeps malformed or unknown $toolName launches on the diagnostic path", async ({ toolName, arguments: args, connectionId }) => {
    const host = resolutionFixture(false)
    host.resolveSpy.mockRejectedValue(new OpenworkServerError(400, "invalid_launch_reference", "Invalid launch"))
    try {
      await host.render({
        ...host.part, toolName,
        callProviderMetadata: { openwork: { mcpResult: {
          content: [], _meta: { "openwork/mcpApp": {
            toolName: "render", resourceUri: "ui://openwork/skill-created/v1/view.html", arguments: args,
            ...(connectionId !== undefined ? { connectionId } : {}),
          } },
        } } },
      })
      expect(host.resolveSpy).toHaveBeenCalledTimes(1)
      expect(host.container.textContent).toContain("MCP_APP_RESOURCE_RESOLUTION_FAILED")
      expect(host.container.textContent).toContain("invalid_launch_reference")
    } finally { await host.dispose() }
  })

  test("releases a launch that resolves after its frame unmounts", async () => {
    const host = resolutionFixture(true)
    let finish: ((value: { app: OpenworkMcpAppResource }) => void) | undefined
    host.resolveSpy.mockImplementation(() => new Promise(resolve => { finish = resolve }))
    try {
      await host.render()
      await host.unmountFrame()
      expect(host.releaseSpy).not.toHaveBeenCalled()
      await act(async () => { finish?.({ app: fixture() }) })
      expect(host.releaseSpy).toHaveBeenCalledTimes(1)
      expect(host.releaseSpy).toHaveBeenCalledWith("fixture", "launch_fixture")
      expect(host.container.querySelector("iframe")).toBeNull()
      expect(host.callSpy).not.toHaveBeenCalled()
      expect(host.errorSpy).not.toHaveBeenCalled()
    } finally { await host.dispose() }
  })
})

test("connection v2 uses the real AppBridge with late host binding and no native card or remount", async () => {
  const previousAct = Reflect.get(globalThis, "IS_REACT_ACT_ENVIRONMENT")
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true)
  const container = document.body.appendChild(document.createElement("div"))
  const root = createRoot(container)
  const [viewTransport, hostTransport] = InMemoryTransport.createLinkedPair()
  const connect = AppBridge.prototype.connect
  const connectSpy = spyOn(AppBridge.prototype, "connect").mockImplementation(function () { return connect.call(this, hostTransport) })
  const confirmSpy = spyOn(window, "confirm")
  const events: string[] = []
  const app = { ...fixture({ toolName: "connection_action", resourceUri: "ui://openwork/connection-action/v2/view.html" }), hostConnectionActions: true }
  const connection = { schemaVersion: "1", connectionId: "connection", connectionName: "Fixture", state: "needs_connection",
    actor: "member", message: "Connect Fixture", action: { type: "connect", label: "Authenticate", surface: "openwork_your_connections" } }
  const launch = { toolName: "connection_action", resourceUri: app.resourceUri, arguments: { connectionId: "connection" } }
  const part: DynamicToolUIPart = { type: "dynamic-tool", toolName: "openwork-cloud_execute_capability", toolCallId: "connection-bridge",
    state: "output-available", input: {}, output: connection,
    callProviderMetadata: { openwork: { mcpResult: { content: [], structuredContent: connection, _meta: { "openwork/mcpApp": launch } } } } }
  let binding: ChatConnectionDecisionBinding | null = null
  let pending = true
  const getConnectionDecision = () => binding
  const onMcpReconnect = async (): Promise<"connected"> => { events.push("oauth"); return "connected" }
  const client: OpenworkServerClient = {
    ...createOpenworkServerClient({ baseUrl: "https://sandbox.example" }),
    mcpAppSandbox: () => ({ url: "about:blank", expectedOrigin: "https://sandbox.example", sandbox: "allow-scripts allow-same-origin" }),
    resolveMcpApp: async () => ({ app }),
    releaseMcpApp: async () => ({ released: true }),
    callMcpAppTool: async (_workspace, payload) => {
      events.push("server")
      if (!payload.approved) throw new OpenworkServerError(422, "tool_requires_approval", "Approval required")
      return { content: [], hostAction: { schemaVersion: "1", kind: "connection_action_intent", action: "authenticate", connection } }
    },
  }
  const render = () => act(async () => root.render(createElement(MessageListProvider, {
    client, workspaceId: "fixture", sessionId: "session", uiStateOwner: "bridge-scope", readOnly: false,
    showThinking: false, developerMode: false, displaySuggestions: false, providerConnectedCount: 0,
    dispatchAction: () => {}, setPrompt: () => {}, onRevertToUserMessage: () => {}, onForkAtMessage: () => {}, onEditUserMessage: () => {},
    onMcpReconnect, onMcpReopenAuthorization: async () => {}, onMcpRetry: () => {}, getConnectionDecision,
    children: createElement(McpAppFrame, { part }),
  })))
  let reply: ((message: JSONRPCMessage) => void) | undefined
  viewTransport.onmessage = message => {
    if ("id" in message && ("result" in message || "error" in message)) reply?.(message)
    if ("id" in message && "method" in message && message.method === "ui/resource-teardown") {
      void viewTransport.send({ jsonrpc: "2.0", id: message.id, result: {} })
    }
  }
  let id = 0
  const request = async (method: string, params: Record<string, unknown>) => {
    const requestId = ++id
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const response = new Promise<JSONRPCMessage>((resolve, reject) => {
        reply = message => { if ("id" in message && message.id === requestId) resolve(message) }
        timer = setTimeout(() => reject(new Error("No protocol response")), 1000)
      })
      await viewTransport.send({ jsonrpc: "2.0", id: requestId, method, params })
      return await response
    } finally { clearTimeout(timer); reply = undefined }
  }
  try {
    await viewTransport.start()
    await render()
    const iframe = container.querySelector("iframe")
    if (!iframe?.contentWindow) throw new Error("Missing standard iframe")
    expect(container.querySelector("button")).toBeNull()
    expect(container.textContent).toBe("")
    expect(events).toEqual([])
    await act(async () => window.dispatchEvent(new MessageEvent("message", { source: iframe.contentWindow, origin: "https://sandbox.example",
      data: { method: "ui/notifications/sandbox-proxy-ready" } })))
    expect(await request("ui/initialize", { appInfo: { name: "fixture", version: "1" }, appCapabilities: {}, protocolVersion: "2026-01-26" }))
      .toMatchObject({ result: { hostContext: { experimental: { "openwork/connection-actions": true } } } })
    await viewTransport.send({ jsonrpc: "2.0", method: "ui/notifications/initialized", params: {} })
    binding = { request: { owner: "bridge-scope", sessionId: "session", turnId: "turn", requestId: "question", toolCallId: part.toolCallId, connectionId: "connection" },
      isPending: () => pending, respond: async response => { events.push(response.outcome); pending = false } }
    await render()
    expect(container.querySelector("iframe")).toBe(iframe)
    expect(connectSpy).toHaveBeenCalledTimes(1)
    const args = { connectionId: "connection", action: "authenticate" }
    expect(await request("tools/call", { name: "connection_action_intent", arguments: args })).toHaveProperty("error")
    expect(events).toEqual(["server"])
    expect(await request("tools/call", { name: "connection_action_intent", arguments: args, _meta: { "openwork/userInteraction": true } }))
      .toMatchObject({ result: { structuredContent: { outcome: "connected", questionAnswered: true } } })
    expect(events).toEqual(["server", "server", "oauth", "connected"])
    expect(confirmSpy).not.toHaveBeenCalled()
  } finally {
    await act(async () => root.unmount())
    await viewTransport.close()
    connectSpy.mockRestore()
    confirmSpy.mockRestore()
    container.remove()
    Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", previousAct)
  }
})

describe("MCP App iframe policy", () => {
  test.each(["input", "result", "client", "workspace", "session", "engine", "read-only", "tool-call"])("refreshes the launch and delivery when %s really changes", async change => {
    const host = await startupFixture()
    const resolutions: unknown[] = []
    const releases: unknown[] = []
    const resolve = async (...args: Parameters<OpenworkServerClient["resolveMcpApp"]>) => {
      resolutions.push(args)
      return { app: fixture({ toolName: "render-0", launchId: `launch-${resolutions.length}` }) }
    }
    const release = async (...args: Parameters<OpenworkServerClient["releaseMcpApp"]>) => {
      releases.push(args)
      return { released: true }
    }
    const client = { ...host.client, resolveMcpApp: resolve, releaseMcpApp: release }
    const replacementClient = { ...client }
    const input = { query: "initial input" }
    const result = { content: [{ type: "text", text: "initial result" }], isError: false }
    const part: DynamicToolUIPart = {
      type: "dynamic-tool", toolName: "render-0", toolCallId: "launch", state: "output-available",
      input, output: "initial result", callProviderMetadata: { openwork: { mcpResult: result } },
    }
    const nextInput = change === "input" ? { query: "updated input" } : input
    const nextResult = change === "result" ? { ...result, content: [{ type: "text", text: "updated result" }], isError: true } : result
    const nextClient = change === "client" ? replacementClient : client
    const nextWorkspace = change === "workspace" ? "updated-workspace" : "fixture"
    const nextSession = change === "session" ? "updated-session" : "session_fixture"
    const nextEngine = change === "engine" ? "v2" : "v1"
    const render = (updated: boolean) => host.renderElement(createElement(MessageListProvider, {
      client: updated ? nextClient : client, workspaceId: updated ? nextWorkspace : "fixture",
      sessionId: updated ? nextSession : "session_fixture", mcpAppEngine: updated ? nextEngine : "v1",
      readOnly: updated && change === "read-only", showThinking: false, developerMode: false,
      displaySuggestions: false, providerConnectedCount: 0,
      dispatchAction: () => {}, setPrompt: () => {}, onRevertToUserMessage: () => {},
      onForkAtMessage: () => {}, onEditUserMessage: () => {},
      onMcpReconnect: async () => { throw new Error("Unexpected reconnect") },
      onMcpReopenAuthorization: async () => {}, onMcpRetry: () => {},
      children: createElement(McpAppFrame, { part: updated ? {
        ...part, toolCallId: change === "tool-call" ? "updated-call" : part.toolCallId,
        input: structuredClone(nextInput), callProviderMetadata: { openwork: { mcpResult: structuredClone(nextResult) } },
      } : part }),
    }))
    try {
      await render(false)
      const iframe = host.frame(0)
      await host.notify(0, "ui/notifications/sandbox-proxy-ready")
      await act(async () => { host.bridges[0].oninitialized?.() })
      expect(host.inputSpy).toHaveBeenLastCalledWith({ arguments: input })
      expect(host.resultSpy).toHaveBeenLastCalledWith(result)
      await render(true)
      expect(host.frame(0) === iframe).toBe(false)
      expect(resolutions).toHaveLength(2)
      expect(releases).toEqual([["fixture", "launch-1"]])
      expect(resolutions[1]).toEqual([nextWorkspace, part.toolName, undefined, {
        client: nextClient, workspaceId: nextWorkspace, sessionId: nextSession,
        engine: nextEngine, readOnly: change === "read-only",
      }])
      expect(host.teardownSpy).toHaveBeenCalledTimes(1)
      expect(host.closeSpy).toHaveBeenCalledTimes(1)
      await host.notify(0, "ui/notifications/sandbox-proxy-ready")
      await act(async () => { host.bridges[0].oninitialized?.(); host.bridges[1].oninitialized?.() })
      expect(host.inputSpy).toHaveBeenCalledTimes(2)
      expect(host.resultSpy).toHaveBeenCalledTimes(2)
      expect(host.inputSpy).toHaveBeenLastCalledWith({ arguments: nextInput })
      expect(host.resultSpy).toHaveBeenLastCalledWith(nextResult)
    } finally { await host.dispose() }
  })

  test.each([
    { isError: true, readOnly: false, preview: false, challenge: false },
    { isError: false, readOnly: false, preview: false, challenge: false },
    { isError: undefined, readOnly: false, preview: false, challenge: false },
    { isError: false, readOnly: false, preview: false, challenge: true },
    { isError: false, readOnly: true, preview: false, challenge: true },
    { isError: false, readOnly: true, preview: true, challenge: true },
  ].flatMap(entry => [false, true].map(sameOrigin => ({ ...entry, sameOrigin }))))("delivers complete launch results and truthful SDK responses without host confirmations (%j)", async ({ isError, readOnly, preview, challenge, sameOrigin }) => {
    const previousAct = Object.getOwnPropertyDescriptor(globalThis, "IS_REACT_ACT_ENVIRONMENT")
    Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true })
    const container = document.body.appendChild(document.createElement("div"))
    const root = createRoot(container)
    const [viewTransport, hostTransport] = InMemoryTransport.createLinkedPair()
    const confirmSpy = spyOn(window, "confirm").mockReturnValue(false)
    const connect = AppBridge.prototype.connect
    const connectSpy = spyOn(AppBridge.prototype, "connect").mockImplementation(function () {
      return connect.call(this, hostTransport)
    })
    const messages: JSONRPCMessage[] = []
    let reply: ((message: JSONRPCMessage) => void) | undefined
    viewTransport.onmessage = (message) => {
      messages.push(message)
      if ("id" in message && ("result" in message || "error" in message)) reply?.(message)
      if ("method" in message && message.method === "ui/resource-teardown" && "id" in message) {
        void viewTransport.send({ jsonrpc: "2.0", id: message.id, result: {} })
      }
    }
    let id = 0
    const request = async (method: string, params: Record<string, unknown> = {}) => {
      const requestId = ++id
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        const response = new Promise<JSONRPCMessage>((resolve, reject) => {
          reply = message => { if ("id" in message && message.id === requestId) resolve(message) }
          timer = setTimeout(() => reject(new Error(`No response to ${method}`)), 1_000)
        })
        await viewTransport.send({ jsonrpc: "2.0", id: requestId, method, params })
        return await response
      } finally { clearTimeout(timer); reply = undefined }
    }
    const result = {
      content: [{ type: "text", text: "Provider fallback" }],
      structuredContent: { serverTools: { provider: true }, schemaGuidance: "provider data" },
      _meta: { privateFixture: "view-only" },
      ...(isError === undefined ? {} : { isError }),
    }
    const input = { query: "complete launch input" }
    const resolutions: unknown[] = []
    const toolCalls: unknown[] = []
    const releases: unknown[] = []
    const opened: string[] = []
    Reflect.set(window, "__OPENWORK_ELECTRON__", { shell: { openExternal: async (url: string) => { opened.push(url); return { ok: true } } } })
    const app = fixture({ launchId: readOnly ? undefined : "launch_fixture" })
    const sandboxClient = createOpenworkServerClient({ baseUrl: sameOrigin ? window.location.origin : "https://sandbox.example" })
    const client: OpenworkServerClient = {
      ...sandboxClient,
      // Exercise real policy selection without asking Happy DOM to fetch a page.
      mcpAppSandbox: (...args) => ({ ...sandboxClient.mcpAppSandbox(...args), url: "about:blank" }),
      resolveMcpApp: async (workspaceId, name, launch, context) => {
        resolutions.push({ workspaceId, name, launch, context })
        return { app }
      },
      callMcpAppTool: async (workspaceId, payload) => {
        toolCalls.push({ workspaceId, payload })
        if (payload.name === "forbidden_detail") throw new OpenworkServerError(403, "tool_denied", "Forbidden")
        if (challenge && !payload.approved) throw new OpenworkServerError(422, "tool_requires_approval", "Approval required")
        return result
      },
      releaseMcpApp: async (workspaceId, launchId) => { releases.push({ workspaceId, launchId }); return { released: true } },
    }
    const primaryClient: OpenworkServerClient = {
      ...client,
      resolveMcpApp: async () => { throw new Error("Must not resolve through the selected workspace") },
      callMcpAppTool: async () => { throw new Error("Must not call through the selected workspace") },
      releaseMcpApp: async () => { throw new Error("Must not release through the selected workspace") },
    }
    const part: DynamicToolUIPart = {
      type: "dynamic-tool", toolName: "fixture_render", toolCallId: "launch", state: "output-available",
      input, output: "Provider fallback", callProviderMetadata: { openwork: { mcpResult: result } },
    }
    const previewOrigin = { client, workspaceId: "fixture", sessionId: null, readOnly: true }
    const render = async (nextPart = part) => {
      await act(async () => root.render(createElement(WorkspaceProvider, {
        client: null, openworkServerClient: primaryClient, workspaceId: "primary", selectedWorkspaceRoot: "/primary",
        children: preview
          ? createElement(McpAppSandboxView, {
              origin: previewOrigin,
              app, toolName: part.toolName, inputArguments: input, result, unavailableNotice: "Unavailable",
            })
          : createElement(MessageListProvider, {
              client, workspaceId: "fixture", sessionId: "session_fixture", mcpAppEngine: "v2", readOnly,
              uiStateOwner: "fixture-principal/org/endpoint/workspace/session", showThinking: false, developerMode: false,
              displaySuggestions: false, providerConnectedCount: 0,
              dispatchAction: () => {}, setPrompt: () => {}, onRevertToUserMessage: () => {},
              onForkAtMessage: () => {}, onEditUserMessage: () => {},
              onMcpReconnect: async () => { throw new Error("Unexpected reconnect in protocol fixture") },
              onMcpReopenAuthorization: async () => {}, onMcpRetry: () => {},
              children: createElement(McpAppFrame, { part: nextPart }),
            }),
      })))
    }
    const refresh = () => render({ ...part, input: structuredClone(input), callProviderMetadata: { openwork: { mcpResult: structuredClone(result) } } })
    try {
      await viewTransport.start()
      await render()
      expect(resolutions).toEqual(preview ? [] : [{
        workspaceId: "fixture", name: part.toolName, launch: undefined,
        context: { client, workspaceId: "fixture", sessionId: "session_fixture", engine: "v2", readOnly },
      }])
      const iframe = container.querySelector("iframe")
      if (!iframe?.contentWindow) throw new Error("Missing fixture iframe")
      expect(iframe.getAttribute("sandbox")).toBe(sameOrigin ? "allow-scripts" : "allow-scripts allow-same-origin")
      expect(iframe.src).toBe("about:blank")
      const expectedOrigin = sameOrigin ? "null" : "https://sandbox.example"
      // An opaque origin is not an identity: only this proxy window may handshake.
      for (const [source, origin] of [[window, expectedOrigin], [iframe.contentWindow, window.location.origin]] satisfies Array<[Window, string]>) {
        await act(async () => window.dispatchEvent(new MessageEvent("message", {
          source, origin, data: { method: "ui/notifications/sandbox-proxy-ready" },
        })))
      }
      expect(connectSpy).not.toHaveBeenCalled()
      await act(async () => window.dispatchEvent(new MessageEvent("message", {
        source: iframe.contentWindow, origin: expectedOrigin,
        data: { method: "ui/notifications/sandbox-proxy-ready" },
      })))
      const initialized = await request("ui/initialize", {
        appInfo: { name: "fixture", version: "1" }, appCapabilities: {}, protocolVersion: "2026-01-26",
      })
      expect(initialized).toMatchObject({ result: {
        protocolVersion: "2026-01-26",
        hostContext: { displayMode: "inline", availableDisplayModes: ["inline"] },
      } })
      if (!("result" in initialized)) throw new Error("Initialization failed")
      expect(initialized.result.hostCapabilities).toEqual(readOnly ? {} : { serverTools: {}, openLinks: {} })
      expect(messages.some(message => "method" in message && message.method === "ui/notifications/tool-result")).toBe(false)
      await act(async () => { await viewTransport.send({ jsonrpc: "2.0", method: "ui/notifications/initialized" }) })
      const delivered = messages.filter(message => "method" in message && message.method.startsWith("ui/notifications/tool-"))
      expect(delivered).toEqual([
        { jsonrpc: "2.0", method: "ui/notifications/tool-input", params: { arguments: input } },
        { jsonrpc: "2.0", method: "ui/notifications/tool-result", params: result },
      ])
      for (const mode of ["inline", "fullscreen", "pip"]) {
        expect(await request("ui/request-display-mode", { mode })).toMatchObject({ result: { mode: "inline" } })
      }
      expect(await request("ui/request-display-mode", { mode: "invalid" })).toMatchObject({ error: { message: expect.stringContaining("Invalid input") } })
      for (const [method, params] of [
        ["ui/message", { role: "user", content: [{ type: "text", text: "not delivered" }] }],
        ["ui/update-model-context", { content: [{ type: "text", text: "not stored" }] }],
        ["resources/list", {}],
      ] satisfies Array<[string, Record<string, unknown>]>) {
        expect(await request(method, params)).toMatchObject({ error: { code: -32601 } })
      }
      let pendingCall: Promise<JSONRPCMessage> | undefined
      await act(async () => { pendingCall = request("tools/call", { name: "read_detail", arguments: {}, _meta: { "openwork/userInteraction": true } }) })
      expect(document.querySelector('[role="alertdialog"]')).toBeNull()
      expect(await pendingCall).toMatchObject(readOnly ? { error: { code: -32601 } } : { result })
      expect(await request("ui/open-link", { url: "https://example.com/" })).toMatchObject(
        readOnly ? { error: { code: -32601 } } : { result: {} },
      )
      expect(await request("ui/open-link", { url: "file:///not-a-web-link" })).toMatchObject(
        readOnly ? { error: { code: -32601 } } : { result: { isError: true } },
      )
      expect(toolCalls).toEqual(readOnly ? [] : [{ workspaceId: "fixture", payload: {
        launchId: "launch_fixture", sessionId: "session_fixture", engine: "v2",
        serverName: app.serverName, resourceUri: app.resourceUri, name: "read_detail", arguments: {}, approved: true,
      } }])
      if (challenge && !readOnly) {
        const before = toolCalls.length
        expect(await request("tools/call", { name: "write_detail", arguments: {} })).toMatchObject({ error: { message: expect.stringContaining("Approval required") } })
        expect(toolCalls).toHaveLength(before + 1)
        expect(toolCalls.at(-1)).toMatchObject({ payload: { name: "write_detail" } })
        expect(toolCalls.at(-1)).not.toMatchObject({ payload: { approved: true } })
        expect(document.querySelector('[role="alertdialog"]')).toBeNull()
      }
      const callsBeforeDenial = toolCalls.length
      const denied = await request("tools/call", { name: "forbidden_detail", arguments: {} })
      if (!("error" in denied)) throw new Error("Expected an SDK error response")
      if (readOnly) expect(denied.error.code).toBe(-32601)
      else expect(denied.error.message).toContain("Forbidden")
      const appDocument = iframe.contentDocument
      if (!appDocument) throw new Error("Missing fixture app document")
      appDocument.body.textContent = denied.error.message
      for (let refreshIndex = 0; refreshIndex < 3; refreshIndex += 1) {
        await refresh()
        expect(container.querySelector("iframe") === iframe).toBe(true)
        expect(iframe.contentDocument).toBe(appDocument)
        expect(appDocument.body.textContent).toBe(denied.error.message)
        expect(resolutions).toHaveLength(preview ? 0 : 1)
        expect(releases).toHaveLength(0)
        expect(connectSpy).toHaveBeenCalledTimes(1)
        expect(messages.filter(message => "method" in message && message.method.startsWith("ui/notifications/tool-"))).toEqual(delivered)
        expect(messages.some(message => "method" in message && message.method === "ui/resource-teardown")).toBe(false)
      }
      expect(toolCalls).toHaveLength(callsBeforeDenial + (readOnly ? 0 : 1))
      expect(opened).toEqual(readOnly ? [] : ["https://example.com/"])
      if (challenge && !readOnly) {
        const callsBeforeReplacement = toolCalls.length
        await act(async () => { await viewTransport.send({ jsonrpc: "2.0", id: ++id, method: "tools/call", params: { name: "write_detail", arguments: { value: "old scope" } } }) })
        expect(document.querySelector('[role="alertdialog"]')).toBeNull()
        expect(toolCalls).toHaveLength(callsBeforeReplacement + 1)
        await act(async () => root.render(createElement(McpAppSandboxView, {
          origin: { client, workspaceId: "other-workspace", sessionId: "other-session", readOnly: true },
          app, toolName: part.toolName, inputArguments: input, result, unavailableNotice: "Unavailable",
        })))
        expect(document.querySelector('[role="alertdialog"]')).toBeNull()
        expect(toolCalls).toHaveLength(callsBeforeReplacement + 1)
      }
      expect(confirmSpy).not.toHaveBeenCalled()
    } finally {
      try {
        await act(async () => root.unmount())
        expect(messages.some(message => "method" in message && message.method === "ui/resource-teardown")).toBe(true)
        expect(releases).toEqual(readOnly ? [] : [{ workspaceId: "fixture", launchId: "launch_fixture" }])
      } finally {
        confirmSpy.mockRestore()
        connectSpy.mockRestore()
        await viewTransport.close()
        container.remove()
        if (previousAct) Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", previousAct)
        else Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT")
      }
    }
  })

  test("an unsupported first-party connection launch cannot fall back to the legacy iframe", () => {
    const part: DynamicToolUIPart = {
      type: "dynamic-tool", toolName: "openwork-cloud_execute_capability", toolCallId: "old-status-probe",
      state: "output-available", input: {}, output: {},
      callProviderMetadata: { openwork: { mcpResult: { content: [], _meta: { "openwork/mcpApp": {
        toolName: "connection_action", resourceUri: "ui://openwork/connection-action/v1/view.html", arguments: { connectionId: "emc_notes" },
      } } } } },
    }
    expect(McpAppFrame({ part })).toBeNull()
    expect(McpAppFrame({ part: { ...part, toolName: "other_execute_capability" } })).not.toBeNull()
  })

  test("accepts a namespaced gateway launch reference without exposing credentials", () => {
    expect(gatewayMcpAppLaunch({
      source: "provider",
      "openwork/mcpApp": {
        connectionId: "emc_01atlas",
        toolName: "open_project_atlas",
        resourceUri: "ui://atlas/1/index.html",
        arguments: { query: "migration" },
      },
    })).toEqual({
      connectionId: "emc_01atlas",
      toolName: "open_project_atlas",
      resourceUri: "ui://atlas/1/index.html",
      arguments: { query: "migration" },
    })
    expect(gatewayMcpAppLaunch({
      "openwork/mcpApp": {
        connectionId: "emc_01atlas",
        toolName: "open_project_atlas",
        resourceUri: "ui://atlas/1/index.html",
      },
    })).toBeNull()
  })

  test("accepts a same-server generated App launch without a connection reference", () => {
    expect(gatewayMcpAppLaunch({
      "openwork/mcpApp": {
        toolName: "render_artifact_view",
        resourceUri: "ui://openwork/artifacts/atlas/views/1/index.html",
        arguments: { input: { query: "migration" } },
      },
    })).toEqual({
      toolName: "render_artifact_view",
      resourceUri: "ui://openwork/artifacts/atlas/views/1/index.html",
      arguments: { input: { query: "migration" } },
    })
  })

  test.each([
    ["https://web.example", "https://web.example", "https://web.example", "null", "allow-scripts"],
    ["https://web.example/api/openwork", "https://web.example", "https://web.example", "null", "allow-scripts"],
    ["https://worker.example", "https://web.example", "https://worker.example", "https://worker.example", "allow-scripts allow-same-origin"],
    ["http://localhost:4321", "http://localhost:4321", "http://127.0.0.1:4321", "http://127.0.0.1:4321", "allow-scripts allow-same-origin"],
    ["http://127.0.0.1:4321", "http://127.0.0.1:4321", "http://localhost:4321", "http://localhost:4321", "allow-scripts allow-same-origin"],
    ["http://localhost:4321", "file://", "http://localhost:4321", "http://localhost:4321", "allow-scripts allow-same-origin"],
  ])("isolates sandbox delivery for %s hosted at %s", (baseUrl, hostOrigin, urlOrigin, expectedOrigin, sandboxFlags) => {
    const client = createOpenworkServerClient({ baseUrl, token: "private-client-token", hostToken: "private-host-token" })
    const sandbox = client.mcpAppSandbox(fixture(), hostOrigin)
    expect(new URL(sandbox.url).origin).toBe(urlOrigin)
    expect(sandbox.expectedOrigin).toBe(expectedOrigin)
    expect(sandbox.sandbox).toBe(sandboxFlags)
    expect(sandbox.url).not.toContain("private-")
    expect(new URL(sandbox.url).searchParams.get("hostOrigin")).toBe(normalizeMcpAppHostOrigin(hostOrigin))
  })

  test("uses the opaque message origin for packaged file hosts", () => {
    expect(normalizeMcpAppHostOrigin("file://")).toBe("null")
    expect(normalizeMcpAppHostOrigin("null")).toBe("null")
    expect(normalizeMcpAppHostOrigin("https://desktop.example")).toBe("https://desktop.example")

    const client = createOpenworkServerClient({ baseUrl: "http://localhost:61856" })
    const sandbox = client.mcpAppSandbox(fixture(), "file://")
    expect(new URL(sandbox.url).searchParams.get("hostOrigin")).toBe("null")
  })

  test("keeps ordinary tools silent while surfacing advertised resource failures", () => {
    expect(isActionableMcpAppResolutionError(new OpenworkServerError(503, "mcp_unreachable", "offline"))).toBe(true)
    expect(isActionableMcpAppResolutionError(new OpenworkServerError(404, "resource_read_failed", "missing"))).toBe(true)
    expect(isActionableMcpAppResolutionError(new Error("generic failure"))).toBe(false)
  })

  test("formats safe, copyable handshake diagnostics", () => {
    const details = formatMcpAppDiagnostic({
      code: "MCP_APP_INITIALIZE_TIMEOUT",
      causeCode: "mcp_unreachable",
      stage: "app-initialization",
      message: "The HTML document loaded, but initialization did not complete.",
      toolName: "artifact_render_card",
      resourceUri: "ui://openwork/artifacts/arv_1/views/avr_2/index.html",
      sandboxOrigin: "http://127.0.0.1:4321",
      elapsedMs: 10_025,
      checkpoints: ["resource-resolved+0ms", "resource-document-loaded+24ms"],
      sandboxDocument: { readyState: "complete", hasHtmlRoot: true, scriptCount: 1 },
    })
    expect(details).toContain("Code: MCP_APP_INITIALIZE_TIMEOUT")
    expect(details).toContain("Cause code: mcp_unreachable")
    expect(details).toContain("Stage: app-initialization")
    expect(details).toContain("Resource: ui://openwork/artifacts/arv_1/views/avr_2/index.html")
    expect(details).toContain("Document: readyState=complete, htmlRoot=true, scripts=1")
    expect(details).toContain("resource-document-loaded+24ms")
  })

  test("redacts credentials from diagnostic messages", () => {
    expect(safeMcpAppDiagnosticMessage(
      new Error("request failed: Bearer secret-value https://example.com?access_token=also-secret"),
      "fallback",
    )).toBe("request failed: Bearer [redacted] https://example.com?access_token=[redacted]")
  })

  test("defaults every ambient capability closed", () => {
    const csp = buildMcpAppCsp(fixture())
    expect(csp).toContain("default-src 'none'")
    expect(csp).toContain("connect-src 'none'")
    expect(csp).toContain("frame-src 'none'")
    expect(csp).toContain("base-uri 'none'")
    expect(csp).toContain("form-action 'none'")
  })

  test("injects the host-enforced CSP before resource markup runs", () => {
    const html = secureMcpAppHtml(fixture())
    const policy = html.indexOf('http-equiv="Content-Security-Policy"')
    const title = html.indexOf("<title>")
    expect(policy).toBeGreaterThan(-1)
    expect(policy).toBeLessThan(title)
  })

  test("creates a valid policy-bearing head when the resource omits one", () => {
    const html = secureMcpAppHtml(fixture({ html: "<html><body>headless resource</body></html>" }))
    expect(html).toContain('<html><head><meta http-equiv="Content-Security-Policy"')
    expect(html.indexOf("Content-Security-Policy")).toBeLessThan(html.indexOf("<body>"))

    const fragment = secureMcpAppHtml(fixture({ html: "<main>fragment resource</main>" }))
    expect(fragment).toStartWith('<!doctype html><html><head><meta http-equiv="Content-Security-Policy"')
    expect(fragment).toContain("<body><main>fragment resource</main></body>")
  })

  test("rejects executable markup before an existing document policy", () => {
    expect(() => secureMcpAppHtml(fixture({
      html: "<script>globalThis.beforePolicy = true</script><html><head></head><body>bad</body></html>",
    }))).toThrow("executable markup before its HTML root")
    expect(() => secureMcpAppHtml(fixture({
      html: "<html><script>globalThis.beforePolicy = true</script><head></head><body>bad</body></html>",
    }))).toThrow("markup before its policy-bearing head")
  })

  test("allows only the server-declared origins in each directive", () => {
    const csp = buildMcpAppCsp(fixture({
      csp: {
        connectDomains: ["https://api.example.com"],
        resourceDomains: ["https://static.example.com"],
        frameDomains: ["https://embed.example.com"],
        baseUriDomains: [],
      },
    }))
    expect(csp).toContain("connect-src https://api.example.com")
    expect(csp).toContain("script-src 'unsafe-inline' https://static.example.com")
    expect(csp).toContain("frame-src https://embed.example.com")
  })
})


test.each([
  { query: "Slack", intent: "connect" },
  { query: "connectors", type: "connectors" },
  { query: "Slack" },
])("catalog output alone never qualifies as an MCP App (%j)", input => {
  const catalog = { version: 1, selectedIds: ["slack"], entries: [{ id: "slack", name: "Slack", description: "Work chat", setup: "oauth_client", setupUrl: "https://example.com/dashboard/mcp-connections?quickAdd=slack" }] };
  for (const output of [{ connectorCatalog: catalog }, JSON.stringify({ connectorCatalog: catalog }), "invalid json"]) {
    const part: DynamicToolUIPart = { type: "dynamic-tool", toolName: "openwork-cloud_search_capabilities", toolCallId: "catalog", state: "output-available", input, output };
    expect(hasPreservedMcpAppResult(part)).toBe(false);
    expect(hasPreservedMcpAppResult({ ...part, toolName: "other_search_capabilities" })).toBe(false);
  }
});

test.each(["mcpResult", "mcpApp"])("preserves the generic %s metadata alias without interpreting its payload", alias => {
  const part: DynamicToolUIPart = {
    type: "dynamic-tool", toolName: "provider_render", toolCallId: "alias", state: "output-available", input: {}, output: "fallback",
    callProviderMetadata: { openwork: { [alias]: { content: [{ type: "text", text: "fallback" }], structuredContent: { provider: true } } } },
  };
  expect(hasPreservedMcpAppResult(part)).toBe(true);
  expect(hasPreservedMcpAppResult({ ...part, callProviderMetadata: { openwork: { [alias]: { content: [null] } } } })).toBe(false);
});
