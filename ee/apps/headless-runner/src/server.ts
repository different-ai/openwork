import { serve } from "@hono/node-server"
import { createApp } from "./app.js"
import { SessionEvents } from "./events.js"
import { diskBlobStore, s3BlobStore, vercelBlobStore } from "./blobs.js"
import { REACTION_TOOL_NAMES } from "./reactions.js"
import { TASK_TOOL_NAMES } from "./tasks.js"
import { mediaTypeFor, SavedFiles, SAVED_FILE_TOOL_NAMES } from "./saved-files.js"
import { loadConfig } from "./config.js"
import { FILE_TOOL_NAMES } from "./files.js"
import { remoteMcpConnector } from "./mcp.js"
import { anthropicModel, fetchGatewayModels, openAIModel, type ModelOption } from "./model.js"
import { Runner } from "./runner.js"
import { Store } from "./store.js"
import { readToolFile } from "./tool-files.js"
import type { SessionComputer } from "./types.js"

const config = loadConfig()
const store = new Store(config.dbPath)
const recovered = store.recoverInterruptedTurns()
const events = new SessionEvents()
const blobs =
  config.files.kind === "disk"
    ? diskBlobStore(config.files.directory)
    : config.files.kind === "s3"
      ? s3BlobStore(config.files)
      : config.files.kind === "vercel"
        ? await vercelBlobStore(config.files)
        : null
const files = blobs ? new SavedFiles(store, blobs, config.fileLimits) : undefined
// The computer and its provider SDK load only when configured, so a runner without one never imports them.
let computer: SessionComputer | undefined
if (config.computer) {
  const { Computers, createComputerProvider } = await import("@openwork-ee/headless-computer")
  computer = new Computers({ ...config.computer, provider: await createComputerProvider(config.computer) }, {
    files,
    readFile: (file, counts) => readToolFile({ name: file.name, mimeType: mediaTypeFor(file.name), data: Buffer.from(file.bytes).toString("base64") }, counts),
  })
}
store.onChange = (sessionId, messageId, status) => events.emit(sessionId, { type: "changed", messageId, ...(status ? { status } : {}) })

const runner = new Runner({
  store,
  model:
    config.model.protocol === "anthropic"
      ? anthropicModel({ baseUrl: config.model.baseUrl, maxOutputTokens: config.model.maxOutputTokens })
      : openAIModel({ baseUrl: config.model.baseUrl, maxOutputTokens: config.model.maxOutputTokens }),
  defaultModel: config.model.model,
  defaultModelApiKey: config.model.defaultApiKey,
  mcp: config.mcp
    ? remoteMcpConnector({
        url: config.mcp.url,
        allowlist: config.mcp.toolAllowlist,
        reservedNames: new Set([...FILE_TOOL_NAMES, ...SAVED_FILE_TOOL_NAMES, ...REACTION_TOOL_NAMES, ...TASK_TOOL_NAMES, ...(computer?.toolNames ?? [])]),
      })
    : undefined,
  limits: config.limits,
  systemPrompt: config.systemPrompt,
  events,
  files,
  computer,
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

const server = serve({ fetch: createApp({ store, runner, apiToken: config.apiToken, models, events, files, computer }).fetch, port: config.port }, (info) => {
  console.log(
    `[headless-runner] listening on :${info.port} (${recovered} interrupted turn(s) recovered, files: ${blobs?.kind ?? "off"}, computer: ${computer ? `${config.computer?.kind} ${computer.image}` : "off"})`,
  )
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
