import {
  createHeadlessRunnerClient,
  defaultHeadlessRunnerDeps,
  headlessRunnerConfig,
  stepLabel,
  TERMINAL_TURN_STATUSES,
  type HeadlessRunnerActor,
  type HeadlessRunnerDeps,
  type RunnerRepeatLimits,
} from "../headless-runner/client.js"
import { isModelAccessRefusal } from "../headless-runner/model-access-refusal.js"

export { headlessRunnerConfig, stepLabel }
export type HeadlessDeps = HeadlessRunnerDeps

type SlackModelDeps = {
  cloudModel: (actor: HeadlessRunnerActor, fallback?: string | null) => Promise<string | null>
}

export async function slackTurnModel(
  installation: { organizationId: string; model: string | null },
  actor: { userId: string },
  suppliedDeps?: SlackModelDeps,
) {
  const deps: SlackModelDeps = suppliedDeps ?? await import("../workbot/model.js").then((policy) => ({
    cloudModel: policy.organizationCloudModelSelection,
  }))
  const model = await deps.cloudModel({ organizationId: installation.organizationId, userId: actor.userId }, installation.model)
  if (!model) throw new Error("cloud_agent_model_unavailable")
  return model
}

export function slackRunnerAvailable(env: Record<string, string | undefined> = process.env) {
  return headlessRunnerConfig(env) !== null
}

export function slackHeadlessDeps(base: HeadlessDeps | null = defaultHeadlessRunnerDeps()): HeadlessDeps | null {
  if (!base) return null
  return {
    ...base,
    mintToken: async (input) => {
      const minted = await (await import("../headless-runner/resume-grants.js")).mintHeadlessTurnCredentials({ ...input, indexKind: "slack" })
      try {
        const { recordSlackRunToken } = await import("./desktop-handoff.js")
        await recordSlackRunToken({ tokenId: minted.tokenId, expiresAt: minted.expiresAt, userId: input.userId, messageId: input.messageId })
      } catch {
      }
      return minted
    },
  }
}

export const SLACK_REPEAT_LIMITS: RunnerRepeatLimits = { maxWaitingMs: 10 * 60_000, maxIdenticalFailures: 3 }

export async function listHeadlessModels(suppliedDeps: HeadlessDeps | null = defaultHeadlessRunnerDeps()) {
  if (!suppliedDeps) return null
  return createHeadlessRunnerClient(suppliedDeps).listModels()
}

export type RunnerFailure = { ok: false; error: string; retryable: boolean; retryAfterMs?: number }
export type RunnerOutcome<T> = ({ ok: true } & T) | RunnerFailure

export type SlackRunStep = { id: string; label: string; status: "running" | "completed" | "error" }

export type SlackBackgroundTurn = { id: string; title: string; status: string }

export type SlackSessionSettings = { instructions: string; reactions: boolean; tasks: boolean }

export const TASK_STARTED_LINE = "I'm on it in the background and will post the result here."

export type SlackRunSnapshot = {
  status: "busy" | "idle"
  finalAssistantText: string
  lastAssistantText: string
  terminalError?: { code: string }
  steps: SlackRunStep[]
  assistantTexts: string[]
  assistantWorked: boolean[]
  reaction?: { emoji: string; final: boolean }
  tasks: SlackBackgroundTurn[]
}

export type SlackRunner = {
  create(input: { title: string; settings?: SlackSessionSettings }): Promise<RunnerOutcome<{ sessionId: string }>>
  send(input: {
    sessionId: string
    messageId: string
    prompt: string
    model?: string
    modelAccessRequired?: boolean
    resolveModel?: () => Promise<string | undefined>
    settings?: SlackSessionSettings
  }): Promise<RunnerOutcome<{ accepted: boolean }>>
  read(input: { sessionId: string; messageId: string }): Promise<RunnerOutcome<{ snapshot: SlackRunSnapshot }>>
  stop(input: { sessionId: string; messageId: string }): Promise<void>
  background(input: {
    sessionId: string
    messageId: string
  }): Promise<RunnerOutcome<{ tasks: SlackBackgroundTurn[]; reports: Array<SlackBackgroundTurn & { task: string }> }>>
  turnText(input: { sessionId: string; messageId: string }): Promise<RunnerOutcome<{ text: string }>>
}

export async function openSlackRunnerEvents(
  sessionId: string,
  signal: AbortSignal,
  deps: HeadlessDeps | null = defaultHeadlessRunnerDeps(),
): Promise<ReadableStream<Uint8Array> | null> {
  if (!deps) return null
  const response = await createHeadlessRunnerClient(deps).openEvents(sessionId, signal)
  return response?.body ?? null
}

function stepOf(tool: { id: string; name: string; input: Record<string, unknown> }) {
  if (tool.name === "react") return null
  if (tool.name === "start_task") {
    const title = typeof tool.input.title === "string" ? tool.input.title.trim().slice(0, 80) : ""
    return title ? `Started in the background: ${title}` : "Started a background task"
  }
  if (tool.name === "stop_task") return "Stopping a background task"
  return stepLabel(tool.name, tool.input)
}

const retryable = (error: string): RunnerFailure => ({ ok: false, error, retryable: true, retryAfterMs: 5_000 })
const unknownSession: RunnerFailure = { ok: false, error: "unknown_session", retryable: false }

export type SlackRunnerOptions = {
  stepTurns?: () => Promise<boolean>
}

export function slackRunnerForActor(actor: HeadlessRunnerActor, suppliedDeps: HeadlessDeps | null = slackHeadlessDeps()): SlackRunner {
  return createSlackRunner(actor, suppliedDeps)
}

export function createSlackRunner(
  actor: HeadlessRunnerActor,
  suppliedDeps: HeadlessDeps | null = slackHeadlessDeps(),
  options: SlackRunnerOptions = {},
): SlackRunner {
  if (!suppliedDeps) {
    const missing: RunnerFailure = { ok: false, error: "headless_runner_not_configured", retryable: false }
    return {
      create: async () => missing,
      send: async () => missing,
      read: async () => missing,
      stop: async () => {},
      background: async () => missing,
      turnText: async () => missing,
    }
  }
  const client = createHeadlessRunnerClient(suppliedDeps)

  const send: SlackRunner["send"] = async (input) => {
    if (input.settings) {
      const saved = await client.putSession(input.sessionId, { ...input.settings, repeats: SLACK_REPEAT_LIMITS })
      if (!saved.ok && (saved.status === 404 || saved.error === "invalid_session_id")) return unknownSession
      if (!saved.ok) return retryable(`headless_put_${saved.status}`)
    }
    const execution: "steps" | undefined = (options.stepTurns ? await options.stepTurns().catch(() => false) : true) ? "steps" : undefined
    let sent
    try {
      let model = input.model
      let modelAccessRequired = input.modelAccessRequired
      if (input.resolveModel) {
        const read = await client.readSession(input.sessionId, { messageId: input.messageId, limit: 1, outputs: "none" })
        if (!read.ok && read.status === 404) return unknownSession
        if (!read.ok) return retryable(`headless_read_${read.status}`)
        const existing = read.value.turns.find((turn) => turn.messageId === input.messageId)
        if (existing) {
          model = existing.model ?? undefined
          modelAccessRequired ||= existing.modelAccessRequired === true
        } else {
          model = await input.resolveModel()
        }
      }
      sent = await client.sendTurn(actor, {
        sessionId: input.sessionId,
        messageId: input.messageId,
        prompt: input.prompt,
        ...(model ? { model } : {}),
        ...(modelAccessRequired ? { modelAccessRequired: true } : {}),
        ...(execution ? { execution } : {}),
      })
    } catch (error) {
      if (isModelAccessRefusal(error)) return { ok: false, error: "model_access_unavailable", retryable: false }
      return retryable("headless_send_unavailable")
    }
    if (sent.ok) return { ok: true, accepted: sent.value.state === "accepted" }
    if (sent.status === 404) return unknownSession
    if (sent.error === "headless_saved_model_unavailable" || sent.error === "headless_model_access_unavailable") {
      return { ok: false, error: "model_access_unavailable", retryable: false }
    }
    return retryable(`headless_send_${sent.status}`)
  }

  const resume = async (sessionId: string, messageId: string, model?: string, modelAccessRequired?: boolean) => send({ sessionId, messageId, prompt: "resume", model, modelAccessRequired })

  return {
    async create(input) {
      const created = await client.createSession({ title: input.title, repeats: SLACK_REPEAT_LIMITS, ...input.settings })
      if (!created.ok) return retryable(`headless_create_${created.status}`)
      return { ok: true, sessionId: created.value.id }
    },

    send,

    async background(input) {
      const read = await client.readSession(input.sessionId, { messageId: input.messageId, limit: 1, outputs: "none" })
      if (!read.ok && read.status === 404) return unknownSession
      if (!read.ok) return retryable(`headless_read_${read.status}`)
      const tasks = read.value.turns
        .filter((turn) => turn.kind === "task" && turn.parent === input.messageId)
        .map((turn) => ({ id: turn.messageId, title: turn.title ?? "", status: turn.status }))
      const ids = new Set(tasks.map((task) => task.id))
      const reports = read.value.turns
        .filter((turn) => turn.kind === "report" && turn.parent !== undefined && ids.has(turn.parent))
        .map((turn) => ({ id: turn.messageId, title: turn.title ?? "", status: turn.status, task: turn.parent ?? "" }))
      for (const turn of [...tasks, ...reports]) {
        if (turn.status !== "interrupted") continue
        const stored = read.value.turns.find((entry) => entry.messageId === turn.id)
        const resumed = await resume(input.sessionId, turn.id, stored?.model ?? undefined, stored?.modelAccessRequired)
        if (!resumed.ok) return resumed
        turn.status = "queued"
      }
      return { ok: true, tasks, reports }
    },

    async turnText(input) {
      const read = await client.readSession(input.sessionId, { messageId: input.messageId, limit: 200, outputs: "none" })
      if (!read.ok && read.status === 404) return unknownSession
      if (!read.ok) return retryable(`headless_read_${read.status}`)
      const text =
        read.value.messages.flatMap((message) => (message.role === "assistant" && message.text.trim() ? [message.text] : [])).at(-1) ?? ""
      return { ok: true, text }
    },

    async stop(input) {
      await client.abort(input.sessionId, input.messageId || undefined)
    },

    async read(input) {
      const read = await client.readSession(input.sessionId, { messageId: input.messageId, limit: 500, outputs: "none" })
      if (!read.ok && read.status === 404) return unknownSession
      if (!read.ok) return retryable(`headless_read_${read.status}`)
      const snapshot = read.value
      const turn = snapshot.turns.find((entry) => entry.messageId === input.messageId)

      if (turn?.status === "interrupted") {
        const resumed = await resume(input.sessionId, input.messageId, turn.model ?? undefined, turn.modelAccessRequired)
        if (!resumed.ok) return resumed
      }

      const messages = snapshot.messages
      const results = new Map(
        messages.flatMap((message) => (message.role === "tool" ? [[message.callId, message.isError] as const] : [])),
      )
      const terminal = turn !== undefined && TERMINAL_TURN_STATUSES.has(turn.status)
      const failed = turn?.status === "failed"
      const assistant = messages.flatMap((message) => (message.role === "assistant" ? [message] : []))
      const reacted = assistant
        .flatMap((message) => message.toolCalls)
        .find((tool) => tool.name === "react" && results.get(tool.id) === false && typeof tool.input.emoji === "string")
      const reaction = reacted ? { emoji: String(reacted.input.emoji), final: reacted.input.final === true } : undefined
      const tasks = snapshot.turns
        .filter((entry) => entry.kind === "task" && entry.parent === input.messageId)
        .map((entry) => ({ id: entry.messageId, title: entry.title ?? "", status: entry.status }))
      let finalAssistantText = snapshot.finalAssistantText
      if (terminal && !failed && !finalAssistantText && !reaction) finalAssistantText = tasks.length ? TASK_STARTED_LINE : "Done."
      const lastAssistantText =
        messages.flatMap((message) => (message.role === "assistant" && message.text.trim() ? [message.text] : [])).at(-1) ?? ""
      return {
        ok: true,
        snapshot: {
          status: terminal ? "idle" : "busy",
          finalAssistantText,
          lastAssistantText: lastAssistantText || finalAssistantText,
          ...(failed ? { terminalError: { code: turn.error ?? "headless_run_failed" } } : {}),
          steps: assistant.flatMap((message) =>
            message.toolCalls.flatMap((tool): SlackRunStep[] => {
              const label = stepOf(tool)
              if (label === null) return []
              const outcome = results.get(tool.id)
              return [{ id: tool.id, label, status: outcome === undefined ? "running" : outcome ? "error" : "completed" }]
            }),
          ),
          assistantTexts: assistant.map((message) => message.text),
          assistantWorked: assistant.map((message) => message.toolCalls.some((tool) => tool.name !== "react")),
          ...(reaction ? { reaction } : {}),
          tasks,
        },
      }
    },
  }
}
