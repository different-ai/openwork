import { afterEach, expect, test } from "bun:test"

import { createOpenworkServerClient, type OpenworkMcpAppResource, type OpenworkServerClient } from "../src/app/lib/openwork-server"
import { createMcpAppActions } from "../src/components/chat/mcp-app-origin"
import { resolveDashboardMcpApp } from "../src/react-app/domains/dashboard/dashboard-mcp-app-resolution"

const app = { launchId: "launch", serverName: "server", toolName: "open_app", resourceUri: "ui://server/app" } as OpenworkMcpAppResource

type Call = {
  payload: { approved?: boolean; checkOnly?: boolean }
  options?: { signal?: AbortSignal }
  finish: () => void
}

function createActions() {
  const calls: Call[] = []
  const client = {
    callMcpAppTool: (_workspaceId: string, payload: Call["payload"], options?: Call["options"]) => new Promise((resolve, reject) => {
      calls.push({ payload, options, finish: () => resolve({ content: [] }) })
      options?.signal?.addEventListener("abort", () => reject(new Error("Request timed out.")), { once: true })
    }),
  } as unknown as OpenworkServerClient
  return { calls, actions: createMcpAppActions({ client, workspaceId: "workspace", sessionId: null, readOnly: false }, app) }
}

test("closing an App cancels the read it was waiting on", async () => {
  const { calls, actions } = createActions()
  const read = actions.callTool("list_workers")
  expect(calls[0]?.options?.signal?.aborted).toBe(false)

  actions.dispose()
  expect(calls[0]?.options?.signal?.aborted).toBe(true)
  await expect(read).rejects.toThrow("closed or changed")
})

test("closing an App cancels its check for a kept result", async () => {
  const { calls, actions } = createActions()
  const check = actions.checkRead("list_workers")
  expect(calls[0]?.payload.checkOnly).toBe(true)

  actions.dispose()
  expect(calls[0]?.options?.signal?.aborted).toBe(true)
  await expect(check).rejects.toThrow("closed or changed")
})

test("closing an App never cancels something the person clicked", async () => {
  const { calls, actions } = createActions()
  const clicked = actions.callTool("delete_worker", {}, true)
  expect(calls[0]?.payload.approved).toBe(true)
  expect(calls[0]?.options).toBeUndefined()

  actions.dispose()
  calls[0]?.finish()
  // The App is gone, so its answer goes nowhere, but the request ran to the end.
  await expect(clicked).rejects.toThrow("closed or changed")
})

test("resolving an App can be cancelled", async () => {
  const signals: Array<AbortSignal | undefined> = []
  const endpoint = {
    workspaceId: "workspace",
    client: {
      resolveMcpApp: async (_workspaceId: string, _tool: string, _launch: unknown, _context: unknown, options?: { signal?: AbortSignal }) => {
        signals.push(options?.signal)
        return { app }
      },
      releaseMcpApp: async () => ({ released: true }),
    },
  } as unknown as Parameters<typeof resolveDashboardMcpApp>[0]["endpoints"][number]
  const controller = new AbortController()

  const resolved = await resolveDashboardMcpApp({
    endpoints: [endpoint],
    projectedToolName: "open_app",
    expected: { serverName: app.serverName, toolName: app.toolName, resourceUri: app.resourceUri },
    signal: controller.signal,
  })

  expect(resolved?.app).toEqual(app)
  expect(signals).toEqual([controller.signal])
})

const realFetch = globalThis.fetch
afterEach(() => { globalThis.fetch = realFetch })

test("a cancelled App call drops its network request", async () => {
  let requestSignal: AbortSignal | null | undefined
  globalThis.fetch = ((_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
    requestSignal = init?.signal
    init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true })
  })) as typeof fetch
  const client = createOpenworkServerClient({ baseUrl: "http://127.0.0.1:8787", token: "token" })
  const controller = new AbortController()

  const call = client.callMcpAppTool("workspace", { serverName: "server", name: "list_workers", resourceUri: app.resourceUri }, { signal: controller.signal })
  expect(requestSignal?.aborted).toBe(false)

  controller.abort()
  expect(requestSignal?.aborted).toBe(true)
  await expect(call).rejects.toThrow()
})
