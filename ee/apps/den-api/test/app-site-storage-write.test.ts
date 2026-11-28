import assert from "node:assert/strict"
import { test } from "node:test"
import { setImmediate } from "node:timers/promises"
import { runInNewContext } from "node:vm"

process.env.DATABASE_URL ??= "mysql://test:test@127.0.0.1:3306/app_site_unit_test"
process.env.BETTER_AUTH_URL ??= "http://unit.test"
process.env.BETTER_AUTH_SECRET ??= "synthetic-app-site-unit-test-secret"
process.env.DEN_DB_ENCRYPTION_KEY ??= "synthetic-app-site-unit-test-encryption-key"
process.env.OPENWORK_DEV_MODE ??= "1"
process.env.DEN_APP_MCP_SERVERS_ENABLED = "true"

const { appSiteResponse } = await import("../src/mcp/app-site.js")
const response = await appSiteResponse({ appIdOrName: "test", publicOnly: false })
assert.ok(response)
const script = (await response.text()).match(/<script>([\s\S]*?)<\/script>/u)?.[1]
assert.ok(script)

async function mount({ marked, active, toolName = "storage_write" }: { marked: boolean; active: boolean; toolName?: string }) {
  const launch = { name: "open_app", _meta: { ui: { resourceUri: "ui://test/app" } } }
  const tool = { name: toolName, ...(marked ? { _meta: { "openwork/storage": "write" } } : {}) }
  const write = Promise.withResolvers<void>()
  const ready = Promise.withResolvers<void>()
  const replies = new Map<number, unknown>()
  const contentWindow = { postMessage: (message: { id: number }) => replies.set(message.id, JSON.parse(JSON.stringify(message))) }
  const preview = { hidden: false }
  const frame = { contentWindow, hidden: true, set srcdoc(_html: string) { ready.resolve() } }
  let onMessage: ((event: { source: unknown; data: unknown }) => void) | undefined
  let calls = 0
  const rpcResult = (result: unknown) => Response.json({ result })
  runInNewContext(script ?? "", {
    document: {
      documentElement: { dataset: { mode: "member" } },
      getElementById: (id: string) => ({ app: frame, preview, status: {} })[id === "app" || id === "preview" ? id : "status"],
    },
    location: { pathname: "/artifact", search: "" },
    URLSearchParams,
    navigator: { userActivation: { isActive: active } },
    matchMedia: () => ({ matches: false, addEventListener() {} }),
    addEventListener: (type: string, listener: typeof onMessage) => { if (type === "message") onMessage = listener },
    fetch: async (url: string, { body }: { body: string }) => {
      if (url === "/v1/mcp/token") return Response.json({ token: "unit-test-token" })
      const rpc = JSON.parse(body)
      if (rpc.method === "tools/list") return rpcResult({ tools: [launch, tool] })
      if (rpc.method === "resources/read") return rpcResult({ contents: [{ text: "<p>Test</p>" }] })
      if (rpc.method === "tools/call" && rpc.params.name === "open_app") return rpcResult({})
      assert.equal(rpc.method, "tools/call")
      assert.equal(rpc.params.name, toolName)
      calls += 1
      await write.promise
      return rpcResult({ saved: true })
    },
  })
  await ready.promise
  assert.equal(frame.hidden, false)
  assert.equal(preview.hidden, true)
  return {
    call(id: number) {
      assert.ok(onMessage)
      onMessage({ source: contentWindow, data: { jsonrpc: "2.0", id, method: "tools/call", params: { name: toolName } } })
    },
    async finish() {
      write.resolve()
      await setImmediate()
    },
    replies,
    calls: () => calls,
  }
}

const result = (id: number) => ({ jsonrpc: "2.0", id, result: { saved: true } })
const refusal = (id: number, message: string) => ({ jsonrpc: "2.0", id, error: { code: -32000, message } })

test("an unmarked storage_write tool does not require activation", async () => {
  const page = await mount({ marked: false, active: false })
  page.call(1)
  await page.finish()
  assert.equal(page.calls(), 1)
  assert.deepEqual(page.replies.get(1), result(1))
})

test("a marked write without activation is refused before fetch, regardless of name", async () => {
  const page = await mount({ marked: true, active: false, toolName: "save" })
  page.call(1)
  assert.equal(page.calls(), 0)
  assert.deepEqual(page.replies.get(1), refusal(1, "Saving needs a click on a button in this artifact."))
})

test("an activated marked write reaches fetch; another is refused until it settles", async () => {
  const page = await mount({ marked: true, active: true })
  page.call(1)
  assert.equal(page.calls(), 1)
  assert.equal(page.replies.has(1), false)
  page.call(2)
  assert.equal(page.calls(), 1)
  assert.deepEqual(page.replies.get(2), refusal(2, "Still saving the last change. Try again in a moment."))
  await page.finish()
  assert.deepEqual(page.replies.get(1), result(1))
  page.call(3)
  await page.finish()
  assert.equal(page.calls(), 2)
  assert.deepEqual(page.replies.get(3), result(3))
})
