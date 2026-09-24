import { test } from "node:test"
import assert from "node:assert/strict"
import { renderToStaticMarkup } from "react-dom/server"
import { App } from "@modelcontextprotocol/ext-apps"
import { ConnectionView, connectionResultSchema, requestConnectionAction } from "../src/connection-view"
import { callTool, openLink, parseToolResult, toolResultHandlers } from "../src/shared/result"

const connection = {
  schemaVersion: "1", connectionId: "emc_fixture", connectionName: "Fixture", state: "needs_connection",
  actor: "member", message: "Sign in to use this connection.",
  action: { type: "connect", label: "Connect Fixture", surface: "openwork_your_connections", url: "https://example.com/connections/emc_fixture" },
}
const hostContext = { experimental: { "openwork/connection-actions": true } }

test("shared result handlers render validated payloads, escape untrusted text, and clear errors and cancellation", () => {
  const app = new App({ name: "test", version: "1" }, {}, { autoResize: false })
  let rendered = ""
  const handlers = toolResultHandlers(connectionResultSchema,
    payload => { rendered = renderToStaticMarkup(<ConnectionView payload={payload} app={app} hostContext={hostContext} />) },
    message => { rendered = message },
  )
  handlers.ontoolresult({ structuredContent: connection })
  assert.match(rendered, /Connect Fixture for account access/)
  handlers.ontoolresult({ content: [{ type: "text", text: JSON.stringify({ ...connection, connectionName: "<img src=x onerror=alert(1)>" }) }] })
  assert.match(rendered, /&lt;img/)
  assert.doesNotMatch(rendered, /<img/)
  for (const invalid of [{ ...connection, schemaVersion: "2" }, { ...connection, connectionName: "" }, { ...connection, action: {} }]) {
    handlers.ontoolresult({ structuredContent: invalid })
    assert.match(rendered, /No valid result/)
    assert.doesNotMatch(rendered, /Fixture/)
  }
  handlers.ontoolresult({ isError: true, structuredContent: { ...connection, state: "connected", action: null } })
  assert.match(rendered, /tool failed/)
  handlers.ontoolresult({ structuredContent: connection })
  handlers.ontoolcancelled()
  assert.equal(rendered, "Cancelled")
  handlers.ontoolresult({ structuredContent: connection })
  assert.match(rendered, /Connect Fixture for account access/)
})

test("initial search wrapper and valid error remediation render through the same parser", () => {
  const acceptError = (payload: ReturnType<typeof connectionResultSchema.parse>) => payload.state !== "connected" && payload.action !== null
  for (const structuredContent of [connection, { connectionAction: connection }, { connectionStatus: connection }]) {
    const payload = parseToolResult(connectionResultSchema, { structuredContent, isError: true }, acceptError)
    assert.equal(payload.connectionId, connection.connectionId)
    assert.equal(payload.action?.url, connection.action.url)
  }
  assert.throws(() => parseToolResult(connectionResultSchema, { isError: true, structuredContent: { ...connection, state: "connected", action: null } }, acceptError))
  assert.throws(() => parseToolResult(connectionResultSchema, { isError: true, structuredContent: { connectionAction: {} } }, acceptError))
})

test("connection view uses host support without guessing a connected outcome", () => {
  const app = new App({ name: "test", version: "1" }, {}, { autoResize: false })
  const payload = connectionResultSchema.parse(connection)
  const native = renderToStaticMarkup(<ConnectionView payload={payload} app={app} hostContext={{ experimental: { "openwork/connection-actions": true } }} />)
  assert.match(native, /Authenticate/)
  assert.match(native, /Skip/)
  assert.match(native, /<h1>Connect Fixture for account access<\/h1>/)
  assert.match(native, /<details><summary>Access details<\/summary>/)
  assert.match(native, /Review the requested permissions on the provider’s sign-in screen\./)
  assert.match(native, /You can disconnect this connection in settings\./)
  assert.match(native, /Skip continues without connecting\./)
  assert.doesNotMatch(native, /<details open|role="status"|Sign in to use this connection|send|post|delete/)
  assert.doesNotMatch(native, /Fixture connected/)
  const fallback = renderToStaticMarkup(<ConnectionView payload={payload} app={app} hostContext={undefined} />)
  assert.match(fallback, /Open connections/)
  assert.doesNotMatch(fallback, /Authenticate|Fixture connected|Skip continues without connecting/)
  const reconnect = connectionResultSchema.parse({ ...connection, state: "reauth_required", action: { ...connection.action, type: "reconnect" } })
  const reconnectHtml = renderToStaticMarkup(<ConnectionView payload={reconnect} app={app} hostContext={{ experimental: { "openwork/connection-actions": true } }} />)
  assert.match(reconnectHtml, /<h1>Connect Fixture for account access<\/h1>/)
  assert.match(reconnectHtml, /<details><summary>Access details<\/summary>/)
  const connected = connectionResultSchema.parse({ ...connection, state: "connected", actor: null, action: null })
  const connectedHtml = renderToStaticMarkup(<ConnectionView payload={connected} app={app} hostContext={undefined} />)
  assert.match(connectedHtml, /<h1>Fixture connected<\/h1>/)
  assert.doesNotMatch(connectedHtml, /Access details|Authenticate|Skip/)
  const unsafe = connectionResultSchema.parse({ ...connection, action: { ...connection.action, url: "javascript:alert(1)" } })
  const blocked = renderToStaticMarkup(<ConnectionView payload={unsafe} app={app} hostContext={undefined} />)
  assert.match(blocked, /disabled=""/)
  assert.match(blocked, /Sign in to use this connection/)
  assert.doesNotMatch(blocked, /javascript:/)
})

test("connection outcomes require a matching validated host receipt, not just an accepted intent", async () => {
  const intent = { schemaVersion: "1", kind: "connection_action_intent", action: "authenticate", connection }
  const accepted: Pick<App, "callServerTool"> = { callServerTool: async () => ({ content: [], structuredContent: intent }) }
  await assert.rejects(requestConnectionAction(accepted, connection.connectionId, "authenticate"))
  for (const structuredContent of [
    { ...intent, outcome: "skipped" },
    { ...intent, outcome: "connected", action: "skip" },
    { ...intent, outcome: "connected", connection: { ...connection, connectionId: "emc_other" } },
    { ...intent, outcome: "connected", kind: "unverified" },
  ]) {
    await assert.rejects(requestConnectionAction({ callServerTool: async () => ({ content: [], structuredContent }) }, connection.connectionId, "authenticate"))
  }
  assert.equal(await requestConnectionAction({ callServerTool: async () => ({ content: [], structuredContent: { ...intent, outcome: "connected" } }) }, connection.connectionId, "authenticate"), "connected")
})

test("shared helpers call SDK methods with JSON-safe user intent and validated links", async () => {
  const calls: unknown[] = []
  const host: Pick<App, "callServerTool" | "openLink"> = {
    async callServerTool(request) {
      calls.push(request)
      return { content: [], structuredContent: { outcome: "skipped" } }
    },
    async openLink(request) {
      calls.push(request)
      return {}
    },
  }
  const result = await callTool(host, "connection_action_intent", { connectionId: "emc_fixture", action: "skip" })
  assert.deepEqual(result.structuredContent, { outcome: "skipped" })
  assert.deepEqual(calls[0], {
    name: "connection_action_intent", arguments: { connectionId: "emc_fixture", action: "skip" },
  })
  await openLink(host, connection.action.url)
  assert.deepEqual(calls[1], { url: connection.action.url })
  for (const url of ["javascript:alert(1)", "data:text/html,unsafe", "file:///tmp/fixture", "https://user:secret@example.com/"]) {
    await assert.rejects(openLink(host, url))
  }
  assert.equal(calls.length, 2)
  await assert.rejects(callTool({ callServerTool: async () => ({ content: [], isError: true }) }, "connection_action_intent", {}))
  await assert.rejects(openLink({ openLink: async () => ({ isError: true }) }, connection.action.url))
})
