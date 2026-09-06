import { describe, expect, test } from "bun:test"
import { mcpAppResolutionRetryDelayMs } from "../src/app/lib/mcp-app-resolution"
import { resolveDashboardMcpApp } from "../src/react-app/domains/dashboard/dashboard-mcp-app-resolution"

import {
  createOpenworkServerClient,
  normalizeMcpAppHostOrigin,
  OpenworkServerError,
  type OpenworkMcpAppResource,
} from "../src/app/lib/openwork-server"
import { formatMcpAppDiagnostic, safeMcpAppDiagnosticMessage } from "../src/components/chat/mcp-app-diagnostics"
import {
  buildMcpAppCsp,
  connectorCatalogFromPart,
  hasPreservedMcpAppResult,
  gatewayMcpAppLaunch,
  isActionableMcpAppResolutionError,
  secureMcpAppHtml,
} from "../src/components/chat/mcp-app-frame"

function fixture(overrides: Partial<OpenworkMcpAppResource> = {}): OpenworkMcpAppResource {
  return {
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

describe("MCP App discovery recovery", () => {
  test("bounds retries to transient discovery failures", () => {
    for (const code of ["server_unavailable", "mcp_unreachable"]) {
      const cause = new OpenworkServerError(503, code, "starting")
      expect(mcpAppResolutionRetryDelayMs(cause, 0)).toBe(1_000)
      expect(mcpAppResolutionRetryDelayMs(cause, 1)).toBe(3_000)
      expect(mcpAppResolutionRetryDelayMs(cause, 2)).toBeNull()
    }
    for (const code of ["tool_denied", "tool_resource_mismatch"]) {
      expect(mcpAppResolutionRetryDelayMs(new OpenworkServerError(422, code, "denied"), 0)).toBeNull()
    }
    expect(mcpAppResolutionRetryDelayMs(new Error("unknown failure"), 0)).toBeNull()
  })

  test.each([false, true])("recovers or stops after three discovery attempts (exhausted: %j)", async (exhausted) => {
    const app = fixture()
    let attempts = 0
    const waits: number[] = []
    const failure = new OpenworkServerError(503, "mcp_unreachable", "starting")
    const endpoint = {
      workspaceId: "workspace-1",
      client: { resolveMcpApp: async () => {
        attempts += 1
        if (exhausted || attempts < 3) throw failure
        return { app }
      } },
    }
    const resolving = resolveDashboardMcpApp({
      endpoints: [endpoint], projectedToolName: "fixture_render", expected: app,
      wait: async (delay) => { waits.push(delay) },
    })
    if (exhausted) await expect(resolving).rejects.toBe(failure)
    else expect(await resolving).toEqual({ endpoint, app })
    expect(attempts).toBe(3)
    expect(waits).toEqual([1_000, 3_000])
  })

  test("tries another workspace before waiting and never retries deterministic failures", async () => {
    const app = fixture()
    let attempts = 0
    const failure = new OpenworkServerError(422, "tool_resource_mismatch", "resource moved")
    const first = { workspaceId: "first", client: { resolveMcpApp: async () => { attempts += 1; throw failure } } }
    const second = { workspaceId: "second", client: { resolveMcpApp: async () => ({ app }) } }
    const options = {
      projectedToolName: "fixture_render", expected: app,
      wait: async () => { throw new Error("must not retry") },
    }
    expect(await resolveDashboardMcpApp({ ...options, endpoints: [first, second] })).toEqual({ endpoint: second, app })
    await expect(resolveDashboardMcpApp({ ...options, endpoints: [first] })).rejects.toBe(failure)
    expect(attempts).toBe(2)
  })

  test.each([
    { serverName: "other-server" },
    { toolName: "other-tool" },
    { resourceUri: "ui://fixture/other.html" },
  ])("refuses a different saved identity without a connection reference: %j", async (mismatch) => {
    const app = fixture()
    const lookalike = { workspaceId: "lookalike", client: { resolveMcpApp: async () => ({ app: fixture(mismatch) }) } }
    const matching = { workspaceId: "matching", client: { resolveMcpApp: async () => ({ app }) } }
    const options = {
      projectedToolName: "fixture_render", expected: app,
      wait: async () => { throw new Error("identity mismatch must not retry") },
    }
    expect(await resolveDashboardMcpApp({ ...options, endpoints: [lookalike, matching] })).toEqual({ endpoint: matching, app })
    expect(await resolveDashboardMcpApp({ ...options, endpoints: [lookalike] })).toBeNull()
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
