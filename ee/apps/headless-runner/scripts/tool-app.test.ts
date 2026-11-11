import assert from "node:assert/strict"
import { test } from "node:test"
import { formatToolResult } from "../src/mcp.js"
import { messageSchema } from "../src/types.js"

const APP_ID = "cob_01kq8z0000000000000000000a"
const launch = { connectionId: APP_ID, toolName: "open_app", resourceUri: `ui://openwork/apps/${APP_ID}/rev`, arguments: { input: {} } }
const created = {
  content: [{ type: "text", text: "Created Hello World Wave. If you are in OpenWork, the App opens in a tab in the right sidebar." }],
  structuredContent: { app: { appId: APP_ID, title: "Hello World Wave" }, input: {}, mcpUrl: `https://den.example/mcp/agent/connections/${APP_ID}`, launch },
  _meta: { "openwork/mcpApp": launch },
}

test("a result that opens an App built in OpenWork keeps the App's id and name; the model's text is unchanged", async () => {
  const result = await formatToolResult(created)
  assert.deepEqual(result.app, { id: APP_ID, title: "Hello World Wave" })
  assert.equal(result.output, created.content[0]?.text)
  // The reference is stored with the tool message, so a later read can show the App.
  const stored = messageSchema.parse({ role: "tool", callId: "c1", name: "create_app", output: result.output, isError: false, app: result.app })
  assert.deepEqual(stored.role === "tool" ? stored.app : null, { id: APP_ID, title: "Hello World Wave" })
})

test("only a successful launch of an App's own open_app counts", async () => {
  // An ordinary result, a failed one, and an App a connected service brings (another launch tool) keep nothing.
  assert.equal((await formatToolResult({ content: [{ type: "text", text: "ok" }] })).app, undefined)
  assert.equal((await formatToolResult({ ...created, isError: true })).app, undefined)
  const provider = { ...created, _meta: { "openwork/mcpApp": { ...launch, connectionId: "emc_1", toolName: "show_dashboard" } } }
  assert.equal((await formatToolResult(provider)).app, undefined)
  // Without a summary the App still shows, under a name the page fills in.
  assert.deepEqual((await formatToolResult({ content: [], _meta: created._meta })).app, { id: APP_ID, title: "" })
})
