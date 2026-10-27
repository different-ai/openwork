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

/**
 * How the host runs step-mode turns' steps (see steps.ts). Without it (Node), each step runs as soon as it is due, in
 * this process. A cell passes `stepAlarm`: steps run from its durable alarm (`runner.runDueSteps`), and `wake` tells
 * it a step is due so it keeps that alarm set at `runner.nextStepAt()`.
 */
export type StepHost = { stepAlarm: true; wake: () => void }

/** What a cell host changes (src/worker): where owner-scoped memory lives, and its session-cell tables. */
export type CellsHost = {
  memory?: MemoryResolver
  cells?: CellsStore
  /** While true, nothing goes to the Den index from this cell (a moved chat waiting for its owner cell's handoff). */
  indexHeld?: () => boolean
}

/** Both hosts build the same runner, tools, file store and live events; only SQLite ownership differs. */
export async function createRuntime(config: Config, store: Store, stepHost?: StepHost, cellsHost: CellsHost = {}) {
  const errors = createErrorReporter(config.errorReporting)
  if (store.migrationError) {
    // The schema couldn't be brought up to date (storage/migrations.ts): stop here, as when recovery fails.
    await errors.report({ code: "store_migration_failed", error: store.migrationError })
    throw store.migrationError
  }
  let recovered: number
  try {
    recovered = store.recoverInterruptedTurns()
  } catch (error) {
    // Startup stops here; wait for the report (it gives up after a few seconds) before failing.
    await errors.report({ code: "startup_recovery_failed", error })
    throw error
  }
  const events = new SessionEvents()
  // Storage upkeep with no request (sealing, the Den index outbox, owner-cell splits); see background.ts.
  const background = new BackgroundJobs((job, error) => errors.report({ code: "background_job_failed", tags: { job }, error }))
  // Den's content-free session index: needs Den's address and the callback token.
  if (config.selfResume) {
    const held = cellsHost.indexHeld
    const outbox: IndexOutbox = held
      ? {
          pendingIndexUpdates: (now, limit) => (held() ? [] : store.pendingIndexUpdates(now, limit)),
          nextIndexUpdateAt: () => (held() ? null : store.nextIndexUpdateAt()),
          ackIndexUpdate: (sessionId, version) => store.ackIndexUpdate(sessionId, version),
          deferIndexUpdate: (sessionId, version, retryAt) => store.deferIndexUpdate(sessionId, version, retryAt),
          dropIndexUpdatesBefore: (createdBefore) => store.dropIndexUpdatesBefore(createdBefore),
          indexSnapshotAll: (now) => store.indexSnapshotAll(now),
        }
      : store
    background.register(denIndexJob({ outbox, send: denIndexClient({ url: config.selfResume.denApiUrl, token: config.selfResume.callbackToken }), errors }))
  }
  const blobs = config.files.kind === "disk" ? diskBlobStore(config.files.directory) : config.files.kind === "s3" ? s3BlobStore(config.files) : null
  const files = blobs ? new SavedFiles(store, blobs, config.fileLimits) : undefined
  // Sealed history and large outputs (storage/): sealing is off unless HEADLESS_SEGMENTS=on; reading always works.
  const storage = new SessionStorage(store, blobs, { ...config.storage, contextCharBudget: config.limits.contextCharBudget }, errors)
  for (const job of storage.jobs()) background.register(job)
  // Provider SDKs load only when configured, including on the Worker host.
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
    // Idle computers pause from the stored time, so a restart or a recycled cell isolate can't leave one running.
    background.register({
      name: "computer-pause",
      nextAt: () => store.nextComputerPauseAt(),
      run: async () => { for (const sessionId of store.dueComputerPauses(Date.now())) await computers.pauseIdle(sessionId) },
    })
    computer = computers
  }
  store.onChange = (sessionId, messageId, status) => events.emit(sessionId, { type: "changed", messageId, ...(status ? { status } : {}) })
  // A native Workers fetch needs its global receiver; model adapters invoke their injected fetch as a method.
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
  // Step-mode turns that startup recovery left going continue from their next step (never throws).
  const steps = runner.recoverSteps()
  const app = createApp({ store, runner, apiToken: config.apiToken, healthConfig: config, models: gatewayModelCatalog(config), modelProbe: createModelProbe(config, modelFetch), events, files, computer, errors, cells: cellsHost.cells, memory: cellsHost.memory, storage })
  return {
    app,
    runner,
    recovered,
    /** Step-mode turns continued after startup instead of interrupted, and those failed for unreadable state. */
    steps,
    blobKind: blobs?.kind ?? "off",
    computer,
    /** Storage upkeep jobs, for the host to run when due (a timer on Node, the durable alarm in a cell). */
    background,
    /** Session storage (sealed history, large bodies, object deletions), for a host that hands it a moved chat's. */
    storage,
    /** Live session events, for a host that also publishes them to its WebSockets (a celld cell). */
    events,
    /** Self-resume, for the host to run on its own schedule (a timer on Node, a durable alarm in a cell). */
    selfResume: resume
      ? {
          /** Resumes what it can now; never throws (a failure is reported by code). */
          sweep: () =>
            runner.selfResume().then(
              () => undefined,
              (error: unknown) => {
                console.error("[headless-runner] self-resume sweep failed", { error: error instanceof Error ? error.message : "unknown" })
                return errors.report({ code: "resume_sweep_failed", error })
              },
            ),
          /** When the next sweep is due, or null when nothing could need one. */
          nextSweepAt: () => resume.nextSweepAt(),
        }
      : undefined,
  }
}
