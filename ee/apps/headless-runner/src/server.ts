import { serve } from "@hono/node-server"
import { createApp } from "./app.js"
import { loadConfig } from "./config.js"
import { FILE_TOOL_NAMES } from "./files.js"
import { remoteMcpConnector } from "./mcp.js"
import { anthropicModel, openAIModel } from "./model.js"
import { Runner } from "./runner.js"
import { Store } from "./store.js"

const config = loadConfig()
const store = new Store(config.dbPath)
const recovered = store.recoverInterruptedTurns()

const runner = new Runner({
  store,
  model:
    config.model.protocol === "anthropic"
      ? anthropicModel({ baseUrl: config.model.baseUrl, maxOutputTokens: config.model.maxOutputTokens })
      : openAIModel({ baseUrl: config.model.baseUrl, maxOutputTokens: config.model.maxOutputTokens }),
  defaultModel: config.model.model,
  defaultModelApiKey: config.model.defaultApiKey,
  mcp: config.mcp
    ? remoteMcpConnector({ url: config.mcp.url, allowlist: config.mcp.toolAllowlist, reservedNames: FILE_TOOL_NAMES })
    : undefined,
  limits: config.limits,
  systemPrompt: config.systemPrompt,
})

const server = serve({ fetch: createApp({ store, runner, apiToken: config.apiToken }).fetch, port: config.port }, (info) => {
  console.log(`[headless-runner] listening on :${info.port} (${recovered} interrupted turn(s) recovered)`)
})

let stopping = false
async function stop(signal: string) {
  if (stopping) return
  stopping = true
  console.log(`[headless-runner] ${signal}: interrupting in-flight turns`)
  server.close()
  await runner.shutdown()
  store.close()
  process.exit(0)
}
process.on("SIGTERM", () => void stop("SIGTERM"))
process.on("SIGINT", () => void stop("SIGINT"))
