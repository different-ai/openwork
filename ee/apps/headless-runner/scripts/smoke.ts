/**
 * End-to-end smoke test against a real AI Gateway and OpenWork MCP.
 *
 *   HEADLESS_API_TOKEN=... HEADLESS_MODEL_PROTOCOL=anthropic \
 *   HEADLESS_MODEL_BASE_URL=https://gateway.openworklabs.com/api/v1/providers/<ipr> \
 *   HEADLESS_MODEL=<gwm alias> HEADLESS_MCP_URL=https://api.openworklabs.com/mcp/agent \
 *   SMOKE_MODEL_API_KEY=ow_gw_... SMOKE_MCP_TOKEN=... pnpm smoke "What's waiting on me?"
 *
 * Boots the real HTTP app on a random port with a throwaway database and
 * prints timings, token usage, and process memory. Never prints credentials.
 */
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { serve } from "@hono/node-server"
import { z } from "zod"
import { createApp } from "../src/app.js"
import { loadConfig } from "../src/config.js"
import { FILE_TOOL_NAMES } from "../src/files.js"
import { remoteMcpConnector } from "../src/mcp.js"
import { anthropicModel, openAIModel } from "../src/model.js"
import { Runner } from "../src/runner.js"
import { Store } from "../src/store.js"
import { nodeSqlite } from "../src/node-sqlite.js"

const prompt = process.argv.slice(2).join(" ") || "Use OpenWork to find what I can connect to, then write a short summary to notes/summary.md."
const config = loadConfig({ ...process.env, HEADLESS_DB_PATH: join(mkdtempSync(join(tmpdir(), "headless-smoke-")), "s.sqlite") })
const store = new Store(nodeSqlite(config.dbPath))
const runner = new Runner({
  store,
  model:
    config.model.protocol === "anthropic"
      ? anthropicModel({ baseUrl: config.model.baseUrl, maxOutputTokens: config.model.maxOutputTokens })
      : openAIModel({ baseUrl: config.model.baseUrl, maxOutputTokens: config.model.maxOutputTokens }),
  defaultModel: config.model.model,
  mcp: config.mcp ? remoteMcpConnector({ url: config.mcp.url, allowlist: config.mcp.toolAllowlist, reservedNames: FILE_TOOL_NAMES }) : undefined,
  limits: config.limits,
})
const server = serve({ fetch: createApp({ store, runner, apiToken: config.apiToken }).fetch, port: 0 })
await new Promise((resolve) => server.once("listening", resolve))
const address = server.address()
const base = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`
const headers = { authorization: `Bearer ${config.apiToken}`, "content-type": "application/json" }

const started = performance.now()
const session = z.object({ id: z.string() }).parse(
  await (await fetch(`${base}/v1/sessions`, { method: "POST", headers, body: JSON.stringify({ title: "smoke" }) })).json(),
)
const sent = await fetch(`${base}/v1/sessions/${session.id}/turns`, {
  method: "POST",
  headers,
  body: JSON.stringify({
    messageId: "msg_smoke",
    prompt,
    credentials: { modelApiKey: process.env.SMOKE_MODEL_API_KEY, mcpToken: process.env.SMOKE_MCP_TOKEN },
  }),
})
console.log("send:", sent.status, await sent.text())
await runner.idle()

const snapshot = z
  .object({
    turns: z.array(z.object({ status: z.string(), error: z.string().nullable(), usage: z.object({ inputTokens: z.number(), cachedInputTokens: z.number(), outputTokens: z.number() }) })),
    messages: z.array(z.object({ role: z.string(), name: z.string().optional(), isError: z.boolean().optional() })),
    finalAssistantText: z.string(),
  })
  .parse(await (await fetch(`${base}/v1/sessions/${session.id}`, { headers })).json())
const files = await (await fetch(`${base}/v1/sessions/${session.id}/files`, { headers })).json()

console.log("turn:", snapshot.turns[0])
console.log("tools used:", snapshot.messages.filter((m) => m.role === "tool").map((m) => `${m.name}${m.isError ? " (error)" : ""}`))
console.log("files:", JSON.stringify(files))
console.log("elapsed ms:", Math.round(performance.now() - started))
console.log("rss MB:", Math.round(process.memoryUsage().rss / 1024 / 1024))
console.log("\n--- answer ---\n" + snapshot.finalAssistantText)
server.close()
store.close()
