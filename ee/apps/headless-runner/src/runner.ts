import { FILE_TOOLS, FILE_TOOL_NAMES, runFileTool } from "./files.js"
import type { McpConnector, ToolSession } from "./mcp.js"
import { ModelError, type ModelClient } from "./model.js"
import type { Store, StoredMessage, Turn } from "./store.js"
import { RESUMABLE, type Message, type ToolResult, type TurnCredentials } from "./types.js"

export const DEFAULT_SYSTEM_PROMPT = `You are OpenWork, an assistant running in the cloud on behalf of one person. There is no UI and nobody can approve actions while you work.

- Use the OpenWork tools (for example search_capabilities, then execute_capability) to reach the person's connected apps and skills.
- Prefer reading and drafting. Only change data in the person's apps (send, post, create, update, delete) when their message explicitly asks for that exact action.
- You have a small scratch workspace (list_files, read_file, write_file, edit_file, delete_file) that persists for this conversation. Use it for notes and drafts.
- Reply concisely in Markdown.`

export type RunnerOptions = {
  store: Store
  model: ModelClient
  defaultModel: string
  defaultModelApiKey?: string
  mcp?: McpConnector
  limits: { maxConcurrentTurns: number; maxSteps: number; turnTimeoutMs: number; contextCharBudget: number }
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
  | { ok: false; error: "unknown_session" | "session_busy" }

type Job = { sessionId: string; messageId: string }

/** Keeps whole turns, newest first, within a character budget. The current turn is always kept. */
export function buildContext(messages: StoredMessage[], currentMessageId: string, budget: number): Message[] {
  const turns: StoredMessage[][] = []
  for (const message of messages) {
    const last = turns.at(-1)
    if (last && last[0].messageId === message.messageId) last.push(message)
    else turns.push([message])
  }
  const kept: StoredMessage[][] = []
  let used = 0
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const turn = turns[index]
    const size = turn.reduce((sum, entry) => sum + JSON.stringify(entry.message).length, 0)
    const isCurrent = turn[0].messageId === currentMessageId
    if (!isCurrent && used + size > budget) break
    kept.unshift(turn)
    used += size
  }
  return kept.flat().map((entry) => entry.message)
}

/** Tool calls whose result was never recorded (process crashed or turn was aborted mid-call). */
function unansweredCalls(messages: Message[]) {
  const answered = new Set(messages.flatMap((message) => (message.role === "tool" ? [message.callId] : [])))
  return messages.flatMap((message) =>
    message.role === "assistant" ? message.toolCalls.filter((call) => !answered.has(call.id)) : [],
  )
}

export class Runner {
  private readonly controllers = new Map<string, AbortController>()
  private readonly credentials = new Map<string, TurnCredentials>()
  private readonly queue: Job[] = []
  private readonly running = new Set<Promise<void>>()
  private activeCount = 0

  constructor(private readonly options: RunnerOptions) {}

  send(input: SendInput): SendResult {
    const { store } = this.options
    if (!store.getSession(input.sessionId)) return { ok: false, error: "unknown_session" }
    const existing = store.getTurn(input.sessionId, input.messageId)
    const active = store.activeTurn(input.sessionId)
    if (existing && !RESUMABLE.has(existing.status)) return { ok: true, state: "already_present", turn: existing }
    if (active) return { ok: false, error: "session_busy" }
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

  /** Requests a stop of the session's active turn. */
  abort(sessionId: string): boolean {
    const controller = this.controllers.get(sessionId)
    if (controller) {
      controller.abort(new Error("aborted"))
      return true
    }
    const queuedIndex = this.queue.findIndex((job) => job.sessionId === sessionId)
    if (queuedIndex < 0) return false
    const [job] = this.queue.splice(queuedIndex, 1)
    this.credentials.delete(`${job.sessionId}:${job.messageId}`)
    this.options.store.setTurnStatus(job.sessionId, job.messageId, "aborted")
    return true
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
    for (const controller of this.controllers.values()) controller.abort(new Error("shutdown"))
    await Promise.all([...this.running])
  }

  private pump() {
    while (this.activeCount < this.options.limits.maxConcurrentTurns && this.queue.length) {
      const job = this.queue.shift()
      if (!job) break
      this.activeCount += 1
      const promise = this.runTurn(job).finally(() => {
        this.activeCount -= 1
        this.running.delete(promise)
        this.pump()
      })
      this.running.add(promise)
    }
  }

  private async runTurn({ sessionId, messageId }: Job) {
    const { store, limits } = this.options
    const key = `${sessionId}:${messageId}`
    const credentials = this.credentials.get(key) ?? {}
    this.credentials.delete(key)
    const controller = new AbortController()
    this.controllers.set(sessionId, controller)
    const timeout = setTimeout(() => controller.abort(new Error("turn_timeout")), limits.turnTimeoutMs)
    const signal = controller.signal
    let tools: ToolSession | null = null

    const turnMessages = () =>
      store.messages(sessionId).filter((entry) => entry.messageId === messageId).map((entry) => entry.message)
    const closeUnanswered = (reason: string) => {
      for (const call of unansweredCalls(turnMessages())) {
        store.appendMessage(sessionId, messageId, { role: "tool", callId: call.id, name: call.name, output: reason, isError: true })
      }
    }

    try {
      store.setTurnStatus(sessionId, messageId, "running")
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
        const result = await this.options.model.complete({
          system,
          messages: buildContext(store.messages(sessionId), messageId, limits.contextCharBudget),
          tools: toolSpecs,
          model: turn?.model ?? this.options.defaultModel,
          apiKey,
          signal,
        })
        store.addUsage(sessionId, messageId, result.usage)
        store.appendMessage(sessionId, messageId, { role: "assistant", text: result.text, toolCalls: result.toolCalls })
        if (result.toolCalls.length === 0) {
          store.setTurnStatus(sessionId, messageId, "completed")
          return
        }
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
          store.appendMessage(sessionId, messageId, { role: "tool", callId: call.id, name: call.name, ...outcome })
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
      this.controllers.delete(sessionId)
      await tools?.close()
    }
  }
}
