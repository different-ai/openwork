import type { RemoteSessionAction } from "../mcp/remote-session-capabilities.js"
import type { FeatureMap } from "../features.js"
import { stepLabel } from "../headless-runner/client.js"
import {
  createHeadlessRunnerClient,
  defaultHeadlessRunnerDeps,
  headlessRunnerConfig,
  TERMINAL_TURN_STATUSES,
  type HeadlessRunnerActor,
  type HeadlessRunnerDeps,
  type RunnerRepeatLimits,
} from "../headless-runner/client.js"

/**
 * Slack runs for organizations with `slackAssistantHeadless` go to the shared
 * headless runner (ee/apps/headless-runner) instead of each member's OpenWork
 * Web computer. This adapter speaks the same create/send/read/stop contract
 * the Slack run loop already uses, so run.ts stays runtime-agnostic.
 *
 * Runs have no time limit. Each MCP token still lives at most 60 minutes: the
 * runner pauses a long turn between steps every 50 minutes, and the read below
 * resumes it at once with a freshly minted token.
 */

export { headlessRunnerConfig }
export type HeadlessDeps = HeadlessRunnerDeps

export type SlackRuntime = "headless" | "web"

/** An organization uses the headless runner only when it is switched on for it and the deployment has one. */
export function slackRuntimeForOrganization(
  features: Pick<FeatureMap, "slackAssistantHeadless">,
  env: Record<string, string | undefined> = process.env,
): SlackRuntime {
  return features.slackAssistantHeadless && headlessRunnerConfig(env) !== null ? "headless" : "web"
}

export { stepLabel }

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

/** Runner unavailable or overloaded: the Slack run loop retries these. */
const retryable = (error: string) => ({ error, retryable: true, retryAfterMs: 5_000 })

/** The models the runner's Gateway route can serve, for the admin's model picker. Null when unavailable. */
export async function listHeadlessModels(suppliedDeps: HeadlessDeps | null = defaultHeadlessRunnerDeps()) {
  if (!suppliedDeps) return null
  return createHeadlessRunnerClient(suppliedDeps).listModels()
}

async function send(
  client: ReturnType<typeof createHeadlessRunnerClient>,
  actor: HeadlessRunnerActor,
  sessionId: string,
  messageId: string,
  prompt: string,
  model?: string,
) {
  // One fresh, member-scoped MCP token per admitted run; the runner holds it in memory only.
  const sent = await client.sendTurn(actor, { sessionId, messageId, prompt, ...(model ? { model } : {}) })
  if (sent.ok) return {}
  if (sent.status === 404) return { error: "unknown_session", retryable: false }
  return retryable(`headless_send_${sent.status}`)
}

export async function headlessRemoteCall(
  actor: HeadlessRunnerActor,
  action: RemoteSessionAction,
  body: Record<string, unknown>,
  suppliedDeps: HeadlessDeps | null = slackHeadlessDeps(),
): Promise<Record<string, unknown>> {
  if (!suppliedDeps) return { error: "headless_runner_not_configured", retryable: false }
  const client = createHeadlessRunnerClient(suppliedDeps)
  const sessionId = typeof body.sessionId === "string" ? body.sessionId : ""
  const messageId = typeof body.messageId === "string" ? body.messageId : ""

  if (action === "create") {
    const created = await client.createSession({
      title: typeof body.title === "string" ? body.title : undefined,
      repeats: SLACK_REPEAT_LIMITS,
    })
    if (!created.ok) return retryable(`headless_create_${created.status}`)
    return { sessionId: created.value.id, workspaceId: "headless" }
  }

  if (action === "send") {
    return send(
      client,
      actor,
      sessionId,
      messageId,
      typeof body.prompt === "string" ? body.prompt : "",
      typeof body.model === "string" ? body.model : undefined,
    )
  }

  if (action === "stop") {
    const stopped = await client.abort(sessionId, messageId || undefined)
    return stopped.reached ? { accepted: true } : { stopped: false }
  }

  // read: map the runner transcript onto the snapshot shape run.ts consumes. This polls every second for the
  // whole run, so tool outputs (up to 50k characters each) stay on the runner; only their outcome is needed.
  const read = await client.readSession(sessionId, { messageId, limit: 500, outputs: "none" })
  if (!read.ok && read.status === 404) return { error: "unknown_session", retryable: false }
  if (!read.ok) return retryable(`headless_read_${read.status}`)
  const snapshot = read.value
  const turn = snapshot.turns.find((entry) => entry.messageId === messageId)

  // A runner restart or a credential refresh interrupts a turn; re-sending the same messageId resumes it.
  if (turn?.status === "interrupted") {
    const resumed = await send(client, actor, sessionId, messageId, "resume")
    if ("error" in resumed) return resumed
  }

  const messages = snapshot.messages
  const results = new Map(
    messages.flatMap((message) => (message.role === "tool" ? [[message.callId, message.isError] as const] : [])),
  )
  const terminal = turn !== undefined && TERMINAL_TURN_STATUSES.has(turn.status)
  const failed = turn?.status === "failed"
  let finalAssistantText = snapshot.finalAssistantText
  if (terminal && !failed && !finalAssistantText) finalAssistantText = "Done."
  // The turn's last message, without the progress notes before it: the answer a long, quiet run posts.
  const lastAssistantText =
    messages.flatMap((message) => (message.role === "assistant" && message.text.trim() ? [message.text] : [])).at(-1) ?? ""
  return {
    status: terminal ? "idle" : "busy",
    title: null,
    messageCount: messages.length,
    finalAssistantText,
    lastAssistantText: lastAssistantText || finalAssistantText,
    ...(failed ? { terminalError: { code: turn.error ?? "headless_run_failed" } } : {}),
    messages: messages.map((message) => ({
      role: message.role,
      toolCalls:
        message.role === "assistant"
          ? message.toolCalls.map((tool) => {
              const outcome = results.get(tool.id)
              return {
                id: tool.id,
                name: stepLabel(tool.name, tool.input),
                status: outcome === undefined ? "running" : outcome ? "error" : "completed",
              }
            })
          : [],
    })),
  }
}
