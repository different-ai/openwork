import { createHash } from "node:crypto"
import { FILE_TOOLS, FILE_TOOL_NAMES, runFileTool } from "./files.js"
import type { McpConnector, ToolSession } from "./mcp.js"
import { ModelError, type ModelClient } from "./model.js"
import type { Store, StoredMessage, Turn } from "./store.js"
import { RESUMABLE, type Message, type ToolResult, type TurnCredentials } from "./types.js"

export const DEFAULT_SYSTEM_PROMPT = `You are OpenWork, an assistant running in the cloud on behalf of one person. There is no UI and nobody can approve actions while you work.

- Use the OpenWork tools (for example search_capabilities, then execute_capability) to reach the person's connected apps and skills.
- Prefer reading and drafting. Only change data in the person's apps (send, post, create, update, delete) when their message explicitly asks for that exact action.
- You have a small scratch workspace (list_files, read_file, write_file, edit_file, delete_file) that persists for this conversation. Use it for notes and drafts.
- On a long task the person may only see your final message, so make it a complete answer on its own.
- Reply concisely in Markdown.`

/** A step that repeats the same calls and gets the same results this many times in a row ends the turn. */
export const MAX_IDENTICAL_STEPS = 5

export type RunnerOptions = {
  store: Store
  model: ModelClient
  defaultModel: string
  defaultModelApiKey?: string
  mcp?: McpConnector
  limits: {
    maxConcurrentTurns: number
    /** Infinity for no step limit. */
    maxSteps: number
    /** Infinity for no turn timeout. */
    turnTimeoutMs: number
    /** A turn using a caller's MCP token pauses between steps after this long, to be resumed with a fresh one. */
    credentialRefreshMs: number
    contextCharBudget: number
  }
  systemPrompt?: string
  now?: () => number
}

export type SendInput = {
  sessionId: string
  messageId: string
  prompt: string
  model?: string
  credentials: TurnCredentials
}
export type SendResult =
  | { ok: true; state: "accepted" | "resumed" | "already_present"; turn: Turn }
  | { ok: false; error: "unknown_session" | "too_many_queued" }

/** Follow-ups a person can stack behind a running turn in one conversation. */
export const MAX_QUEUED_PER_SESSION = 20

type Job = { sessionId: string; messageId: string }

/** Stands in for an older tool result in a long turn; the call, and whether it failed, stay in context. */
export const TRIMMED_TOOL_OUTPUT =
  "[Output removed to keep this long task within the model's context. Run the tool again if you still need it.]"
/** Outputs shorter than this are kept: removing them saves little. */
const TRIM_MIN_CHARS = 1_000
/**
 * Outputs are removed in blocks, so the context prefix changes only every few steps and the prompt cache keeps
 * hitting in between.
 */
const TRIM_BLOCK = 8

const messageSize = (message: Message) => (message.role === "tool" ? message.output.length + 200 : JSON.stringify(message).length)

/** A turn bigger than the budget on its own keeps every call and its newest outputs; the oldest large outputs go first. */
function fitTurn(turn: Message[], budget: number): Message[] {
  let size = turn.reduce((sum, message) => sum + messageSize(message), 0)
  if (size <= budget) return turn
  const candidates = turn.flatMap((message, index) =>
    message.role === "tool" && message.output.length > TRIM_MIN_CHARS ? [{ index, saved: message.output.length - TRIMMED_TOOL_OUTPUT.length }] : [],
  )
  let count = 0
  while (count < candidates.length && size > budget) {
    size -= candidates[count].saved
    count += 1
  }
  const trimmed = new Set(candidates.slice(0, Math.min(candidates.length, Math.ceil(count / TRIM_BLOCK) * TRIM_BLOCK)).map((candidate) => candidate.index))
  return turn.map((message, index) =>
    trimmed.has(index) && message.role === "tool" ? { ...message, output: TRIMMED_TOOL_OUTPUT, images: undefined } : message,
  )
}

/**
 * Keeps whole turns, newest first, within a character budget. The current turn is always kept; when it alone
 * outgrows the budget (a long task), its oldest large tool outputs are replaced by a short note.
 */
export function buildContext(messages: StoredMessage[], currentMessageId: string, budget: number): Message[] {
  const turns: StoredMessage[][] = []
  for (const message of messages) {
    const last = turns.at(-1)
    if (last && last[0].messageId === message.messageId) last.push(message)
    else turns.push([message])
  }
  const kept: Message[][] = []
  let used = 0
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const turn = turns[index]
    const isCurrent = turn[0].messageId === currentMessageId
    const entries = isCurrent
      ? fitTurn(turn.map((entry) => entry.message), budget)
      : // Images are large; the model sees them in the turn that fetched them, earlier turns keep the text.
        turn.map(({ message }) =>
          message.role === "tool" && message.images
            ? { ...message, images: undefined, output: `${message.output}\n[images from an earlier turn not shown]` }
            : message,
        )
    const size = entries.reduce((sum, message) => sum + messageSize(message), 0)
    if (!isCurrent && used + size > budget) break
    kept.unshift(entries)
    used += size
  }
  return kept.flat()
}

/** Tool calls whose result was never recorded (process crashed or turn was aborted mid-call). */
function unansweredCalls(messages: Message[]) {
  const answered = new Set(messages.flatMap((message) => (message.role === "tool" ? [message.callId] : [])))
  return messages.flatMap((message) =>
    message.role === "assistant" ? message.toolCalls.filter((call) => !answered.has(call.id)) : [],
  )
}

export class Runner {
  /** The one running turn per session. Other turns for that session wait in the queue, in order. */
  private readonly controllers = new Map<string, { messageId: string; controller: AbortController }>()
  private readonly credentials = new Map<string, TurnCredentials>()
  private readonly queue: Job[] = []
  private readonly running = new Set<Promise<void>>()
  private activeCount = 0

  constructor(private readonly options: RunnerOptions) {}

  send(input: SendInput): SendResult {
    const { store } = this.options
    if (!store.getSession(input.sessionId)) return { ok: false, error: "unknown_session" }
    const existing = store.getTurn(input.sessionId, input.messageId)
    if (existing && !RESUMABLE.has(existing.status)) return { ok: true, state: "already_present", turn: existing }
    // A message sent while another turn runs is not an error: it is queued and answered next.
    const queued = this.queue.filter((job) => job.sessionId === input.sessionId).length
    if (queued >= MAX_QUEUED_PER_SESSION) return { ok: false, error: "too_many_queued" }
    let state: "accepted" | "resumed"
    if (existing) {
      store.setTurnStatus(input.sessionId, input.messageId, "queued")
      state = "resumed"
    } else {
      store.admitTurn({ ...input, model: input.model ?? null })
      state = "accepted"
    }
    this.credentials.set(`${input.sessionId}:${input.messageId}`, input.credentials)
    this.queue.push({ sessionId: input.sessionId, messageId: input.messageId })
    this.pump()
    const turn = store.getTurn(input.sessionId, input.messageId)
    if (!turn) throw new Error("turn_missing_after_admission")
    return { ok: true, state, turn }
  }

  /**
   * Stops one turn (by messageId) or, without a messageId, the running turn and
   * every follow-up queued behind it.
   */
  abort(sessionId: string, messageId?: string): boolean {
    let stopped = false
    const running = this.controllers.get(sessionId)
    if (running && (!messageId || running.messageId === messageId)) {
      running.controller.abort(new Error("aborted"))
      stopped = true
    }
    for (let index = this.queue.length - 1; index >= 0; index -= 1) {
      const job = this.queue[index]
      if (job.sessionId !== sessionId || (messageId && job.messageId !== messageId)) continue
      this.queue.splice(index, 1)
      this.credentials.delete(`${job.sessionId}:${job.messageId}`)
      this.options.store.setTurnStatus(job.sessionId, job.messageId, "aborted")
      stopped = true
    }
    return stopped
  }

  /** Resolves when every queued and running turn has settled. */
  async idle() {
    while (this.running.size || this.queue.length) await Promise.all([...this.running])
  }

  /** Stops accepting work and interrupts in-flight turns so they can be resumed later. */
  async shutdown() {
    for (const job of this.queue.splice(0)) {
      this.options.store.setTurnStatus(job.sessionId, job.messageId, "interrupted", "runner_shutdown")
    }
    for (const { controller } of this.controllers.values()) controller.abort(new Error("shutdown"))
    await Promise.all([...this.running])
  }

  /** Starts queued turns in order, at most one per session and maxConcurrentTurns overall. */
  private pump() {
    for (let index = 0; index < this.queue.length && this.activeCount < this.options.limits.maxConcurrentTurns; ) {
      const job = this.queue[index]
      if (this.controllers.has(job.sessionId)) {
        index += 1
        continue
      }
      this.queue.splice(index, 1)
      this.activeCount += 1
      const controller = new AbortController()
      this.controllers.set(job.sessionId, { messageId: job.messageId, controller })
      const promise = this.runTurn(job, controller).finally(() => {
        this.activeCount -= 1
        this.controllers.delete(job.sessionId)
        this.running.delete(promise)
        this.pump()
      })
      this.running.add(promise)
    }
  }

  private async runTurn({ sessionId, messageId }: Job, controller: AbortController) {
    const { store, limits } = this.options
    const key = `${sessionId}:${messageId}`
    const credentials = this.credentials.get(key) ?? {}
    this.credentials.delete(key)
    const timeout = Number.isFinite(limits.turnTimeoutMs)
      ? setTimeout(() => controller.abort(new Error("turn_timeout")), limits.turnTimeoutMs)
      : undefined
    const signal = controller.signal
    let tools: ToolSession | null = null
    const startedAt = Date.now()
    let steps = 0
    let toolCalls = 0
    let lastStep = ""
    let identicalSteps = 0
    console.log(`[headless-runner] turn started ${JSON.stringify({ sessionId, messageId })}`)

    const turnMessages = () =>
      store.messages(sessionId).filter((entry) => entry.messageId === messageId).map((entry) => entry.message)
    const closeUnanswered = (reason: string) => {
      for (const call of unansweredCalls(turnMessages())) {
        store.appendMessage(sessionId, messageId, { role: "tool", callId: call.id, name: call.name, output: reason, isError: true })
      }
    }

    try {
      store.setTurnStatus(sessionId, messageId, "running")
      store.startTranscript(sessionId, messageId)
      // A resumed turn never re-runs a tool call whose outcome is unknown: it may have had side effects.
      closeUnanswered("This tool call was interrupted before it returned. It was not retried; check its effect before repeating it.")
      const last = turnMessages().at(-1)
      if (last?.role === "assistant" && last.toolCalls.length === 0) {
        store.setTurnStatus(sessionId, messageId, "completed")
        return
      }

      const apiKey = credentials.modelApiKey ?? this.options.defaultModelApiKey
      if (!apiKey) {
        store.setTurnStatus(sessionId, messageId, "failed", "model_credentials_missing")
        return
      }
      if (this.options.mcp && credentials.mcpToken) {
        try {
          tools = await this.options.mcp({ token: credentials.mcpToken, signal })
        } catch (error) {
          if (signal.aborted) throw error
          store.setTurnStatus(sessionId, messageId, "failed", "mcp_unavailable")
          return
        }
      }
      const session = store.getSession(sessionId)
      const turn = store.getTurn(sessionId, messageId)
      const system = [
        this.options.systemPrompt ?? DEFAULT_SYSTEM_PROMPT,
        tools ? "" : "No OpenWork connection is available in this conversation, so connected apps cannot be reached.",
        session?.instructions ?? "",
        `Current time: ${new Date(this.options.now?.() ?? Date.now()).toISOString()}`,
      ]
        .filter(Boolean)
        .join("\n\n")
      const toolSpecs = [...FILE_TOOLS, ...(tools?.tools ?? [])]

      for (let step = 0; step < limits.maxSteps; step += 1) {
        signal.throwIfAborted()
        // Between steps, never mid-call, so no tool is cut off. The caller resumes the turn right away with a
        // fresh MCP token; a caller that stopped supervising simply never resumes it.
        if (tools && step > 0 && Date.now() - startedAt >= limits.credentialRefreshMs) {
          store.setTurnStatus(sessionId, messageId, "interrupted", "credentials_refresh")
          return
        }
        const result = await this.options.model.complete({
          system,
          messages: buildContext(store.messages(sessionId), messageId, limits.contextCharBudget),
          tools: toolSpecs,
          model: turn?.model ?? this.options.defaultModel,
          apiKey,
          signal,
        })
        steps += 1
        toolCalls += result.toolCalls.length
        store.addUsage(sessionId, messageId, result.usage)
        store.appendMessage(sessionId, messageId, { role: "assistant", text: result.text, toolCalls: result.toolCalls })
        if (result.toolCalls.length === 0) {
          store.setTurnStatus(sessionId, messageId, "completed")
          return
        }
        const outcomes: ToolResult[] = []
        for (const call of result.toolCalls) {
          signal.throwIfAborted()
          const outcome: ToolResult = call.inputError
            ? { output: call.inputError, isError: true }
            : FILE_TOOL_NAMES.has(call.name)
              ? runFileTool(store, sessionId, call.name, call.input)
              : tools
                ? await tools.call(call.name, call.input, signal).catch((error: unknown) => ({
                    output: `Tool call failed: ${error instanceof Error ? error.message : "unknown error"}`,
                    isError: true,
                  }))
                : { output: `Unknown tool: ${call.name}`, isError: true }
          store.appendMessage(sessionId, messageId, {
            role: "tool",
            callId: call.id,
            name: call.name,
            output: outcome.output,
            isError: outcome.isError,
            ...(outcome.images?.length ? { images: outcome.images } : {}),
          })
          outcomes.push(outcome)
        }
        // Same calls, same inputs, same results, again and again: the model is stuck, not making progress.
        const signature = createHash("sha256")
          .update(JSON.stringify(result.toolCalls.map((call, index) => [call.name, call.input, outcomes[index]?.output, outcomes[index]?.isError])))
          .digest("hex")
        identicalSteps = signature === lastStep ? identicalSteps + 1 : 1
        lastStep = signature
        if (identicalSteps >= MAX_IDENTICAL_STEPS) {
          store.setTurnStatus(sessionId, messageId, "failed", "stuck_repeating")
          return
        }
      }
      store.setTurnStatus(sessionId, messageId, "failed", "max_steps_exceeded")
    } catch (error) {
      const reason = signal.reason instanceof Error ? signal.reason.message : null
      closeUnanswered(reason === "turn_timeout" ? "The turn timed out before this tool call returned." : "The turn was stopped before this tool call returned.")
      if (reason === "aborted") store.setTurnStatus(sessionId, messageId, "aborted")
      else if (reason === "shutdown") store.setTurnStatus(sessionId, messageId, "interrupted", "runner_shutdown")
      else if (reason === "turn_timeout") store.setTurnStatus(sessionId, messageId, "failed", "turn_timeout")
      else if (error instanceof ModelError) store.setTurnStatus(sessionId, messageId, "failed", error.code)
      else store.setTurnStatus(sessionId, messageId, "failed", "runner_error")
      if (!(error instanceof ModelError) && !reason) {
        console.error("[headless-runner] turn failed", { sessionId, messageId, error: error instanceof Error ? error.message : "unknown" })
      }
    } finally {
      clearTimeout(timeout)
      await tools?.close()
      // One line per turn, never content or credentials: how it ended, how long it ran, and what it cost.
      const turn = store.getTurn(sessionId, messageId)
      console.log(
        `[headless-runner] turn ended ${JSON.stringify({
          sessionId,
          messageId,
          status: turn?.status,
          error: turn?.error,
          steps,
          toolCalls,
          elapsedMs: Date.now() - startedAt,
          ...turn?.usage,
        })}`,
      )
    }
  }
}
