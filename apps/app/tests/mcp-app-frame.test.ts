import { describe, expect, spyOn, test } from "bun:test"
import { GlobalRegistrator } from "@happy-dom/global-registrator"
import { act, createElement } from "react"
import { createRoot } from "react-dom/client"
import { AppBridge } from "@modelcontextprotocol/ext-apps/app-bridge"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js"
import type { DynamicToolUIPart } from "ai"
import { ConnectionCard } from "../src/components/chat/connection-card"
import { MessageListProvider } from "../src/components/chat/message-list-provider"
import { WorkspaceProvider } from "../src/react-app/shell/workspace-provider"

import {
  createOpenworkServerClient,
  normalizeMcpAppHostOrigin,
  OpenworkServerError,
  type OpenworkMcpAppResource,
  type OpenworkServerClient,
} from "../src/app/lib/openwork-server"
import { formatMcpAppDiagnostic, safeMcpAppDiagnosticMessage } from "../src/components/chat/mcp-app-diagnostics"
import {
  buildMcpAppCsp,
  connectorCatalogFromPart,
  hasPreservedMcpAppResult,
  gatewayMcpAppLaunch,
  isActionableMcpAppResolutionError,
  McpAppFrame,
  McpAppSandboxView,
  secureMcpAppHtml,
} from "../src/components/chat/mcp-app-frame"

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

describe("MCP App iframe policy", () => {
  test.each([
    { isError: true, readOnly: false, preview: false },
    { isError: false, readOnly: false, preview: false },
    { isError: undefined, readOnly: false, preview: false },
    { isError: false, readOnly: true, preview: false },
    { isError: false, readOnly: true, preview: true },
  ])("delivers complete launch results and truthful SDK responses (%j)", async ({ isError, readOnly, preview }) => {
    GlobalRegistrator.register({ url: "http://localhost/", happyDOM: { settings: { disableIframePageLoading: true } } })
    const previousAct = Object.getOwnPropertyDescriptor(globalThis, "IS_REACT_ACT_ENVIRONMENT")
    Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true })
    const container = document.body.appendChild(document.createElement("div"))
    const root = createRoot(container)
    const [viewTransport, hostTransport] = InMemoryTransport.createLinkedPair()
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
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        const response = new Promise<JSONRPCMessage>((resolve, reject) => {
          reply = resolve
          timer = setTimeout(() => reject(new Error(`No response to ${method}`)), 1_000)
        })
        await viewTransport.send({ jsonrpc: "2.0", id: ++id, method, params })
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
    const client: OpenworkServerClient = {
      ...createOpenworkServerClient({ baseUrl: "http://localhost:1" }),
      resolveMcpApp: async (workspaceId, name, launch, context) => {
        resolutions.push({ workspaceId, name, launch, context })
        return { app }
      },
      mcpAppSandbox: () => ({ url: "about:blank", expectedOrigin: "https://sandbox.example" }),
      callMcpAppTool: async (workspaceId, payload) => { toolCalls.push({ workspaceId, payload }); return result },
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
    try {
      await viewTransport.start()
      await act(async () => root.render(createElement(WorkspaceProvider, {
        client: null, openworkServerClient: primaryClient, workspaceId: "primary", selectedWorkspaceRoot: "/primary",
        children: preview
          ? createElement(McpAppSandboxView, {
              origin: { client, workspaceId: "fixture", sessionId: null, readOnly: true },
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
              children: createElement(McpAppFrame, { part }),
            }),
      })))
      expect(resolutions).toEqual(preview ? [] : [{
        workspaceId: "fixture", name: part.toolName, launch: undefined,
        context: { client, workspaceId: "fixture", sessionId: "session_fixture", engine: "v2", readOnly },
      }])
      const iframe = container.querySelector("iframe")
      if (!iframe?.contentWindow) throw new Error("Missing fixture iframe")
      await act(async () => window.dispatchEvent(new MessageEvent("message", {
        source: iframe.contentWindow, origin: "https://sandbox.example",
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
      expect(await request("tools/call", { name: "read_detail", arguments: {} })).toMatchObject(
        readOnly ? { error: { code: -32601 } } : { result },
      )
      expect(await request("ui/open-link", { url: "https://example.com/" })).toMatchObject(
        readOnly ? { error: { code: -32601 } } : { result: {} },
      )
      expect(await request("ui/open-link", { url: "file:///not-a-web-link" })).toMatchObject(
        readOnly ? { error: { code: -32601 } } : { result: { isError: true } },
      )
      expect(toolCalls).toEqual(readOnly ? [] : [{ workspaceId: "fixture", payload: {
        launchId: "launch_fixture", sessionId: "session_fixture", engine: "v2",
        serverName: app.serverName, resourceUri: app.resourceUri, name: "read_detail", arguments: {},
      } }])
      expect(opened).toEqual(readOnly ? [] : ["https://example.com/"])
    } finally {
      try {
        await act(async () => root.unmount())
        expect(messages.some(message => "method" in message && message.method === "ui/resource-teardown")).toBe(true)
        expect(releases).toEqual(readOnly ? [] : [{ workspaceId: "fixture", launchId: "launch_fixture" }])
      } finally {
        connectSpy.mockRestore()
        await viewTransport.close()
        container.remove()
        if (previousAct) Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", previousAct)
        else Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT")
        await GlobalRegistrator.unregister()
      }
    }
  })

  test("connection status execution renders the native card even without preserved app metadata", () => {
    const part: DynamicToolUIPart = {
      type: "dynamic-tool", toolName: "openwork-cloud_execute_capability", toolCallId: "status-probe",
      state: "output-available", input: { name: "mcp:emc_notes:*" },
      output: { schemaVersion: "1", connectionId: "emc_notes", connectionName: "Notes", state: "needs_connection",
        actor: "member", message: "Connect Notes to continue.",
        action: { type: "connect", label: "Connect Notes", surface: "openwork_your_connections" } },
    }
    expect(hasPreservedMcpAppResult(part)).toBe(true)
    expect(McpAppFrame({ part })?.type).toBe(ConnectionCard)
    expect(McpAppFrame({ part: { ...part, output: { ...part.output, state: "connected", actor: null, action: null } } })?.type).toBe(ConnectionCard)
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

  test("uses the opaque message origin for packaged file hosts", () => {
    expect(normalizeMcpAppHostOrigin("file://")).toBe("null")
    expect(normalizeMcpAppHostOrigin("null")).toBe("null")
    expect(normalizeMcpAppHostOrigin("https://desktop.example")).toBe("https://desktop.example")

    const client = createOpenworkServerClient({ baseUrl: "http://localhost:61856" })
    const sandbox = client.mcpAppSandbox(fixture(), "file://")
    expect(new URL(sandbox.url).searchParams.get("hostOrigin")).toBe("null")
  })

  test("keeps ordinary tools silent while surfacing advertised resource failures", () => {
    expect(isActionableMcpAppResolutionError(new OpenworkServerError(503, "mcp_unreachable", "offline"))).toBe(false)
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


test("only canonical completed gateway search results render connector setup suggestions", () => {
  const catalog = { version: 1, selectedIds: ["slack"], entries: [{ id: "slack", name: "Slack", description: "Work chat", setup: "oauth_client", setupUrl: "https://example.com/dashboard/mcp-connections?quickAdd=slack" }] };
  const part = { type: "dynamic-tool", toolName: "openwork-cloud_search_capabilities", toolCallId: "catalog", state: "output-available", input: { query: "Slack", intent: "connect" }, output: JSON.stringify({ connectorCatalog: catalog }) } satisfies import("ai").DynamicToolUIPart;
  expect(connectorCatalogFromPart(part)).toEqual(catalog);
  expect(hasPreservedMcpAppResult(part)).toBe(true);
  expect(hasPreservedMcpAppResult({ ...part, input: { query: "Slack" } })).toBe(false);
  expect(connectorCatalogFromPart({ ...part, toolName: "other_search_capabilities" })).toBeNull();
  expect(connectorCatalogFromPart({ ...part, output: "invalid json" })).toBeNull();
  expect(connectorCatalogFromPart({ ...part, output: { connectorCatalog: { ...catalog, version: 2 } } })).toBeNull();
});
