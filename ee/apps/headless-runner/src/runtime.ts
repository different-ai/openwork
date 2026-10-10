import { createApp } from "./app.js"
import { SessionEvents } from "./events.js"
import { diskBlobStore, s3BlobStore, vercelBlobStore } from "./blobs.js"
import { REACTION_TOOL_NAMES } from "./reactions.js"
import { TASK_TOOL_NAMES } from "./tasks.js"
import { mediaTypeFor, SavedFiles, SAVED_FILE_TOOL_NAMES } from "./saved-files.js"
import type { Config } from "./config.js"
import { FILE_TOOL_NAMES } from "./files.js"
import { remoteMcpConnector } from "./mcp.js"
import { anthropicModel, fetchGatewayModels, openAIModel, type ModelOption } from "./model.js"
import { Runner } from "./runner.js"
import type { Store } from "./store.js"
import { readToolFile } from "./tool-files.js"
import type { SessionComputer } from "./types.js"

/** Both hosts build the same runner, tools, file store and live events; only SQLite ownership differs. */
export async function createRuntime(config: Config, store: Store) {
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
  // Provider SDKs load only when configured, including on the Worker host.
  let computer: SessionComputer | undefined
  if (config.computer) {
    const { Computers, createComputerProvider } = await import("@openwork-ee/headless-computer")
    computer = new Computers({ ...config.computer, provider: await createComputerProvider(config.computer) }, {
      files,
      readFile: (file, counts) => readToolFile({ name: file.name, mimeType: mediaTypeFor(file.name), data: Buffer.from(file.bytes).toString("base64") }, counts),
    })
  }
  store.onChange = (sessionId, messageId, status) => events.emit(sessionId, { type: "changed", messageId, ...(status ? { status } : {}) })
  // A native Workers fetch needs its global receiver; model adapters invoke their injected fetch as a method.
  const modelFetch: typeof fetch = (input, init) => fetch(input, init)
  const runner = new Runner({
    store,
    model:
      config.model.protocol === "anthropic"
        ? anthropicModel({ baseUrl: config.model.baseUrl, maxOutputTokens: config.model.maxOutputTokens, fetch: modelFetch })
        : openAIModel({ baseUrl: config.model.baseUrl, maxOutputTokens: config.model.maxOutputTokens, fetch: modelFetch }),
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
  const app = createApp({ store, runner, apiToken: config.apiToken, models: gatewayModelCatalog(config), events, files, computer })
  return { app, runner, recovered, blobKind: blobs?.kind ?? "off", computer }
}

/** The Gateway's model list, cached for five minutes; on failure only the default model is offered. */
export function gatewayModelCatalog(config: Config) {
  let cachedModels: { at: number; models: ModelOption[] } | null = null
  return async () => {
    const fallback = [{ id: config.model.model, name: config.model.model }]
    if (!config.model.defaultApiKey) return { defaultModel: config.model.model, models: fallback }
    if (!cachedModels || Date.now() - cachedModels.at > 5 * 60_000) {
      try {
        cachedModels = {
          at: Date.now(),
          models: await fetchGatewayModels({ baseUrl: config.model.baseUrl, protocol: config.model.protocol, apiKey: config.model.defaultApiKey }),
        }
      } catch {
        return { defaultModel: config.model.model, models: fallback }
      }
    }
    return { defaultModel: config.model.model, models: cachedModels.models.length ? cachedModels.models : fallback }
  }
}
