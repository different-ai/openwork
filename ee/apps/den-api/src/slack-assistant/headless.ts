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

/**
 * Slack runs go to the shared headless runner (ee/apps/headless-runner). This adapter gives the Slack run loop
 * (run.ts) the few calls it needs: create a session, send a turn, read it, stop it.
 *
 * Runs have no time limit. Each MCP token still lives at most 60 minutes: the runner pauses a long turn between
 * steps every 50 minutes, and the read below resumes it at once with a freshly minted token.
 */

export { headlessRunnerConfig, stepLabel }
export type HeadlessDeps = HeadlessRunnerDeps

/** Slack answers only on a deployment with a headless runner (a self-hosted install may not have one). */
export function slackRunnerAvailable(env: Record<string, string | undefined> = process.env) {
  return headlessRunnerConfig(env) !== null
}

/**
 * Slack runs remember which run each minted token belongs to, so work the run
 * hands to the member's desktop reports back to its Slack thread.
 */
export function slackHeadlessDeps(base: HeadlessDeps | null = defaultHeadlessRunnerDeps()): HeadlessDeps | null {
  if (!base) return null
  return {
    ...base,
    // Loaded lazily: the minter pulls in the auth and database modules.
    mintToken: async (input) => {
      const minted = await (await import("../mcp/headless-run-token-mint.js")).mintHeadlessRunMcpToken(input)
      try {
        const { recordSlackRunToken } = await import("./desktop-handoff.js")
        await recordSlackRunToken({ tokenId: minted.tokenId, expiresAt: minted.expiresAt, userId: input.userId, messageId: input.messageId })
      } catch {
        // The run still works; only a desktop handoff's thread report is lost.
      }
      return minted
    },
  }
}

/**
 * Someone is waiting in the thread, and work handed to their desktop reports back there on its own, so a Slack run
 * waits on an unchanged answer for at most 10 minutes and stops after the same failure three times.
 */
export const SLACK_REPEAT_LIMITS: RunnerRepeatLimits = { maxWaitingMs: 10 * 60_000, maxIdenticalFailures: 3 }

/** The models the runner's Gateway route can serve, for the admin's model picker. Null when unavailable. */
export async function listHeadlessModels(suppliedDeps: HeadlessDeps | null = defaultHeadlessRunnerDeps()) {
  if (!suppliedDeps) return null
  return createHeadlessRunnerClient(suppliedDeps).listModels()
}

/**
 * A call the run loop could not complete. `retryable` failures (runner unavailable or overloaded) are tried again;
 * `unknown_session` means the thread's saved session is gone from the runner.
 */
export type RunnerFailure = { ok: false; error: string; retryable: boolean; retryAfterMs?: number }
export type RunnerOutcome<T> = ({ ok: true } & T) | RunnerFailure

/** One step of the turn, with a readable label for Slack's task timeline. */
export type SlackRunStep = { id: string; label: string; status: "running" | "completed" | "error" }

/** A background task a turn started (`<messageId>.tN`), or the report turn that brings one back (`<task>.r`). */
export type SlackBackgroundTurn = { id: string; title: string; status: string }

/**
 * How a thread's runner session is set up before each message. With `slackWorkbotReplies` the instructions live in
 * the session (the provider caches them) and the model may react and start background tasks; without it they are
 * cleared, so turning the feature off also turns them off for threads that had them.
 */
export type SlackSessionSettings = { instructions: string; reactions: boolean; tasks: boolean }

/** What a turn that only started background work, and wrote nothing, says. */
export const TASK_STARTED_LINE = "I'm on it in the background and will post the result here."

export type SlackRunSnapshot = {
  /** idle: the turn ended (completed, failed or stopped). */
  status: "busy" | "idle"
  /** Everything the turn wrote, its notes and answer joined. */
  finalAssistantText: string
  /** The turn's last message alone: the answer a long, quiet run posts. */
  lastAssistantText: string
  terminalError?: { code: string }
  steps: SlackRunStep[]
  /** Text of each of the turn's assistant messages in order, empty ones included: index = the runner's step. */
  assistantTexts: string[]
  /** The emoji the model reacted to the person's message with, if it did. */
  reaction?: { emoji: string; final: boolean }
  /** Background tasks this turn started. */
  tasks: SlackBackgroundTurn[]
}

export type SlackRunner = {
  /** `settings` only with `slackWorkbotReplies`; otherwise the session keeps the runner's defaults. */
  create(input: { title: string; settings?: SlackSessionSettings }): Promise<RunnerOutcome<{ sessionId: string }>>
  /**
   * With `settings`, the session is brought up to date first. `accepted`: the runner started a new turn (not a resend
   * of one it already had), so nothing of it has been written yet.
   */
  send(input: {
    sessionId: string
    messageId: string
    prompt: string
    model?: string
    settings?: SlackSessionSettings
  }): Promise<RunnerOutcome<{ accepted: boolean }>>
  read(input: { sessionId: string; messageId: string }): Promise<RunnerOutcome<{ snapshot: SlackRunSnapshot }>>
  stop(input: { sessionId: string; messageId: string }): Promise<void>
  /** The background tasks a turn started and their reports; interrupted ones are resumed with a fresh token. */
  background(input: {
    sessionId: string
    messageId: string
  }): Promise<RunnerOutcome<{ tasks: SlackBackgroundTurn[]; reports: Array<SlackBackgroundTurn & { task: string }> }>>
  /** What a finished turn (a task's report) wrote last. */
  turnText(input: { sessionId: string; messageId: string }): Promise<RunnerOutcome<{ text: string }>>
}

/** A session's live events from the runner (server-sent), or null when they can't be opened. */
export async function openSlackRunnerEvents(
  sessionId: string,
  signal: AbortSignal,
  deps: HeadlessDeps | null = defaultHeadlessRunnerDeps(),
): Promise<ReadableStream<Uint8Array> | null> {
  if (!deps) return null
  const response = await createHeadlessRunnerClient(deps).openEvents(sessionId, signal)
  return response?.body ?? null
}

/** Runner tools whose calls are not steps a person would recognize, or are shown differently. */
function stepOf(tool: { id: string; name: string; input: Record<string, unknown> }) {
  if (tool.name === "react") return null
  if (tool.name === "start_task") {
    const title = typeof tool.input.title === "string" ? tool.input.title.trim().slice(0, 80) : ""
    return title ? `Started in the background: ${title}` : "Started a background task"
  }
  if (tool.name === "stop_task") return "Stopping a background task"
  return stepLabel(tool.name, tool.input)
}

/** Runner unavailable or overloaded: the Slack run loop retries these. */
const retryable = (error: string): RunnerFailure => ({ ok: false, error, retryable: true, retryAfterMs: 5_000 })
const unknownSession: RunnerFailure = { ok: false, error: "unknown_session", retryable: false }

export function createSlackRunner(
  actor: HeadlessRunnerActor,
  suppliedDeps: HeadlessDeps | null = slackHeadlessDeps(),
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
      // Like Workbot: the session carries the current instructions and capabilities before each message, so threads
      // started earlier get them too. Unchanged settings are not rewritten, which keeps the provider's cache warm.
      const saved = await client.putSession(input.sessionId, { ...input.settings, repeats: SLACK_REPEAT_LIMITS })
      // A session id the runner can't hold (a thread started before the runner cutover) is as good as gone.
      if (!saved.ok && (saved.status === 404 || saved.error === "invalid_session_id")) return unknownSession
      if (!saved.ok) return retryable(`headless_put_${saved.status}`)
    }
    // One fresh, member-scoped MCP token per admitted run; the runner holds it in memory only.
    const sent = await client.sendTurn(actor, {
      sessionId: input.sessionId,
      messageId: input.messageId,
      prompt: input.prompt,
      ...(input.model ? { model: input.model } : {}),
    })
    if (sent.ok) return { ok: true, accepted: sent.value.state === "accepted" }
    if (sent.status === 404) return unknownSession
    return retryable(`headless_send_${sent.status}`)
  }

  const resume = async (sessionId: string, messageId: string) => send({ sessionId, messageId, prompt: "resume" })

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
      // A runner restart or an expired token pauses a task or report; re-sending its id resumes it with a fresh token.
      for (const turn of [...tasks, ...reports]) {
        if (turn.status !== "interrupted") continue
        const resumed = await resume(input.sessionId, turn.id)
        if (resumed.ok) turn.status = "queued"
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

    // Maps the runner transcript onto what the run loop shows. This polls every second for the whole run, so tool
    // outputs (up to 50k characters each) stay on the runner; only their outcome is needed.
    async read(input) {
      const read = await client.readSession(input.sessionId, { messageId: input.messageId, limit: 500, outputs: "none" })
      if (!read.ok && read.status === 404) return unknownSession
      if (!read.ok) return retryable(`headless_read_${read.status}`)
      const snapshot = read.value
      const turn = snapshot.turns.find((entry) => entry.messageId === input.messageId)

      // A runner restart or a credential refresh interrupts a turn; re-sending the same messageId resumes it.
      if (turn?.status === "interrupted") {
        const resumed = await resume(input.sessionId, input.messageId)
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
      // A turn that only reacted says nothing more; one that only handed work to the background says so.
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
          ...(reaction ? { reaction } : {}),
          tasks,
        },
      }
    },
  }
}
