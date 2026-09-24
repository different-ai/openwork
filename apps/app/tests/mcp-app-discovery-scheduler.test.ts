import { describe, expect, test } from "bun:test"
import { createMcpAppDiscoveryScheduler, mcpAppDiscoverySignature } from "../src/app/lib/mcp-app-discovery-scheduler"
import { createOpenworkServerClient, OpenworkServerError, type OpenworkMcpAppResource, type OpenworkServerClient } from "../src/app/lib/openwork-server"
import type { McpAppOrigin } from "../src/components/chat/mcp-app-origin"

const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve() }
const originFor = (resolveMcpApp: OpenworkServerClient["resolveMcpApp"]): McpAppOrigin => ({
  client: { ...createOpenworkServerClient({ baseUrl: "http://fixture.invalid", token: "fixture" }), resolveMcpApp },
  workspaceId: "workspace", sessionId: "session", engine: "v2", readOnly: false,
})
const resource = (launchId: string): OpenworkMcpAppResource => ({
  launchId, serverName: "fixture", toolName: "render", resourceUri: "ui://fixture/view",
  html: "", csp: { connectDomains: [], resourceDomains: [], frameDomains: [], baseUriDomains: [] }, prefersBorder: false,
})

describe("chat discovery admission", () => {
  test.each([null, "mcp_auth_required", "mcp_access_denied"])("100 identical negative discoveries share one request: %s", async code => {
    const schedule = createMcpAppDiscoveryScheduler()
    let calls = 0
    let outcomes = 0
    const origin = originFor(async () => { calls++; if (code) throw new OpenworkServerError(403, code, "Blocked"); return { app: null } })
    for (let i = 0; i < 100; i++) schedule(origin, "ambiguous_tool_name", null, false, () => outcomes++, () => outcomes++)
    await flush()
    expect(calls).toBe(1)
    expect(outcomes).toBe(100)
  })

  test("two global slots; successful views each obtain their own launch; cancelled queue never dispatches", async () => {
    const schedule = createMcpAppDiscoveryScheduler()
    const completions: Array<() => void> = []
    const received: string[] = []
    const released: string[] = []
    let calls = 0
    const origin = originFor(async () => {
      const id = `launch-${++calls}`
      return new Promise(resolve => completions.push(() => resolve({ app: resource(id) })))
    })
    origin.client.releaseMcpApp = async (_workspace, id) => { released.push(id); return { released: true } }
    const receive = (app: OpenworkMcpAppResource | null) => { if (app?.launchId) received.push(app.launchId) }
    const fail = () => { throw new Error("Unexpected failure") }
    const cancelActive = schedule(origin, "render", null, false, receive, fail)
    schedule(origin, "render", null, false, receive, fail)
    schedule(origin, "other", null, false, receive, fail)
    const cancelQueued = schedule(origin, "never", null, false, receive, fail)
    expect(calls).toBe(2)
    cancelActive(); cancelQueued()
    completions.shift()?.(); completions.shift()?.()
    await flush()
    expect(calls).toBe(3)
    completions.shift()?.()
    await flush()
    expect(released).toEqual(["launch-1"])
    expect(received.sort()).toEqual(["launch-2", "launch-3"])
  })

  test("cooldown and manual bypass are exact-scoped and rate limited", async () => {
    let time = 10_000
    const schedule = createMcpAppDiscoveryScheduler(() => time)
    let calls = 0
    const resolve: OpenworkServerClient["resolveMcpApp"] = async () => { calls++; return { app: null } }
    const origin = originFor(resolve)
    const run = (scope = origin, manual = false, launch = null) => schedule(scope, "render", launch, manual, () => {}, () => {})
    run(); await flush()
    run(origin, true); await flush()
    for (let i = 0; i < 100; i++) run(origin, true)
    await flush()
    expect(calls).toBe(2)
    for (const scope of [originFor(resolve), { ...origin, workspaceId: "other" }, { ...origin, sessionId: "other" }, { ...origin, engine: "v1" }, { ...origin, readOnly: true }] satisfies McpAppOrigin[]) {
      run(scope); await flush()
    }
    expect(calls).toBe(7)
    for (const connectionId of ["one", "two"]) {
      schedule(origin, "render", { connectionId, toolName: "render", resourceUri: "ui://fixture/view", arguments: {} }, false, () => {}, () => {})
    }
    await flush()
    expect(calls).toBe(9)
    time += 30_001
    run(); await flush()
    expect(calls).toBe(10)
  })

  test("equivalent object order has one key; meaningful launch arguments do not", () => {
    expect(mcpAppDiscoverySignature({ a: 1, b: { x: 2, y: 3 } })).toBe(mcpAppDiscoverySignature({ b: { y: 3, x: 2 }, a: 1 }))
    expect(mcpAppDiscoverySignature({ arguments: { id: 1 } })).not.toBe(mcpAppDiscoverySignature({ arguments: { id: 2 } }))
  })
})
