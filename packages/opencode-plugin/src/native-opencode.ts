/** Native OpenCode 2.0.26 mapping. No service discovery, server URL, or auth overrides. */
import { createHash } from "node:crypto"
import { realpath } from "node:fs/promises"
import { basename } from "node:path"
import {
  SessionRunnerError,
  sessionIdForCommand,
  type HarnessAdapter,
  type InventoryWorkspace,
  type Model,
  type Progress,
  type Receipt,
  type SessionError,
  type TranscriptMessage,
  type TranscriptToolCall,
} from "../../remote-sessions/src/index.ts"
import { isRecord } from "./den.ts"
import type { NativeAssistantContent, NativeMessage, NativeModelRef, NativePluginContext, NativeSessionInfo } from "./opencode.ts"

export function hasNativeSessionHost(ctx: NativePluginContext | import("./opencode.ts").PluginContext): ctx is NativePluginContext {
  return typeof ctx.session?.create === "function" && typeof ctx.session.get === "function"
    && typeof ctx.session.context === "function" && typeof ctx.session.prompt === "function"
    && typeof ctx.session.switchModel === "function" && typeof ctx.session.interrupt === "function"
    && typeof ctx.model?.list === "function" && typeof ctx.model.default === "function"
    && typeof ctx.permission?.list === "function"
}

export function nativeModel(model: Model): NativeModelRef {
  return { providerID: model.providerId, id: model.modelId, ...(model.variant ? { variant: model.variant } : {}) }
}

function remoteModel(model: NativeModelRef | undefined): Model | null {
  return model ? { providerId: model.providerID, modelId: model.id, variant: model.variant ?? null } : null
}

function digest(value: string): string { return createHash("sha256").update(value).digest("hex").slice(0, 24) }
function clipped(value: string, max: number): string { return value.slice(0, max) }
function errorOf(error: { type: string; message?: string } | undefined): SessionError | null {
  return error ? { code: clipped(error.type || "native_error", 60), message: clipped(error.message || "OpenCode reported an error.", 2000) } : null
}
function summary(value: unknown): string | null { return value === undefined ? null : clipped(JSON.stringify(value) ?? "", 2000) }

/** Only native mapping state: a prompt admitted to the durable inbox can precede context projection. */
interface Admission { messageId: string; baselineIdle: number | null; admitted: boolean }
function admission(value: unknown): Admission | null {
  if (!isRecord(value) || typeof value.messageId !== "string" || typeof value.admitted !== "boolean"
    || (value.baselineIdle !== null && typeof value.baselineIdle !== "number")) return null
  return { messageId: value.messageId, baselineIdle: value.baselineIdle, admitted: value.admitted }
}

export async function nativeWorkspace(ctx: NativePluginContext, workspaceId: string, signal: AbortSignal): Promise<InventoryWorkspace> {
  signal.throwIfAborted()
  const [models, selected] = await Promise.all([
    // The Promise host pins these reads to its own Location. Its LocationQuery
    // decoder accepts an object, never a directory string; no override is needed.
    ctx.model.list(),
    ctx.model.default(),
  ])
  signal.throwIfAborted()
  // Location responses carry their scope. Never advertise some other loaded Location's inventory.
  if (await realpath(models.location.directory) !== await realpath(ctx.location.directory)
    || await realpath(selected.location.directory) !== await realpath(ctx.location.directory)) {
    throw new SessionRunnerError("workspace_unavailable", "OpenCode returned models for a different Location.")
  }
  return {
    workspaceId, name: clipped(basename(ctx.location.directory) || "OpenCode", 120), active: true, engine: "v2",
    defaultModel: selected.data ? { providerId: selected.data.providerID, modelId: selected.data.id } : null,
    models: models.data.filter(model => model.enabled).slice(0, 200).map(model => ({
      providerId: clipped(model.providerID, 160), modelId: clipped(model.id, 160), name: clipped(model.name, 200),
    })),
  }
}

export function createNativeOpenCodeAdapter(input: {
  ctx: NativePluginContext
  directory: string
  workspaceId: string
  /** Partitioned exactly like the runner journal; no tokens are stored here. */
  storagePrefix: string
  now?: () => number
}): HarnessAdapter {
  const { ctx, directory, workspaceId } = input
  const now = input.now ?? Date.now
  const markerKey = (sessionId: string) => `${input.storagePrefix}/native/${digest(sessionId)}`
  const load = async (receipt: Receipt) => admission(await ctx.storage.get(markerKey(receipt.sessionId)))
  const save = (receipt: Receipt, value: Admission) => ctx.storage.set(markerKey(receipt.sessionId), { ...value })

  async function owned(receipt: Receipt, signal: AbortSignal): Promise<NativeSessionInfo> {
    signal.throwIfAborted()
    if (receipt.workspaceId !== workspaceId) throw new SessionRunnerError("workspace_unavailable", "This runner approves only its current OpenCode directory.")
    const info = await ctx.session.get({ sessionID: receipt.sessionId }, { signal })
    signal.throwIfAborted()
    if (await realpath(info.location.directory) !== directory) {
      throw new SessionRunnerError("workspace_unavailable", "The session has moved outside this runner's approved directory.")
    }
    return info
  }

  async function snapshot(receipt: Receipt, signal: AbortSignal) {
    const info = await owned(receipt, signal)
    const [messages, permissions, marker] = await Promise.all([
      ctx.session.context({ sessionID: receipt.sessionId }, { signal }),
      ctx.permission.list({ sessionID: receipt.sessionId }, { signal }),
      load(receipt),
    ])
    signal.throwIfAborted()
    const users = messages.filter(message => message.type === "user")
    const latestUser = users.at(-1)
    const lastIdle = messages.findLast(message => message.type === "idle")
    const idleAt = Math.max(info.time.idle ?? -1, lastIdle?.time.created ?? -1)
    const pending = marker !== null && !messages.some(message => message.id === marker.messageId)
      && idleAt <= (marker.baselineIdle ?? -1)
    const activityAt = messages.reduce((latest, message) => message.type === "assistant" || message.type === "compaction"
      ? Math.max(latest, message.time.created) : latest, latestUser?.time.created ?? -1)
    const running = pending || activityAt > idleAt
    const waitingFor = permissions.length ? "permission" : messages.some(message => message.type === "assistant"
      && message.time.created > idleAt && message.time.created >= (latestUser?.time.created ?? 0)
      && message.content.some(part => part.type === "tool" && part.name === "question" && part.state.status === "running")) ? "question" : null
    const assistantIndex = messages.findLastIndex(message => message.type === "assistant")
    const turnBoundary = Math.max(messages.findLastIndex(message => message.type === "user"),
      messages.findLastIndex(message => message.type === "compaction"))
    const assistant = assistantIndex > turnBoundary ? messages[assistantIndex] : undefined
    const nativeError = assistant?.type === "assistant" ? errorOf(assistant.error) : null
    const status = waitingFor ? "waiting" : running ? "running" : info.outcome === "failed" ? "error" : "idle"
    const finalText = !running && !waitingFor && assistant?.type === "assistant"
      ? clipped(assistant.content.filter(part => part.type === "text").map(part => part.text).join("\n"), 20_000) : ""
    const progress: Progress = {
      status, waitingFor, engine: "v2", model: remoteModel(info.model ?? (assistant?.type === "assistant" ? assistant.model : undefined)), finalText,
      error: status === "error" ? nativeError ?? { code: "native_error", message: "OpenCode's last execution failed." } : null,
      // Count native context entries, including durable idle markers: a failed/interrupted turn
      // can settle without an assistant. This is not a promised count of historical user/assistant messages.
      messageCount: messages.length,
      observedAt: now(),
    }
    return { info, messages, latestUser, progress }
  }

  const adapter: HarnessAdapter & { readonly creation: "idempotent"; readonly sendReplay: "idempotent" } = {
    creation: "idempotent",
    sendReplay: "idempotent",
    async create(command, signal) {
      signal.throwIfAborted()
      if (command.workspaceId && command.workspaceId !== workspaceId) {
        throw new SessionRunnerError("workspace_unavailable", "The requested workspace is not this runner's approved directory.")
      }
      // Native create is idempotent for a supplied id, but an existing session is returned without
      // comparing location/metadata. Validate both before trusting a recovered receipt.
      const id = sessionIdForCommand(command.commandId)
      const created = await ctx.session.create({ id, title: command.title, location: { directory },
        metadata: { openwork: { commandId: command.commandId } },
        ...(command.model ? { model: nativeModel(command.model) } : {}) }, { signal })
      const owner = created.metadata?.openwork
      let actualDirectory: string | null = null
      try { actualDirectory = await realpath(created.location.directory) } catch { /* unverifiable receipt fails closed */ }
      if (created.id !== id || actualDirectory !== directory || !isRecord(owner) || owner.commandId !== command.commandId) {
        throw new SessionRunnerError("session_conflict", "The deterministic OpenCode session identity belongs to different work or a different Location.")
      }
      // Retain a verified receipt even if cancellation arrived during an uncancellable 2.0.26 host call.
      return { sessionId: created.id, workspaceId }
    },
    async send(receipt, prompt, signal) {
      const info = await owned(receipt, signal)
      const [messages, previous] = await Promise.all([
        ctx.session.context({ sessionID: receipt.sessionId }, { signal }), load(receipt),
      ])
      signal.throwIfAborted()
      if (messages.some(message => message.id === prompt.messageId) || (previous?.messageId === prompt.messageId && previous.admitted)) {
        return { messageId: prompt.messageId, alreadyPresent: true }
      }
      const marker = previous?.messageId === prompt.messageId ? previous
        : { messageId: prompt.messageId, baselineIdle: info.time.idle ?? null, admitted: false }
      await save(receipt, marker)
      signal.throwIfAborted()
      if (prompt.model) await ctx.session.switchModel({ sessionID: receipt.sessionId, model: nativeModel(prompt.model) }, { signal })
      signal.throwIfAborted()
      // prompt's id (NOT messageID) is the native durable admission deduplication key, including across compaction.
      const admitted = await ctx.session.prompt({ sessionID: receipt.sessionId, id: prompt.messageId,
        text: prompt.prompt, delivery: "queue", resume: true }, { signal })
      if (admitted.id !== prompt.messageId || admitted.sessionID !== receipt.sessionId) {
        throw new SessionRunnerError("invalid_data", "OpenCode returned a different prompt admission identity.")
      }
      await save(receipt, { ...marker, admitted: true })
      return { messageId: admitted.id, alreadyPresent: false }
    },
    async observe(receipt, signal) { return (await snapshot(receipt, signal)).progress },
    async stop(receipt, guard, signal) {
      const { latestUser, progress } = await snapshot(receipt, signal)
      if (guard.messageId && latestUser?.id !== guard.messageId) return { stopped: false, reason: "different_turn" }
      if (progress.status === "idle" || progress.status === "error") return { stopped: false, reason: null }
      signal.throwIfAborted()
      // Native host has interrupt, not the full client's abort API. Never resume parked queued prompts on stop.
      const result = await ctx.session.interrupt({ sessionID: receipt.sessionId, resume: false }, { signal })
      return { stopped: result.interrupted, reason: null }
    },
    async read(receipt, page, signal) {
      const { info, messages, progress } = await snapshot(receipt, signal)
      const transcript = messages.filter(message => message.type === "user" || message.type === "assistant").map(transcriptMessage)
      const epoch = digest(messages.findLast(message => message.type === "compaction")?.id ?? "initial")
      let edge = page.from === "start" ? 0 : transcript.length
      if (page.cursor !== null) {
        const match = /^oc2:(start|end):([a-f0-9]{24}):([a-f0-9]{24})$/.exec(page.cursor)
        const anchor = match ? transcript.findIndex(message => digest(message.id) === match[3]) : -1
        if (!match || match[1] !== page.from || match[2] !== epoch || anchor < 0) {
          throw new SessionRunnerError("cursor_unavailable", "This cursor is unknown or its messages were compacted. Read again without a cursor; only recent context is available.")
        }
        edge = page.from === "start" ? anchor + 1 : anchor
      }
      const start = page.from === "start" ? edge : Math.max(0, edge - page.limit)
      const end = page.from === "start" ? Math.min(transcript.length, edge + page.limit) : edge
      const selected = transcript.slice(start, end)
      boundTranscript(selected)
      const anchor = page.from === "start" ? selected.at(-1) : selected[0]
      const more = page.from === "start" ? end < transcript.length : start > 0
      return {
        title: info.title ? clipped(info.title, 240) : null, status: progress.status, waitingFor: progress.waitingFor ?? null,
        lastError: progress.error ?? null,
        historyScope: "context",
        messageCount: transcript.length, from: page.from, messages: selected,
        nextCursor: more && anchor ? `oc2:${page.from}:${epoch}:${digest(anchor.id)}` : null,
      }
    },
  }
  return adapter
}

function toolCall(part: Extract<NativeAssistantContent, { type: "tool" }>): TranscriptToolCall {
  const state = part.state
  const rawInput = typeof state.input === "string" ? state.input : JSON.stringify(state.input)
  const rawOutput = "content" in state ? JSON.stringify(state.content) : undefined
  const rawError = "error" in state ? state.error.message ?? state.error.type : undefined
  return { id: clipped(part.id, 240), name: clipped(part.name, 240), status: state.status,
    input: summary(state.input), output: rawOutput === undefined ? null : clipped(rawOutput, 2000),
    error: rawError === undefined ? null : clipped(rawError, 2000),
    truncated: rawInput.length > 2000 || (rawOutput?.length ?? 0) > 2000 || (rawError?.length ?? 0) > 2000 }
}
function transcriptMessage(message: NativeMessage): TranscriptMessage {
  const text = message.type === "user" ? message.text : message.type === "assistant"
    ? message.content.filter(part => part.type === "text").map(part => part.text).join("\n") : ""
  const tools = message.type === "assistant" ? message.content.filter(part => part.type === "tool").map(toolCall) : []
  return { id: clipped(message.id, 240), role: message.type === "user" ? "user" : "assistant",
    createdAt: message.time.created, text: clipped(text, 20_000), truncated: text.length > 20_000 || tools.length > 200,
    toolCalls: tools.slice(0, 200), error: message.type === "assistant" ? errorOf(message.error) : null }
}
/** Keep whole pages below the wire byte cap, including multibyte text and tool summaries. */
function boundTranscript(messages: TranscriptMessage[]): void {
  while (Buffer.byteLength(JSON.stringify(messages), "utf8") > 220_000) {
    let reduced = false
    for (const message of messages) {
      if (message.text.length > 256) { message.text = message.text.slice(0, Math.floor(message.text.length / 2)); message.truncated = true; reduced = true }
      if (message.toolCalls.length > 4) { message.toolCalls = message.toolCalls.slice(0, Math.ceil(message.toolCalls.length / 2)); message.truncated = true; reduced = true }
      for (const tool of message.toolCalls) {
        for (const key of ["input", "output", "error"] satisfies Array<"input" | "output" | "error">) {
          const value = tool[key]
          if (value && value.length > 256) { tool[key] = value.slice(0, Math.floor(value.length / 2)); tool.truncated = true; reduced = true }
        }
      }
    }
    if (!reduced) throw new SessionRunnerError("transcript_too_large", "The bounded recent context page is still too large. Request fewer messages.")
  }
}
