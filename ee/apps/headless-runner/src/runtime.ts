import { createApp } from "./app.js"
import { BackgroundJobs } from "./background.js"
import { SessionEvents } from "./events.js"
import { diskBlobStore, s3BlobStore } from "./blobs.js"
import { denResumeClient } from "./den-resume.js"
import { denIndexClient, denIndexJob, type IndexOutbox } from "./den-index.js"
import { createErrorReporter } from "./error-reporting.js"
import { REACTION_TOOL_NAMES } from "./reactions.js"
import { TASK_TOOL_NAMES } from "./tasks.js"
import { mediaTypeFor, SavedFiles, SAVED_FILE_TOOL_NAMES } from "./saved-files.js"
import type { Config } from "./config.js"
import { FILE_TOOL_NAMES } from "./files.js"
import { remoteMcpConnector } from "./mcp.js"
import { anthropicModel, createModelAdapter, openAIModel, openAIResponsesModel } from "./model.js"
import { gatewayModelCatalog } from "./model-catalog.js"
import { createModelProbe } from "./model-probe.js"
export { gatewayModelCatalog } from "./model-catalog.js"
import { Runner } from "./runner.js"
import { workbotTelemetryReporter } from "./workbot-telemetry.js"
import type { Store } from "./store.js"
import { grantVault } from "./resume-grants.js"
import { SelfResume } from "./self-resume.js"
import { SessionStorage } from "./storage/index.js"
import { readToolFile } from "./tool-files.js"
import type { SessionComputer } from "./types.js"
import type { CellsStore } from "./cells-store.js"
import type { MemoryResolver } from "./memory.js"

export type StepHost = { stepAlarm: true; wake: () => void }

export type CellsHost = {
  memory?: MemoryResolver
  cells?: CellsStore
  indexHeld?: () => boolean
}

export async function createRuntime(config: Config, store: Store, stepHost?: StepHost, cellsHost: CellsHost = {}) {
  const errors = createErrorReporter(config.errorReporting)
  if (store.migrationError) {
    await errors.report({ code: "store_migration_failed", error: store.migrationError })
    throw store.migrationError
  }
  let recovered: number
  try {
    recovered = store.recoverInterruptedTurns()
  } catch (error) {
    await errors.report({ code: "startup_recovery_failed", error })
    throw error
  }
  const events = new SessionEvents()
  const background = new BackgroundJobs((job, error) => errors.report({ code: "background_job_failed", tags: { job }, error }))
  if (config.selfResume) {
    const held = cellsHost.indexHeld
    const outbox: IndexOutbox = held
      ? {
          pendingIndexUpdates: (now, limit) => (held() ? [] : store.pendingIndexUpdates(now, limit)),
          nextIndexUpdateAt: () => (held() ? null : store.nextIndexUpdateAt()),
          ackIndexUpdate: (sessionId, version) => store.ackIndexUpdate(sessionId, version),
          deferIndexUpdate: (sessionId, version, retryAt) => store.deferIndexUpdate(sessionId, version, retryAt),
          dropIndexUpdatesBefore: (createdBefore) => store.dropIndexUpdatesBefore(createdBefore),
          indexSnapshotAt: () => store.indexSnapshotAt(),
          indexSnapshotAll: (now) => store.indexSnapshotAll(now),
        }
      : store
    background.register(denIndexJob({ outbox, send: denIndexClient({ url: config.selfResume.denApiUrl, token: config.selfResume.callbackToken }), errors }))
  }
  const blobs = config.files.kind === "disk" ? diskBlobStore(config.files.directory) : config.files.kind === "s3" ? s3BlobStore(config.files) : null
  const files = blobs ? new SavedFiles(store, blobs, config.fileLimits) : undefined
  const storage = new SessionStorage(store, blobs, { ...config.storage, contextCharBudget: config.limits.contextCharBudget }, errors)
  for (const job of storage.jobs()) background.register(job)
  let computer: SessionComputer | undefined
  if (config.computer) {
    const { Computers, createComputerProvider } = await import("@openwork-ee/headless-computer")
    const computers = new Computers({
      ...config.computer, provider: await createComputerProvider(config.computer),
      pauses: { set: (sessionId, dueAt) => store.setComputerPause(sessionId, dueAt), clear: (sessionId) => store.clearComputerPause(sessionId) },
    }, {
      files,
      readFile: (file, counts) => readToolFile({ name: file.name, mimeType: mediaTypeFor(file.name), data: Buffer.from(file.bytes).toString("base64") }, counts),
    })
    background.register({
      name: "computer-pause",
      nextAt: () => store.nextComputerPauseAt(),
      run: async () => {
        for (const sessionId of store.dueComputerPauses(Date.now())) await computers.pauseIdle(sessionId)
      },
    })
    computer = computers
  }
  store.onChange = (sessionId, messageId, status) => events.emit(sessionId, { type: "changed", messageId, ...(status ? { status } : {}) })
  const modelFetch: typeof fetch = (input, init) => fetch(input, init)
  const resume = config.selfResume
    ? new SelfResume({
        store,
        vault: grantVault(config.selfResume.grantKey),
        exchange: denResumeClient({ url: config.selfResume.denApiUrl, token: config.selfResume.callbackToken }),
        errors,
      })
    : undefined
  const runner = new Runner({
    store,
    model:
      config.model.protocol === "anthropic"
        ? anthropicModel({ baseUrl: config.model.baseUrl, maxOutputTokens: config.model.maxOutputTokens, fetch: modelFetch })
        : config.model.protocol === "openai-responses"
          ? openAIResponsesModel({ baseUrl: config.model.baseUrl, maxOutputTokens: config.model.maxOutputTokens, fetch: modelFetch })
          : openAIModel({ baseUrl: config.model.baseUrl, maxOutputTokens: config.model.maxOutputTokens, fetch: modelFetch }),
    defaultModel: config.model.model,
    defaultModelApiKey: config.model.defaultApiKey,
    modelForAccess: (access) => createModelAdapter(access, { maxOutputTokens: config.model.maxOutputTokens, fetch: modelFetch }),
    mcp: config.mcp
      ? remoteMcpConnector({
          url: config.mcp.url,
          allowlist: config.mcp.toolAllowlist,
          reservedNames: new Set([...FILE_TOOL_NAMES, ...SAVED_FILE_TOOL_NAMES, ...REACTION_TOOL_NAMES, ...TASK_TOOL_NAMES, ...(computer?.toolNames ?? []), ...(computer?.desktopTools?.map(tool => tool.name) ?? [])]),
        })
      : undefined,
    limits: config.limits,
    systemPrompt: config.systemPrompt,
    events,
    files,
    computer,
    errors,
    workbotTelemetry: workbotTelemetryReporter(config),
    resume,
    storage,
    ...(cellsHost.memory ? { memory: cellsHost.memory } : {}),
    ...(stepHost ? { stepAlarm: stepHost.stepAlarm, wake: stepHost.wake } : {}),
  })
  const steps = runner.recoverSteps()
  const app = createApp({ store, runner, apiToken: config.apiToken, healthConfig: config, computerFleet: config, models: gatewayModelCatalog(config), modelProbe: createModelProbe(config, modelFetch), events, files, computer, errors, cells: cellsHost.cells, memory: cellsHost.memory, storage })
  return {
    app,
    runner,
    recovered,
    steps,
    blobKind: blobs?.kind ?? "off",
    computer,
    background,
    storage,
    events,
    selfResume: resume
      ? {
          sweep: () =>
            runner.selfResume().then(
              () => undefined,
              (error: unknown) => {
                console.error("[headless-runner] self-resume sweep failed", { error: error instanceof Error ? error.message : "unknown" })
                return errors.report({ code: "resume_sweep_failed", error })
              },
            ),
          nextSweepAt: () => resume.nextSweepAt(),
        }
      : undefined,
  }
}
