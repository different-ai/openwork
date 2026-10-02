import { serve } from "@hono/node-server"
import { createApp } from "./app.js"
import { loadConfig } from "./config.js"
import { FILE_TOOL_NAMES } from "./files.js"
import { remoteMcpConnector } from "./mcp.js"
import { anthropicModel, fetchGatewayModels, openAIModel, type ModelOption } from "./model.js"
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

// The Gateway's model list, cached for five minutes; on failure only the default model is offered.
let cachedModels: { at: number; models: ModelOption[] } | null = null
async function models() {
  const fallback = [{ id: config.model.model, name: config.model.model }]
  if (!config.model.defaultApiKey) return { defaultModel: config.model.model, models: fallback }
  if (!cachedModels || Date.now() - cachedModels.at > 5 * 60_000) {
    try {
      cachedModels = {
        at: Date.now(),
        models: await fetchGatewayModels({
          baseUrl: config.model.baseUrl,
          protocol: config.model.protocol,
          apiKey: config.model.defaultApiKey,
        }),
      }
    } catch {
      return { defaultModel: config.model.model, models: fallback }
    }
  }
  return { defaultModel: config.model.model, models: cachedModels.models.length ? cachedModels.models : fallback }
}

const server = serve({ fetch: createApp({ store, runner, apiToken: config.apiToken, models }).fetch, port: config.port }, (info) => {
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
