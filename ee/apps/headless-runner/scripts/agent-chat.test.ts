import assert from "node:assert/strict"
import { createServer } from "node:http"
import { test } from "node:test"
import { getRequestListener } from "@hono/node-server"
import { createMcpHandler, Server } from "@modelcontextprotocol/server"
import { createHeadlessRunnerClient } from "@openwork-ee/headless-protocol"
import { createApp } from "../src/app.js"
import { agentChatMcpConnector } from "../src/mcp.js"
import { nodeSqlite } from "../src/node-sqlite.js"
import { Runner } from "../src/runner.js"
import { Store } from "../src/store.js"

const apiToken = "runner-service-token-0123456789-0123456789"
const agentChatToken = "standing-chat-token"
const sessionId = "hs_agent_example"
const sessionPath = `/v1/sessions/${sessionId}`
const usage = { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 }
const limits = { maxConcurrentTurns: 1, maxSteps: 3, turnTimeoutMs: Infinity, credentialRefreshMs: 0, contextCharBudget: 100_000 }
const basic = { defaultModel: "test", defaultModelApiKey: "test-model-key", limits }
const tools = ["search_capabilities", "execute_capability", "request_agent_connector_access", "execute_capability_script", "desktop", "bash", "start_task", "write_file", "read_file", "browser_open"]

function request(method: string, body?: unknown) {
  return { method, headers: { authorization: `Bearer ${apiToken}` }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }
}

async function listen(t: { after(fn: () => Promise<void>): void }, fetch: (request: Request) => Promise<Response>) {
  const server = createServer(getRequestListener(fetch))
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve))
  t.after(async () => {
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
  })
  const address = server.address()
  assert.ok(address && typeof address === "object")
  return `http://127.0.0.1:${address.port}`
}

function mcpHandler(calls: string[]) {
  return createMcpHandler(() => {
    const server = new Server({ name: "gateway", version: "1" }, { capabilities: { tools: {} } })
    server.setRequestHandler("tools/list", async () => ({ tools: tools.map(name => ({ name, inputSchema: { type: "object", properties: {} } })) }))
    server.setRequestHandler("tools/call", async ({ params }) => {
      calls.push(params.name)
      return { content: [{ type: "text", text: "Tool result" }] }
    })
    return server
  }, { legacy: "stateless" })
}

test("standing chat runs only the trusted Den tools and rejects forged local or generic dispatch", async (t) => {
  const calls: string[] = []
  const handler = mcpHandler(calls)
  t.after(() => handler.close())
  const origin = await listen(t, async (incoming) => {
    assert.equal(new URL(incoming.url).pathname, "/mcp/agent-chat")
    assert.equal(incoming.headers.get("authorization"), `Bearer ${agentChatToken}`)
    return handler.fetch(incoming)
  })
  const store = new Store(nodeSqlite(":memory:"))
  t.after(() => store.close())
  let completes = 0
  const runner = new Runner({ ...basic, store, systemPrompt: "Generic prompt must not be used", agentChatMcp: agentChatMcpConnector(`${origin}/mcp/agent`),
    mcp: async () => assert.fail("standing chat must not use generic MCP"),
    memory: () => assert.fail("standing chat must not resolve workspace memory"),
    model: { complete: async (input) => {
      assert.deepEqual(input.tools.map(tool => tool.name), tools.slice(0, 3))
      assert.ok(input.system.includes("standing OpenWork agent"))
      assert.ok(!input.system.includes("Generic prompt"))
      return { text: "Finished", toolCalls: completes++ === 0 ? tools.map(name => ({ name, id: name, input: {} })) : [], usage }
    } },
  })
  const app = createApp({ store, runner, apiToken })
  const client = createHeadlessRunnerClient({ config: { url: "https://runner.example.test", token: apiToken }, maxTokenTtlMs: 1000,
    mintToken: async () => assert.fail("should not mint a generic token"), fetch: (url, init) => app.request(String(url), init),
  })
  const created = await client.putSession(sessionId, { profile: "agent_chat", owner: "standing@example", title: "Standing agent" })
  assert.ok(created.ok)
  assert.equal((await app.request(sessionPath, request("PUT", { computer: true }))).status, 409)
  assert.equal((await app.request(sessionPath, request("PUT", { profile: "agent_chat", owner: "other" }))).status, 409)
  assert.equal((await app.request(sessionPath, request("PUT", { profile: "agent_chat", owner: "standing@example", files: true }))).status, 400)
  for (const path of ["files", "files/content", "saved-files", "saved-files/fl_example", "desktop/viewer", "computer"]) {
    assert.equal((await app.request(`${sessionPath}/${path}`, request(path === "computer" ? "DELETE" : path === "desktop/viewer" ? "POST" : "GET"))).status, 403)
  }
  for (const unsafe of [{ credentials: { mcpToken: "generic" } }, { credentials: { agentChatToken, resumeGrant: `hrg_${"A".repeat(43)}` } }, { execution: "steps" }, { attachments: [`fl_${"a".repeat(32)}`] }]) {
    assert.equal((await app.request(`${sessionPath}/turns`, request("POST", { messageId: "rejected", prompt: "Do work", credentials: { agentChatToken }, ...unsafe }))).status, 400)
  }
  const admitted = await client.sendAgentChatTurn({ sessionId, messageId: "first", prompt: "Check this", agentChatToken })
  assert.ok(admitted.ok)
  await runner.idle()
  assert.equal(completes, 2)
  assert.deepEqual(calls, tools.slice(0, 3))
  assert.deepEqual(store.listFiles(sessionId), [])
  assert.equal(store.getTurn(sessionId, "first")?.status, "completed")
  assert.equal(store.getTurn(sessionId, "first")?.profile, "agent_chat")
  const exported = store.exportConversation(sessionId)
  assert.ok(exported)
  assert.ok(!JSON.stringify(exported).includes(agentChatToken))
  const restored = new Store(nodeSqlite(":memory:"))
  t.after(() => restored.close())
  restored.importConversation(exported)
  assert.equal(restored.getSession(sessionId)?.profile, "agent_chat")
  restored.setTurnStatus(sessionId, "first", "interrupted", "runner_restarted")
  restored.setResumeGrant(sessionId, "first", "old-grant")
  assert.equal(restored.resumeGrantOf(sessionId, "first"), null)
  const restarted = new Runner({ ...basic, store: restored, agentChatMcp: async () => assert.fail("must not reopen an interrupted turn"),
    model: { complete: async () => assert.fail("must not restart model") },
  })
  const duplicate = restarted.send({ sessionId, messageId: "first", prompt: "Retry", credentials: { agentChatToken } })
  assert.ok(duplicate.ok)
  assert.equal(duplicate.state, "already_present")
  assert.equal(restored.getTurn(sessionId, "first")?.status, "interrupted")
})

test("standing chat gets its own computer only while the session says so", async (t) => {
  const handler = mcpHandler([])
  t.after(() => handler.close())
  const origin = await listen(t, (incoming) => handler.fetch(incoming))
  const store = new Store(nodeSqlite(":memory:"))
  t.after(() => store.close())
  const ran: string[] = []
  const offered: string[][] = []
  const bash = { name: "bash", description: "Run a command", inputSchema: { type: "object", properties: {} } }
  const runner = new Runner({ ...basic, store, agentChatMcp: agentChatMcpConnector(`${origin}/mcp/agent`),
    computer: { prompt: "", tools: [bash], toolNames: new Set(["bash"]), image: "test", known: () => false, prewarm: () => {}, release: () => {},
      delete: async () => {}, previewSavedFile: async () => {},
      run: async (_session, name) => { ran.push(name); return { output: "ok", isError: false } },
    },
    model: { complete: async (input) => {
      offered.push(input.tools.map(tool => tool.name))
      const first = offered.length % 2 === 1
      return { text: "Finished", toolCalls: first ? [{ name: "bash", id: `bash-${offered.length}`, input: {} }] : [], usage }
    } },
  })
  const app = createApp({ store, runner, apiToken })
  const put = (body: object) => app.request(sessionPath, request("PUT", { profile: "agent_chat", owner: "member", ...body }))
  const send = async (messageId: string) => {
    assert.ok(runner.send({ sessionId, messageId, prompt: "Count the rows", credentials: { agentChatToken } }).ok)
    await runner.idle()
  }
  assert.equal((await put({ computer: true })).status, 201)
  await send("on")
  assert.deepEqual(offered[0], [...tools.slice(0, 3), "bash"])
  assert.deepEqual(ran, ["bash"])
  assert.equal((await put({ computer: false })).status, 200)
  await send("off")
  assert.deepEqual([store.getTurn(sessionId, "off")?.status, store.getTurn(sessionId, "off")?.error, offered.length], ["completed", null, 4])
  assert.deepEqual(offered[2], tools.slice(0, 3))
  assert.deepEqual(ran, ["bash"])
  assert.equal((await app.request(`${sessionPath}/computer`, request("DELETE"))).status, 403)
})

test("standing chat never follows a redirect from the scoped MCP path", async (t) => {
  const paths: string[] = []
  const origin = await listen(t, async (incoming) => {
    paths.push(new URL(incoming.url).pathname)
    return Response.redirect(new URL("/mcp/agent", incoming.url), 307)
  })
  await assert.rejects(agentChatMcpConnector(origin)({ token: agentChatToken, signal: new AbortController().signal }))
  assert.deepEqual(paths, ["/mcp/agent-chat"])
})

test("the protocol does not fall back or accept success from a runner that ignores the profile", async () => {
  const requests: unknown[] = []
  const client = createHeadlessRunnerClient({ config: { url: "https://runner.example.test", token: apiToken }, maxTokenTtlMs: 1000,
    mintToken: async () => assert.fail("should not mint a generic token"),
    fetch: async (_url, init) => {
      requests.push(JSON.parse(String(init?.body)))
      return init?.method === "PUT" ? Response.json({ id: sessionId }) : Response.json({ state: "accepted" }, { status: 202 })
    },
  })
  assert.equal((await client.putSession(sessionId, { profile: "agent_chat", owner: "member" })).ok, false)
  assert.equal((await client.sendAgentChatTurn({ sessionId, messageId: "first", prompt: "Check", agentChatToken })).ok, false)
  assert.deepEqual(requests, [{ profile: "agent_chat", owner: "member" }, { messageId: "first", prompt: "Check", credentials: { agentChatToken } }])
})
