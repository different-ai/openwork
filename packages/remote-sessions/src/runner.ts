import type {
  CommandEntry, Complete, HarnessAdapter, Journal, JournalStore, Progress, RequestComplete,
  Receipt, RequestEntry, SessionError, SessionRunner, Transport,
} from "./types.ts"
import { DEFAULT_OPERATION_TIMEOUT_MS, MAX_COMMAND_ENTRIES, MAX_REQUEST_ENTRIES, SessionRunnerError } from "./types.ts"
import { integer, parseCommand, parseError, parseJournal, parseProgress, parseReadResult, parseReceipt,
  parseRequest, parseRequestComplete, parseSendResult, parseStopResult, stableMessageId, sessionIdForCommand } from "./protocol.ts"
import { bounded, throwIfAborted } from "./timeout.ts"

export interface SessionRunnerOptions {
  adapter: HarnessAdapter
  store: JournalStore
  transport: Transport
  now?: () => number
  operationTimeoutMs?: number
}
function failure(code: string, message: string): SessionError { return { code, message } }
function ambiguousSend(receipt: Receipt): SessionError {
  return failure("ambiguous_send", `Native send may have been accepted in session ${receipt.sessionId}, workspace ${receipt.workspaceId}. Inspect that local session; this send will never be retried automatically.`)
}
function definitive(error: unknown): SessionError | null {
  // Cancellation, timeouts, network errors and invalid adapter output do NOT prove native failure.
  if (!(error instanceof SessionRunnerError) || error.code === "operation_timeout" || error.code === "invalid_data") return null
  return parseError({ code: error.code, message: error.message })
}
function same(a: unknown, b: unknown): boolean { return JSON.stringify(a) === JSON.stringify(b) }
function sameProgress(a: Progress | null, b: Progress): boolean {
  if (!a) return false
  const { observedAt: _a, ...left } = a
  const { observedAt: _b, ...right } = b
  return same(left, right)
}

export function createSessionRunner(options: SessionRunnerOptions): SessionRunner {
  const { adapter, store, transport } = options
  const clock = options.now ?? Date.now
  const now = () => integer(clock())
  const timeoutMs = integer(options.operationTimeoutMs ?? DEFAULT_OPERATION_TIMEOUT_MS, 1, 120_000)
  const creation = adapter.creation ?? "at_most_once"
  if (creation !== "idempotent" && creation !== "at_most_once") throw new SessionRunnerError("invalid_data", "Invalid adapter creation capability.")
  const canReplayCreation = (entry: CommandEntry) => entry.creation === "idempotent" && creation === "idempotent"
  const sendReplay = adapter.sendReplay ?? "idempotent"
  if (sendReplay !== "idempotent" && sendReplay !== "at_most_once") throw new SessionRunnerError("invalid_data", "Invalid adapter send replay capability.")
  const canReplaySend = (entry: CommandEntry | RequestEntry) => entry.sendReplay === "idempotent" && sendReplay === "idempotent"
  let journal: Journal | undefined
  let poisoned = false
  let queue: Promise<void> = Promise.resolve()

  function state(): Journal {
    if (!journal || poisoned) throw new SessionRunnerError("journal_unavailable", "Reload the runner from a valid durable journal before continuing.")
    return journal
  }
  async function persist(next: Journal): Promise<void> {
    const validated = parseJournal(next)
    try { await store.save(structuredClone(validated)) }
    catch (error) { poisoned = true; throw error }
    journal = validated
  }
  async function load(): Promise<void> {
    if (poisoned) state()
    if (journal) return
    try { journal = parseJournal(await store.load()) }
    catch (error) { poisoned = true; throw error }
    if (journal.commands.some(e => e.phase === "prepared" && !canReplayCreation(e))) {
      await persist({ ...journal, commands: journal.commands.map(e => e.phase !== "prepared" || canReplayCreation(e) ? e : {
        ...e, phase: "failed", completion: { status: "failed", error: failure("ambiguous_creation",
          "Creation was interrupted before a receipt was saved. Inspect the native harness; this command will not create another session.") },
      }) })
    }
    await recoverUnsafeSends()
  }
  async function recoverUnsafeSends(): Promise<void> {
    const current = state()
    let changed = false
    let commands = current.commands.map(e => {
      if (e.phase !== "created" || !e.turn || !e.receipt || canReplaySend(e)) return e
      changed = true
      const completion: Complete = { status: "failed", error: ambiguousSend(e.receipt) }
      const recovered: CommandEntry = { ...e, phase: "failed", completion }
      return recovered
    })
    const requests = current.requests.map(e => {
      if (e.completion || e.request.action !== "send" || !e.turn || canReplaySend(e)) return e
      changed = true
      const completion: RequestComplete = { status: "failed", error: ambiguousSend(e.request) }
      // Unknown followup acceptance must not turn the previous answer into this turn's result.
      commands = commands.map(c => c.command.commandId === e.request.commandId && c.phase === "delivered" && c.lastMessageId !== e.messageId
        ? { ...c, turn: e.turn, lastMessageId: e.messageId, progress: null, reportedProgress: null } : c)
      return { ...e, completion }
    })
    if (changed) await persist({ ...current, commands, requests })
  }
  function serialized<T>(operation: () => Promise<T>): Promise<T> {
    const task = queue.then(async () => { await load(); return operation() })
    queue = task.then(() => {}, () => {})
    return task
  }
  function command(id: string): CommandEntry {
    const entry = state().commands.find(e => e.command.commandId === id)
    if (!entry) throw new SessionRunnerError("unknown_command", "The command is not in this account's local journal.")
    return entry
  }
  function request(id: string): RequestEntry {
    const entry = state().requests.find(e => e.request.requestId === id)
    if (!entry) throw new SessionRunnerError("unknown_request", "The request is not in this account's local journal.")
    return entry
  }
  async function saveCommand(entry: CommandEntry): Promise<void> {
    await persist({ ...state(), commands: state().commands.map(e => e.command.commandId === entry.command.commandId ? entry : e) })
  }
  async function saveRequest(entry: RequestEntry): Promise<void> {
    await persist({ ...state(), requests: state().requests.map(e => e.request.requestId === entry.request.requestId ? entry : e) })
  }
  function local<T>(signal: AbortSignal, effect: (signal: AbortSignal) => Promise<T>): Promise<T> { return bounded(signal, timeoutMs, effect) }

  async function flushCommand(id: string, signal: AbortSignal): Promise<void> {
    const e = command(id)
    if (!e.completion || e.completionAcknowledged) return
    await local(signal, s => transport.complete(id, structuredClone(e.completion!), s))
    await saveCommand({ ...command(id), completionAcknowledged: true })
  }
  async function flushRequest(id: string, signal: AbortSignal): Promise<void> {
    const e = request(id)
    if (!e.completion || e.completionAcknowledged) return
    await local(signal, s => transport.completeRequest(id, structuredClone(e.completion!), s))
    await saveRequest({ ...request(id), completionAcknowledged: true })
  }
  async function createPrepared(id: string, signal: AbortSignal, firstAttempt = false): Promise<void> {
    const entry = command(id)
    if (entry.phase !== "prepared") return
    if (!firstAttempt && !canReplayCreation(entry)) {
      await saveCommand({ ...entry, phase: "failed", completion: { status: "failed", error: failure("ambiguous_creation",
        "Creation was interrupted before a receipt was saved. Inspect the native harness; this command will not create another session.") } })
      return
    }
    throwIfAborted(signal)
    if (entry.command.expiresAt <= now()) {
      await saveCommand({ ...entry, phase: "failed", completion: {
        status: "failed", error: failure("expired", "The command expired before creation could be attempted or safely replayed.") } })
      return
    }
    try {
      const receipt = parseReceipt(await local(signal, s => adapter.create(structuredClone(entry.command), s)))
      if (entry.command.workspaceId && receipt.workspaceId !== entry.command.workspaceId) {
        throw new SessionRunnerError("invalid_data", "The adapter created a session in a different workspace.")
      }
      if (entry.creation === "idempotent" && receipt.sessionId !== entry.intendedSessionId) {
        throw new SessionRunnerError("invalid_data", "Idempotent creation must return the journal's deterministic session ID.")
      }
      // Receipt MUST survive before any prompt is sent, even if cancellation has arrived.
      await saveCommand({ ...command(id), phase: "created", receipt })
    } catch (error) {
      if (signal.aborted) throw error
      const proven = definitive(error)
      if (!proven) throw error
      await saveCommand({ ...command(id), phase: "failed", completion: { status: "failed", error: proven } })
    }
  }
  async function deliver(id: string, signal: AbortSignal): Promise<Complete> {
    let e = command(id)
    if (e.completion) return e.completion
    if (e.turn && e.receipt && !canReplaySend(e)) {
      const completion: Complete = { status: "failed", error: ambiguousSend(e.receipt) }
      await saveCommand({ ...e, phase: "failed", completion })
      return completion
    }
    if (e.command.expiresAt <= now()) {
      const completion: Complete = { status: "failed", error: failure("expired", "The command expired before its next native effect.") }
      await saveCommand({ ...e, phase: "failed", completion })
      return completion
    }
    if (!e.receipt) throw new SessionRunnerError("ambiguous_creation", "A missing creation receipt cannot be replayed.")
    if (e.command.prompt !== null) {
      if (!e.turn) {
        const baseline = parseProgress(await local(signal, s => adapter.observe(structuredClone(e.receipt!), s)))
        throwIfAborted(signal)
        await saveCommand({ ...e, sendReplay: canReplaySend(e) ? "idempotent" : "at_most_once",
          turn: { messageId: e.promptMessageId!, baselineMessageCount: baseline.messageCount ?? null, seenActive: false }, lastMessageId: e.promptMessageId })
        e = command(id)
      }
      try {
        throwIfAborted(signal)
        if (e.command.expiresAt <= now()) return deliver(id, signal)
        const result = parseSendResult(await local(signal, s => adapter.send(structuredClone(e.receipt!), {
          prompt: e.command.prompt!, messageId: e.promptMessageId!, model: structuredClone(e.command.model),
        }, s)))
        if (result.messageId !== null && result.messageId !== e.promptMessageId) {
          throw new SessionRunnerError("invalid_data", "The adapter returned a different stable message ID.")
        }
      } catch (error) {
        if (poisoned) throw error
        const proven = definitive(error)
        const uncertain = proven?.code === "ambiguous_send" || (!canReplaySend(e) && (signal.aborted || !proven))
        if (!uncertain && signal.aborted) throw error
        if (!uncertain && !proven) throw error
        const completion: Complete = { status: "failed", error: uncertain ? ambiguousSend(e.receipt!) : proven! }
        // Abort must not erase the durable ambiguity boundary, but it must prevent HTTP acknowledgement.
        await saveCommand({ ...command(id), phase: "failed", completion })
        throwIfAborted(signal)
        return completion
      }
    }
    // Native effects may have finished just before cancellation: retain the receipt/result, but do not acknowledge while disconnected.
    const receipt = e.receipt
    if (!receipt) throw new SessionRunnerError("invalid_data", "The delivered command has no receipt.")
    const completion: Complete = { status: "delivered", sessionId: receipt.sessionId, workspaceId: receipt.workspaceId }
    await saveCommand({ ...command(id), phase: "delivered", completion })
    return completion
  }

  function knownReceipt(e: RequestEntry): CommandEntry | undefined {
    return state().commands.find(c => c.command.commandId === e.request.commandId && c.phase === "delivered"
      && c.receipt?.sessionId === e.request.sessionId && c.receipt.workspaceId === e.request.workspaceId)
  }
  async function performRequest(id: string, signal: AbortSignal): Promise<RequestComplete> {
    let e = request(id)
    if (e.completion) return e.completion
    throwIfAborted(signal)
    let completion: RequestComplete
    let applyTurn = false
    const c = knownReceipt(e)
    if (e.request.action === "send" && e.turn && !canReplaySend(e)) {
      completion = { status: "failed", error: ambiguousSend(e.request) }
      applyTurn = true
    } else if (e.request.expiresAt <= now()) {
      completion = { status: "failed", error: failure("expired", "The request expired before its next native effect.") }
      // An interrupted send may already have been accepted, even though it can no longer be retried.
      applyTurn = e.turn !== null
    }
    else if (!c?.receipt) completion = { status: "failed", error: failure("unknown_receipt", "Only a session delivered by this account's local journal can be controlled.") }
    else {
      const earlier = state().requests.slice(0, state().requests.findIndex(r => r.request.requestId === id))
        .some(r => r.request.commandId === e.request.commandId && r.request.action !== "read" && r.completion === null)
      if (earlier && e.request.action !== "read") throw new SessionRunnerError("request_in_progress", "An earlier native control request must be reconciled first.")
      try {
        if (e.request.action === "read") {
          const input = e.request.input
          const result = parseReadResult(await local(signal, s => adapter.read(structuredClone(c.receipt!), structuredClone(input), s)))
          completion = parseRequestComplete({ status: "done", outcome: { action: "read", result } })
        } else if (e.request.action === "send") {
          const input = e.request.input
          // Baseline and turn identity are durable BEFORE sending, including after a crash during send.
          if (!e.turn) {
            const baseline = parseProgress(await local(signal, s => adapter.observe(structuredClone(c.receipt!), s)))
            throwIfAborted(signal)
            await saveRequest({ ...e, sendReplay: canReplaySend(e) ? "idempotent" : "at_most_once",
              turn: { messageId: e.messageId!, baselineMessageCount: baseline.messageCount ?? null, seenActive: false } })
            e = request(id)
          }
          throwIfAborted(signal)
          if (e.request.expiresAt <= now()) return performRequest(id, signal)
          const result = parseSendResult(await local(signal, s => adapter.send(structuredClone(c.receipt!), {
            ...structuredClone(input), messageId: e.messageId!,
          }, s)))
          if (result.messageId !== null && result.messageId !== e.messageId) throw new SessionRunnerError("invalid_data", "The adapter returned a different stable message ID.")
          completion = { status: "done", outcome: { action: "send", result } }
          applyTurn = true
        } else if (e.request.input.messageId === null && e.messageId !== null && c.lastMessageId !== e.messageId) {
          completion = { status: "done", outcome: { action: "stop", result: { stopped: false, reason: "different_turn" } } }
        } else if (e.messageId === null) {
          completion = { status: "done", outcome: { action: "stop", result: { stopped: false, reason: null } } }
        } else {
          const result = parseStopResult(await local(signal, s => adapter.stop(structuredClone(c.receipt!), { messageId: e.messageId }, s)))
          completion = { status: "done", outcome: { action: "stop", result } }
        }
      } catch (error) {
        if (poisoned) throw error
        const latest = request(id)
        const proven = definitive(error)
        const uncertainSend = latest.request.action === "send" && latest.turn !== null
          && (proven?.code === "ambiguous_send" || (!canReplaySend(latest) && (signal.aborted || !proven)))
        if (uncertainSend) {
          completion = { status: "failed", error: ambiguousSend(latest.request) }
          applyTurn = true
        } else {
          if (signal.aborted) throw error
          if (!proven) throw error
          completion = { status: "failed", error: proven }
        }
      }
    }
    e = request(id)
    const updatedCommand = applyTurn && c && e.turn && c.lastMessageId !== e.messageId ? {
      ...command(c.command.commandId), turn: e.turn, lastMessageId: e.messageId, progress: null, reportedProgress: null,
    } : null
    await persist({ ...state(),
      requests: state().requests.map(r => r.request.requestId === id ? { ...e, completion } : r),
      commands: state().commands.map(c => updatedCommand && c.command.commandId === updatedCommand.command.commandId ? updatedCommand : c),
    })
    throwIfAborted(signal)
    return completion
  }

  async function flushProgress(id: string, progress: Progress, signal: AbortSignal): Promise<boolean> {
    try { await local(signal, s => transport.report(id, structuredClone(progress), s)) }
    catch (error) {
      if (signal.aborted) throw error
      // A stale observation or removed remote record is not a native failure. Discard only this report, not receipts/acks.
      if (typeof error !== "object" || error === null || !("status" in error) || (error.status !== 404 && error.status !== 409)) throw error
      await saveCommand({ ...command(id), progress: null, reportedProgress: null })
      return false
    }
    await saveCommand({ ...command(id), progress: null, reportedProgress: progress })
    return true
  }
  async function watch(id: string, signal: AbortSignal): Promise<void> {
    let e = command(id)
    if (e.phase !== "delivered" || !e.receipt || !e.completionAcknowledged) return
    // An uncertain send cannot expose the previous turn's answer. A saved send result need not wait for HTTP acknowledgement.
    if (state().requests.some(r => r.request.commandId === id && r.request.action === "send" && r.completion === null)) return
    if (e.progress) {
      if (!await flushProgress(id, e.progress, signal)) return // Next poll obtains a genuinely new observation.
      e = command(id)
    }
    let progress = parseProgress(await local(signal, s => adapter.observe(structuredClone(e.receipt!), s)))
    let turn = e.turn
    if (turn) {
      const active = progress.status === "running" || progress.status === "waiting"
      if (active && !turn.seenActive) turn = { ...turn, seenActive: true }
      const knownCounts = turn.baselineMessageCount !== null && progress.messageCount !== undefined
      const newMessages = turn.baselineMessageCount !== null && progress.messageCount !== undefined
        && progress.messageCount >= turn.baselineMessageCount + 2
      if (!active && !turn.seenActive && !newMessages) {
        progress = { ...progress, status: "running", waitingFor: null, finalText: "", error: null }
      } else if (!active && knownCounts && !newMessages) {
        // A stopped/failed turn can return to idle without an assistant message. Activity alone does not make an old answer new.
        progress = { ...progress, finalText: "" }
      }
    }
    // Running/waiting must not carry the previous turn's final answer or error.
    if (progress.status === "running" || progress.status === "waiting") progress = { ...progress, finalText: "", error: null }
    if (!sameProgress(e.reportedProgress, progress)) {
      // Native clocks can repeat or move backwards. Den orders only observations, never acknowledgement-time resets.
      progress = { ...progress, observedAt: integer(Math.max(progress.observedAt, (e.lastObservedAt ?? -1) + 1)) }
      await saveCommand({ ...e, turn, progress, lastObservedAt: progress.observedAt })
      await flushProgress(id, progress, signal)
    } else if (!same(turn, e.turn)) await saveCommand({ ...e, turn })
  }

  return {
    accept(input, signal) {
      return serialized(async () => {
        throwIfAborted(signal)
        const value = parseCommand(input)
        const existing = state().commands.find(e => e.command.commandId === value.commandId)
        if (existing && !same(existing.command, value)) throw new SessionRunnerError("command_conflict", "A command ID cannot be reused with different input.")
        if (!existing) {
          if (state().commands.length >= MAX_COMMAND_ENTRIES) throw new SessionRunnerError("journal_full", "Prune acknowledged commands before accepting more work.")
          const expired = value.expiresAt <= now()
          await persist({ ...state(), commands: [...state().commands, {
            command: value, creation, sendReplay, intendedSessionId: sessionIdForCommand(value.commandId), lastObservedAt: null,
            phase: expired ? "failed" : "prepared", receipt: null,
            promptMessageId: value.prompt === null ? null : stableMessageId(value.commandId), turn: null, lastMessageId: null,
            completion: expired ? { status: "failed", error: failure("expired", "The command expired before creation.") } : null,
            completionAcknowledged: false, progress: null, reportedProgress: null,
          }] })
        }
        // First at-most-once dispatch is permitted; all later prepared replays need the pinned idempotent capability.
        await createPrepared(value.commandId, signal, !existing)
        throwIfAborted(signal)
        const completion = await deliver(value.commandId, signal)
        await flushCommand(value.commandId, signal)
        return structuredClone(completion)
      })
    },
    execute(input, signal) {
      return serialized(async () => {
        throwIfAborted(signal)
        const value = parseRequest(input)
        const existing = state().requests.find(e => e.request.requestId === value.requestId)
        if (existing && !same(existing.request, value)) throw new SessionRunnerError("request_conflict", "A request ID cannot be reused with different input.")
        if (!existing) {
          if (state().requests.length >= MAX_REQUEST_ENTRIES) throw new SessionRunnerError("journal_full", "Prune acknowledged requests before accepting more work.")
          const c = state().commands.find(c => c.command.commandId === value.commandId && c.phase === "delivered"
            && c.receipt?.sessionId === value.sessionId && c.receipt.workspaceId === value.workspaceId)
          let completion: RequestComplete | null = !c ? { status: "failed", error: failure("unknown_receipt",
            "Only a session delivered by this account's local journal can be controlled.") } : null
          const id = value.action === "send" ? value.input.messageId ?? stableMessageId(value.requestId)
            : value.action === "stop" ? value.input.messageId ?? c?.lastMessageId ?? null : null
          if (c && value.action === "send") {
            const prior = state().requests.find(r => r.request.commandId === value.commandId && r.messageId === id && r.request.action === "send")
            const original = c.promptMessageId === id ? { prompt: c.command.prompt, model: c.command.model } : null
            const fingerprint = original ?? (prior?.request.action === "send" ? prior.request.input : null)
            if (fingerprint && !same({ prompt: fingerprint.prompt, model: fingerprint.model }, { prompt: value.input.prompt, model: value.input.model })) {
              completion = { status: "failed", error: failure("message_conflict", "A stable message ID cannot be reused with different prompt or model input.") }
            } else if (original || prior?.completion?.status === "done") {
              completion = { status: "done", outcome: { action: "send", result: { messageId: id, alreadyPresent: true } } }
            }
          }
          await persist({ ...state(), requests: [...state().requests, { request: value, sendReplay, messageId: id, turn: null, completion, completionAcknowledged: false }] })
        }
        const completion = await performRequest(value.requestId, signal)
        await flushRequest(value.requestId, signal)
        return structuredClone(completion)
      })
    },
    reconcile(signal) {
      return serialized(async () => {
        throwIfAborted(signal)
        let firstError: unknown
        const attempt = async (operation: () => Promise<void>) => {
          throwIfAborted(signal)
          try { await operation() }
          catch (error) {
            if (signal.aborted || poisoned) throw error
            firstError ??= error
          }
        }
        for (const e of state().commands) await attempt(async () => {
          await createPrepared(e.command.commandId, signal)
          await deliver(e.command.commandId, signal)
          await flushCommand(e.command.commandId, signal)
        })
        for (const e of state().requests) await attempt(async () => {
          await performRequest(e.request.requestId, signal)
          await flushRequest(e.request.requestId, signal)
        })
        for (const e of state().commands) await attempt(() => watch(e.command.commandId, signal))
        if (firstError !== undefined) throw firstError
      })
    },
    inspect() { return serialized(async () => structuredClone(state())) },
    prune(pruneOptions = {}) {
      return serialized(async () => {
        const retainCommands = integer(pruneOptions.retainCommands ?? 128, 0, MAX_COMMAND_ENTRIES)
        const retainRequests = integer(pruneOptions.retainRequests ?? 128, 0, MAX_REQUEST_ENTRIES)
        const requests = [...state().requests]
        let toRemove = Math.max(0, requests.length - retainRequests)
        const retainedRequests = requests.filter(e => {
          if (toRemove > 0 && e.completionAcknowledged && e.request.expiresAt <= now()) { toRemove--; return false }
          return true
        })
        toRemove = Math.max(0, state().commands.length - retainCommands)
        const commands = state().commands.filter(e => {
          const terminal = e.phase === "failed" || e.reportedProgress?.status === "idle" || e.reportedProgress?.status === "error"
          if (toRemove > 0 && terminal && e.completionAcknowledged && e.progress === null && e.command.expiresAt <= now()
            && !retainedRequests.some(r => r.request.commandId === e.command.commandId)) { toRemove--; return false }
          return true
        })
        await persist({ ...state(), commands, requests: retainedRequests })
        return structuredClone(state())
      })
    },
  }
}
