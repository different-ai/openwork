import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { test } from "node:test"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { useWorkbotConnect, WorkbotConnectAction } from "../../../packages/workbot-ui/src/connect.js"
import { setWorkbotHost } from "../../../packages/workbot-ui/src/host.js"
import type { WorkbotConnection } from "../../../packages/workbot-ui/src/data.js"
import { readConnectionResult } from "../../../packages/workbot-ui/src/connect-result.js"

test("only the same consent window, callback origin, attempt and connection may wake readiness", () => {
  const popup = {}
  const expected = { popup, callbackOrigin: "https://api.example.test", requestId: randomUUID(), id: "google-workspace" }
  const data = { type: "openwork:connection-result", requestId: expected.requestId, connectionId: expected.id, ok: true }
  const event = { source: popup, origin: expected.callbackOrigin, data }
  assert.equal(readConnectionResult(event, expected)?.ok, true)
  assert.equal(readConnectionResult({ ...event, data: { ...data, ok: false } }, expected)?.ok, false)
  assert.equal(readConnectionResult({ ...event, source: {} }, expected), null)
  assert.equal(readConnectionResult({ ...event, origin: "https://other.example.test" }, expected), null)
  assert.equal(readConnectionResult({ ...event, origin: "null" }, expected), null)
  assert.equal(readConnectionResult({ ...event, data: { ...data, requestId: randomUUID() } }, expected), null)
  assert.equal(readConnectionResult({ ...event, data: { ...data, connectionId: "other-connection" } }, expected), null)
  assert.equal(readConnectionResult({ ...event, data: { ...data, ok: "connected" } }, expected), null)
  assert.equal(readConnectionResult(event, { ...expected, popup: null }), null)
  assert.equal(readConnectionResult(event, { ...expected, callbackOrigin: null }), null)
})

function renderConnectAction(connections: WorkbotConnection[], fallbackHref?: string | null) {
  const identity = { organizationId: "fixture-org", principalId: "fixture-member" }
  setWorkbotHost({
    identity, user: null, homeHref: "/", appIcons: () => [], useConnectedApps: () => [],
    requestJson: async () => { throw new Error("Rendering must not start a connection") },
    prepare: async () => { throw new Error("Rendering must not prepare a request") },
  })
  const client = new QueryClient()
  client.setQueryData(["workbot", "connections", identity.organizationId, identity.principalId], connections)
  function Action() {
    const flow = useWorkbotConnect()
    return createElement(WorkbotConnectAction, { flow, provider: "google-workspace", label: "Connect Google Drive", fallbackHref })
  }
  try { return renderToStaticMarkup(createElement(QueryClientProvider, { client }, createElement(Action))) }
  finally { client.clear() }
}

test("no match and older Den metadata offer settings without claiming Connect works or a grant is absent", () => {
  const legacy: WorkbotConnection = { id: "legacy-google", name: "Google Workspace", app: "gmail", ready: false, connectUrl: "https://den.example.test/dashboard/your-connections?connectionId=legacy-google" }
  for (const connections of [[], [legacy]]) {
    const html = renderConnectAction(connections, "https://den.example.test/dashboard/your-connections")
    assert.ok(html.includes("verify an account to connect here."))
    assert.ok(html.includes('href="https://den.example.test/dashboard/your-connections"'))
    assert.ok(html.includes(">Open connection settings</a>"))
    assert.equal(html.includes(">Connect Google Drive<"), false)
    assert.equal(html.includes("grant access"), false)
    assert.equal(html.includes("not been granted"), false)
  }
})

test("a missing match without a settings destination offers admin review rather than inventing a grant failure", () => {
  const html = renderConnectAction([])
  assert.ok(html.includes("verify an account to connect here."))
  assert.ok(html.includes("Ask an admin to review setup and access."))
  assert.equal(html.includes("<a"), false)
  assert.equal(html.includes(">Connect Google Drive<"), false)
  assert.equal(html.includes("grant access"), false)
})

test("a known connection keeps its existing connection-specific legacy Connect action", () => {
  const html = renderConnectAction([{ id: "known-google", name: "Google Workspace", app: "gmail", nativeProviderKey: "google-workspace", ready: false, connectMode: "external", connectUrl: "https://den.example.test/dashboard/your-connections?connectionId=known-google" }], "https://den.example.test/dashboard/your-connections")
  assert.ok(html.includes(">Connect Google Drive</button>"))
  assert.equal(html.includes("Open connection settings"), false)
  assert.equal(html.includes("verify an account to connect here"), false)
})
