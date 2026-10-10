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

export type SlackRunSnapshot = {
  /** idle: the turn ended (completed, failed or stopped). */
  status: "busy" | "idle"
  /** Everything the turn wrote, its notes and answer joined. */
  finalAssistantText: string
  /** The turn's last message alone: the answer a long, quiet run posts. */
  lastAssistantText: string
  terminalError?: { code: string }
  steps: SlackRunStep[]
}

export type SlackRunner = {
  create(input: { title: string }): Promise<RunnerOutcome<{ sessionId: string }>>
  send(input: { sessionId: string; messageId: string; prompt: string; model?: string }): Promise<RunnerOutcome<object>>
  read(input: { sessionId: string; messageId: string }): Promise<RunnerOutcome<{ snapshot: SlackRunSnapshot }>>
  stop(input: { sessionId: string; messageId: string }): Promise<void>
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
    }
  }
  const client = createHeadlessRunnerClient(suppliedDeps)

  const send = async (input: { sessionId: string; messageId: string; prompt: string; model?: string }): Promise<RunnerOutcome<object>> => {
    // One fresh, member-scoped MCP token per admitted run; the runner holds it in memory only.
    const sent = await client.sendTurn(actor, {
      sessionId: input.sessionId,
      messageId: input.messageId,
      prompt: input.prompt,
      ...(input.model ? { model: input.model } : {}),
    })
    if (sent.ok) return { ok: true }
    if (sent.status === 404) return unknownSession
    return retryable(`headless_send_${sent.status}`)
  }

  return {
    async create(input) {
      const created = await client.createSession({ title: input.title, repeats: SLACK_REPEAT_LIMITS })
      if (!created.ok) return retryable(`headless_create_${created.status}`)
      return { ok: true, sessionId: created.value.id }
    },

    send,

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
        const resumed = await send({ sessionId: input.sessionId, messageId: input.messageId, prompt: "resume" })
        if (!resumed.ok) return resumed
      }

      const messages = snapshot.messages
      const results = new Map(
        messages.flatMap((message) => (message.role === "tool" ? [[message.callId, message.isError] as const] : [])),
      )
      const terminal = turn !== undefined && TERMINAL_TURN_STATUSES.has(turn.status)
      const failed = turn?.status === "failed"
      let finalAssistantText = snapshot.finalAssistantText
      if (terminal && !failed && !finalAssistantText) finalAssistantText = "Done."
      const lastAssistantText =
        messages.flatMap((message) => (message.role === "assistant" && message.text.trim() ? [message.text] : [])).at(-1) ?? ""
      return {
        ok: true,
        snapshot: {
          status: terminal ? "idle" : "busy",
          finalAssistantText,
          lastAssistantText: lastAssistantText || finalAssistantText,
          ...(failed ? { terminalError: { code: turn.error ?? "headless_run_failed" } } : {}),
          steps: messages.flatMap((message) =>
            message.role === "assistant"
              ? message.toolCalls.map((tool): SlackRunStep => {
                  const outcome = results.get(tool.id)
                  return {
                    id: tool.id,
                    label: stepLabel(tool.name, tool.input),
                    status: outcome === undefined ? "running" : outcome ? "error" : "completed",
                  }
                })
              : [],
          ),
        },
      }
    },
  }
}
