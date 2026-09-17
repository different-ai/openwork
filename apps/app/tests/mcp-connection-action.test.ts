import { afterEach, expect, spyOn, test } from "bun:test"
import { createOpenworkServerClient, type OpenworkMcpAppResource, type OpenworkMcpAppToolResult } from "../src/app/lib/openwork-server"
import { createMcpAppActions } from "../src/components/chat/mcp-app-origin"
import { createConnectionActionController, hasHostConnectionActions, standardMcpToolResult } from "../src/components/chat/mcp-connection-action"
import type { ChatConnectionDecisionBinding } from "../src/react-app/domains/session/surface/mcp-chat-reconnect"
import type { ChatToolReconnectCallbacks } from "../src/components/tools/use-chat-tool-reconnect"

let sequence = 0
const restores: Array<() => void> = []
afterEach(() => { restores.splice(0).forEach(restore => restore()) })

function fixture() {
  const scope = `scope-${++sequence}`
  const events: string[] = []
  const app: OpenworkMcpAppResource & { hostConnectionActions: boolean } = {
    launchId: "launch", serverName: "openwork-cloud", toolName: "connection_action",
    resourceUri: "ui://openwork/connection-action/v2/view.html", html: "", prefersBorder: false,
    csp: { connectDomains: [], resourceDomains: [], frameDomains: [], baseUriDomains: [] }, hostConnectionActions: true,
  }
  const connection = { schemaVersion: "1", connectionId: "connection", connectionName: "Fixture", state: "needs_connection",
    actor: "member", message: "Connect Fixture", action: { type: "connect", label: "Authenticate", surface: "openwork_your_connections" } }
  const intent = (action = "authenticate") => ({ schemaVersion: "1", kind: "connection_action_intent", action, connection })
  let response: OpenworkMcpAppToolResult & { hostAction?: unknown } = { content: [], hostAction: intent() }
  let pending = true
  let decision: ChatConnectionDecisionBinding | null = {
    request: { owner: scope, sessionId: "session", turnId: "turn", requestId: "request", toolCallId: "tool", connectionId: "connection" },
    isPending: () => pending,
    respond: async value => { events.push(value.outcome); pending = false },
  }
  let blocked = false
  let currentScope = scope
  let reconnect: NonNullable<ChatToolReconnectCallbacks["onReconnect"]> = async (_action, progress, isCurrent) => {
    events.push("oauth")
    progress({ phase: "authorization_opened", authorizeUrl: "https://private.example/token" })
    expect(isCurrent?.()).toBe(true)
    return "connected"
  }
  const client = createOpenworkServerClient({ baseUrl: "https://server.example", token: "fixture" })
  const server = spyOn(client, "callMcpAppTool").mockImplementation(async () => { events.push("server"); return response })
  restores.push(() => server.mockRestore())
  const origin = { client, workspaceId: "workspace", sessionId: "session", readOnly: false }
  const actions = createMcpAppActions(origin, app)
  const controller = createConnectionActionController({ scope, sessionId: "session", toolCallId: "tool", connectionId: "connection",
    current: () => ({ scope: currentScope, blocked, decision, onReconnect: reconnect }) })
  return { app, actions, controller, events, server, intent, origin,
    call: (action = "authenticate", click = true) => controller.callTool(actions, app, "connection_action_intent", { connectionId: "connection", action }, click),
    setResponse: (value: typeof response) => { response = value },
    setDecision: (value: ChatConnectionDecisionBinding | null) => { decision = value },
    getDecision: () => decision,
    setReconnect: (value: typeof reconnect) => { reconnect = value },
    block: () => { blocked = true }, changeScope: () => { currentScope = "foreign" },
  }
}

test("real server call precedes host OAuth and native response; iframe outcome contains no authorization URL", async () => {
  const f = fixture()
  const result = await f.call()
  expect(f.events).toEqual(["server", "oauth", "connected"])
  expect(result.structuredContent).toMatchObject({ outcome: "connected", questionAnswered: true })
  expect(JSON.stringify(result)).not.toContain("private.example")
  expect(result).not.toHaveProperty("hostAction")
  await expect(f.call()).rejects.toThrow()
  expect(f.events.filter(event => event === "oauth")).toHaveLength(1)
})

test.each(["structuredContent", "_meta"])("a provider intent in %s cannot invoke native OAuth", async field => {
  const f = fixture()
  f.setResponse({ content: [], [field]: { hostAction: f.intent() } })
  await f.call()
  expect(f.events).toEqual(["server"])
})

test("no host authentication before a trusted single-use click", async () => {
  const f = fixture()
  await expect(f.call("authenticate", false)).rejects.toThrow()
  expect(f.events).toEqual(["server"])
})

test("matching URI without verified resource capability cannot authorize native handling", async () => {
  const f = fixture()
  f.app.hostConnectionActions = false
  expect(hasHostConnectionActions(f.app)).toBe(false)
  await expect(f.call()).rejects.toThrow()
  expect(f.events).toEqual(["server"])
})

test.each(["foreign", "malformed", "action", "helper"])("fails closed for %s intents", async mode => {
  const f = fixture()
  f.setResponse({ content: [], hostAction: mode === "foreign" ? { ...f.intent(), connection: { ...f.intent().connection, connectionId: "foreign" } }
    : mode === "malformed" ? { ...f.intent(), schemaVersion: "2" } : mode === "action" ? f.intent("skip") : f.intent() })
  await expect(mode === "helper" ? f.controller.callTool(f.actions, f.app, "other", { connectionId: "connection", action: "authenticate" }, true) : f.call()).rejects.toThrow()
  expect(f.events).toEqual(["server"])
})

test("skip answers the original native question", async () => {
  const f = fixture()
  f.setResponse({ content: [], hostAction: f.intent("skip") })
  expect((await f.call("skip")).structuredContent).toMatchObject({ outcome: "skipped", questionAnswered: true })
  expect(f.events).toEqual(["server", "skipped"])
})

test("skip and authentication race produces one host decision", async () => {
  const f = fixture()
  let finish: (() => void) | undefined
  const wait = new Promise<void>(resolve => { finish = resolve })
  f.setReconnect(async () => { f.events.push("oauth"); await wait; return "connected" })
  const authentication = f.call()
  await Promise.resolve()
  await Promise.resolve()
  f.setResponse({ content: [], hostAction: f.intent("skip") })
  await expect(f.call("skip")).rejects.toThrow()
  finish?.()
  await authentication
  expect(f.events.filter(event => event === "connected" || event === "skipped")).toEqual(["connected"])
})

test.each(["authenticate", "skip"])("%s without pending binding never claims a question was answered", async action => {
  const f = fixture()
  f.setDecision(null)
  f.setResponse({ content: [], hostAction: f.intent(action) })
  expect((await f.call(action)).structuredContent).toMatchObject({ questionAnswered: false })
  expect(f.events).toEqual(action === "authenticate" ? ["server", "oauth"] : ["server"])
})

test("a pending binding can arrive without replacing the controller", async () => {
  const f = fixture()
  const decision = f.getDecision()
  f.setDecision(null)
  f.controller.observeBinding()
  f.setDecision(decision)
  f.controller.observeBinding()
  expect((await f.call()).structuredContent).toMatchObject({ questionAnswered: true })
})

test("an old source cannot bind to a different question", async () => {
  const f = fixture()
  f.controller.observeBinding()
  const decision = f.getDecision()
  if (!decision) throw new Error("Missing fixture")
  f.setDecision({ ...decision, request: { ...decision.request, requestId: "new-question" } })
  await expect(f.call()).rejects.toThrow()
  expect(f.events).toEqual(["server"])
})

test.each(["question", "scope", "readonly", "closed", "callback"])("late OAuth completion after %s change cannot answer a question", async mode => {
  const f = fixture()
  f.setReconnect(async () => {
    if (mode === "question") f.setDecision(null)
    if (mode === "scope") f.changeScope()
    if (mode === "readonly") f.block()
    if (mode === "closed") f.actions.dispose()
    if (mode === "callback") f.setReconnect(async () => "connected")
    return "connected"
  })
  await expect(f.call()).rejects.toThrow()
  expect(f.events).toEqual(["server"])
})

test.each(["readonly", "closed"])("%s origin prevents the real action and OAuth", async mode => {
  const f = fixture()
  if (mode === "readonly") f.origin.readOnly = true
  else f.actions.dispose()
  await expect(f.call()).rejects.toThrow()
  expect(f.events).toEqual([])
})

test("server denial never invokes host OAuth", async () => {
  const f = fixture()
  f.server.mockRejectedValue(new Error("Denied"))
  await expect(f.call()).rejects.toThrow("Denied")
  expect(f.events).toEqual([])
})

test("closing the origin while the real server is running blocks native handling", async () => {
  const f = fixture()
  f.server.mockImplementation(async () => {
    f.events.push("server")
    f.actions.dispose()
    return { content: [], hostAction: f.intent() }
  })
  await expect(f.call()).rejects.toThrow()
  expect(f.events).toEqual(["server"])
})

test("host OAuth errors never expose authorization secrets to the iframe", async () => {
  const f = fixture()
  f.setReconnect(async () => { throw new Error("https://private.example/?token=private-token") })
  await expect(f.call()).rejects.toThrow("Sign-in could not be completed. Check the connection in Settings > Library.")
})

test("generic results keep standard fields but strip the internal root", () => {
  const result = { content: [{ type: "text", text: "ordinary" }], structuredContent: { value: 1 }, _meta: { provider: true }, hostAction: { secret: true } }
  expect(standardMcpToolResult(result)).toEqual({ content: result.content, structuredContent: result.structuredContent, _meta: result._meta })
})
