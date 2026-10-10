import { createHash } from "node:crypto"
import { parseProgress, parseReadResult, SessionRunnerError } from "@openwork/remote-sessions"
import {
  classifyRemoteSessionCommandError,
  classifyRemoteSessionRequestError,
  createWorkspaceSessionClient,
  readRemoteSessionWaitingFor,
  remoteSessionObservation,
  remoteSessionTranscriptPage,
  remoteSessionTurnVisible,
  requestJson,
  resolveAssignmentWorkspace,
} from "./automation-runner.mjs"

const NATIVE_OPERATION_TIMEOUT_MS = 15_000

function latestUserId(snapshot) {
  return [...(snapshot.messages ?? [])].reverse().find((message) => message?.role === "user")?.id ?? null
}

function modelInput(model) {
  return model ? {
    providerId: model.providerId,
    modelId: model.modelId,
    ...(model.variant ? { variant: model.variant } : {}),
  } : undefined
}

/** Only an explicit rejection proves that a native mutation did not happen. */
function definitiveFailure(error, creating) {
  if (error instanceof SessionRunnerError) return error
  if (![400, 401, 403, 404, 409, 422].includes(error?.status)) return error
  const classified = creating
    ? classifyRemoteSessionCommandError(error)
    : classifyRemoteSessionRequestError(error, false)
  return new SessionRunnerError(classified.code, classified.message)
}

/**
 * Native desktop APIs only. The shared remote-session runner owns all
 * durability, prompt IDs, outboxes and admission. It never runs a scheduled
 * Automation or answers a permission/question on the person's behalf.
 * @returns {import("@openwork/remote-sessions").HarnessAdapter}
 */
export function createDesktopSessionAdapter(options) {
  const fetchImpl = options.fetchImpl ?? fetch
  const now = options.now ?? Date.now
  const identities = new Map()
  const key = (receipt) => `${receipt.workspaceId}\n${receipt.sessionId}`
  const bounded = (signal) => AbortSignal.any([signal, AbortSignal.timeout(options.operationTimeoutMs ?? NATIVE_OPERATION_TIMEOUT_MS)])
  const runtime = async () => {
    const local = await options.getLocalRuntime()
    if (!local?.baseUrl || !local?.token) {
      throw new SessionRunnerError("openwork_unreachable", "Can't reach OpenWork on your desktop. Make sure OpenWork is running.")
    }
    return local
  }
  const engine = async (local, signal) => {
    try {
      const status = await requestJson(fetchImpl, local.baseUrl, local.token, "/experimental/engine-v2-preview/status", { signal })
      if (typeof status?.enabled !== "boolean" || typeof status?.chatRouting !== "boolean") {
        throw new Error("The local runtime did not identify its chat engine")
      }
      return status.enabled && status.chatRouting ? "v2" : "v1"
    } catch (error) {
      if (error?.status === 404) return "v1"
      throw error
    }
  }
  // Credentials are read anew on every operation. Only native session identity
  // is cached; after restart probe the actual owning engine, not just today's
  // chat-routing setting, which might have changed since creation.
  const snapshotFor = async (receipt, signal, limit) => {
    const local = await runtime()
    const known = identities.get(key(receipt))
    const selected = known?.engine ?? await engine(local, signal)
    const read = async (selectedEngine) => {
      const client = createWorkspaceSessionClient(local, receipt.workspaceId, fetchImpl, false, selectedEngine)
      const snapshot = await client.getThreadSnapshot(receipt.sessionId, { signal, ...(limit ? { limit } : {}) })
      identities.set(key(receipt), { ...known, engine: selectedEngine })
      return { local, client, snapshot, engine: selectedEngine, model: known?.model, messageId: known?.messageId }
    }
    try {
      return await read(selected)
    } catch (error) {
      // Only a missing session permits trying the other engine. Do not turn a
      // temporarily unreachable engine into a different native target.
      if (error?.status !== 404) throw error
      return await read(selected === "v2" ? "v1" : "v2")
    }
  }
  const waitingFor = async (native, receipt, signal) => {
    const running = native.snapshot?.status?.type === "busy" || native.snapshot?.status?.type === "retry"
    return running
      ? await readRemoteSessionWaitingFor(native.local, receipt.workspaceId, receipt.sessionId, native.engine, fetchImpl, signal)
      : null
  }
  return {
    // Engine selection is dynamic per command. Do not claim V2's native create
    // deduplication for a runner that can also receive V1 workspace commands.
    creation: "at_most_once",
    // One adapter routes both engine versions. V1 has no atomic admission
    // primitive, so an uncertain send must not be replayed automatically.
    sendReplay: "at_most_once",
    async create(command, signal) {
      const operationSignal = bounded(signal)
      const local = await runtime()
      let listed
      let selectedEngine
      try {
        listed = await requestJson(fetchImpl, local.baseUrl, local.token, "/workspaces", { signal: operationSignal })
        selectedEngine = await engine(local, operationSignal)
      } catch (error) {
        // These are read-only preflight probes: creation has not been attempted,
        // so their failure is definitive, unlike a lost create response below.
        const classified = classifyRemoteSessionCommandError(error)
        throw new SessionRunnerError(classified.code, classified.message)
      }
      let workspace
      try {
        workspace = resolveAssignmentWorkspace(listed, command.workspaceId ?? null)
      } catch {
        throw new SessionRunnerError("workspace_unavailable", "The selected workspace is not available on this desktop.")
      }
      const workspaceId = String(workspace.id)
      const client = createWorkspaceSessionClient(local, workspaceId, fetchImpl, false, selectedEngine)
      let created
      try {
        // Intentionally no prompt here: a durable native receipt must exist
        // before the core sends the initial stable message ID.
        const identity = selectedEngine === "v2" && options.creationOwner ? {
          id: `ses_${createHash("sha256").update(JSON.stringify([options.creationOwner, workspaceId, command.commandId])).digest("hex")}`,
          metadata: { openworkRemoteSessionOwner: options.creationOwner, openworkRemoteSessionCommand: command.commandId },
        } : {}
        created = await client.createThread({
          title: command.title,
          ...identity,
          ...(command.model ? { model: modelInput(command.model) } : {}),
          signal: operationSignal,
        })
      } catch (error) {
        throw definitiveFailure(error, true)
      }
      const receipt = { sessionId: created.id, workspaceId }
      identities.set(key(receipt), { engine: created.engine ?? selectedEngine, model: created.model ?? modelInput(command.model) })
      return receipt
    },
    async send(receipt, input, signal) {
      const operationSignal = bounded(signal)
      try {
        const native = await snapshotFor(receipt, operationSignal, 50)
        let accepted
        try {
          accepted = await native.client.sendTurn(receipt.sessionId, {
            prompt: input.prompt,
            messageId: input.messageId,
            ...(input.model ? { model: modelInput(input.model) } : {}),
            signal: operationSignal,
          })
        } catch (error) {
          if (native.engine === "v1" && ![400, 401, 403, 404, 409, 422].includes(error?.status)) {
            // V1 admission is check-then-send, not an atomic idempotency key.
            // A lost prompt response cannot safely be retried as a new turn.
            throw new SessionRunnerError("ambiguous_send", "OpenCode V1 did not confirm prompt admission. Inspect the local session; this turn must not be sent again automatically.")
          }
          throw error
        }
        identities.set(key(receipt), {
          engine: native.engine,
          model: input.model ? modelInput(input.model) : native.model,
          messageId: accepted.messageId ?? input.messageId,
        })
        return { messageId: accepted.messageId ?? input.messageId, alreadyPresent: accepted.alreadyPresent === true }
      } catch (error) {
        throw definitiveFailure(error, false)
      }
    },
    async read(receipt, input, signal) {
      const operationSignal = bounded(signal)
      try {
        const native = await snapshotFor(receipt, operationSignal)
        return parseReadResult({
          ...remoteSessionTranscriptPage(native.snapshot, input, await waitingFor(native, receipt, operationSignal)),
          historyScope: "full",
        })
      } catch (error) {
        if (error?.code === "invalid_cursor") {
          throw new SessionRunnerError("invalid_cursor", error.message)
        }
        throw definitiveFailure(error, false)
      }
    },
    async stop(receipt, input, signal) {
      // The modern core pins an unguarded stop to its durable last message.
      // Without a guard, this adapter must not abort a newer local turn.
      if (!input.messageId) return { stopped: false, reason: null }
      const operationSignal = bounded(signal)
      try {
        const native = await snapshotFor(receipt, operationSignal, 50)
        if (input.messageId && latestUserId(native.snapshot) !== input.messageId) {
          return { stopped: false, reason: "different_turn" }
        }
        const aborted = await native.client.abortThread(receipt.sessionId, { signal: operationSignal })
        return { stopped: aborted.accepted === true, reason: null }
      } catch (error) {
        throw definitiveFailure(error, false)
      }
    },
    async observe(receipt, signal) {
      const operationSignal = bounded(signal)
      try {
        const native = await snapshotFor(receipt, operationSignal, 200)
        // Status and messages are separate native reads. Until the accepted
        // stable user message appears, even an idle old reply is not this turn.
        const visible = !native.messageId || remoteSessionTurnVisible(native.snapshot, { messageId: native.messageId })
        const observation = visible
          ? remoteSessionObservation(native.snapshot, await waitingFor(native, receipt, operationSignal))
          : { status: "running", messageCount: native.snapshot.messages.length }
        return parseProgress({
          ...observation,
          // An idle snapshot with no reply is not a failed turn. The shared
          // core uses its durable turn baseline before accepting final text.
          status: observation.status === "silent" ? "running" : observation.status,
          waitingFor: observation.waitingFor ?? null,
          error: observation.error ?? null,
          engine: native.engine,
          ...(native.model ? { model: native.model } : {}),
          observedAt: now(),
        })
      } catch (error) {
        if (error?.status === 404) {
          return { status: "error", error: { code: "session_not_found", message: "The local session is no longer available." }, observedAt: now() }
        }
        throw error
      }
    },
  }
}
