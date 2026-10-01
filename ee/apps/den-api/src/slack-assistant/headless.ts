import type { RemoteSessionAction } from "../mcp/remote-session-capabilities.js"
import { DEN_MCP_HEADLESS_RUN_TOKEN_MAX_TTL_MS } from "../mcp/headless-run-token.js"
import { organizationHasCapability } from "../organization-capabilities.js"
import { stepLabel } from "../headless-runner/step-label.js"
import {
  createHeadlessRunnerClient,
  defaultHeadlessRunnerDeps,
  headlessRunnerConfig,
  TERMINAL_TURN_STATUSES,
  type HeadlessRunnerActor,
  type HeadlessRunnerDeps,
} from "../headless-runner/client.js"

/**
 * Slack runs for organizations with `slackAssistantHeadless` go to the shared
 * headless runner (ee/apps/headless-runner) instead of each member's OpenWork
 * Web computer. This adapter speaks the same create/send/read/stop contract
 * the Slack run loop already uses, so run.ts stays runtime-agnostic.
 */
export const HEADLESS_RUN_MAX_MS = DEN_MCP_HEADLESS_RUN_TOKEN_MAX_TTL_MS

export { headlessRunnerConfig }
export type HeadlessDeps = HeadlessRunnerDeps

export type SlackRuntime = "headless" | "web"

/** An organization uses the headless runner only when it is switched on for it and the deployment has one. */
export function slackRuntimeForOrganization(
  metadata: Parameters<typeof organizationHasCapability>[0],
  env: Record<string, string | undefined> = process.env,
): SlackRuntime {
  const enabled = organizationHasCapability(metadata, "slackAssistantHeadless")
  return enabled && headlessRunnerConfig(env) !== null ? "headless" : "web"
}

export { stepLabel }

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
  suppliedDeps: HeadlessDeps | null = defaultHeadlessRunnerDeps(),
): Promise<Record<string, unknown>> {
  if (!suppliedDeps) return { error: "headless_runner_not_configured", retryable: false }
  const client = createHeadlessRunnerClient(suppliedDeps)
  const sessionId = typeof body.sessionId === "string" ? body.sessionId : ""
  const messageId = typeof body.messageId === "string" ? body.messageId : ""

  if (action === "create") {
    const created = await client.createSession({ title: typeof body.title === "string" ? body.title : undefined })
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

  // read: map the runner transcript onto the snapshot shape run.ts consumes.
  const read = await client.readSession(sessionId, { messageId, limit: 500 })
  if (!read.ok && read.status === 404) return { error: "unknown_session", retryable: false }
  if (!read.ok) return retryable(`headless_read_${read.status}`)
  const snapshot = read.value
  const turn = snapshot.turns.find((entry) => entry.messageId === messageId)

  // A runner restart interrupts in-flight turns; re-sending the same messageId resumes them.
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
  return {
    status: terminal ? "idle" : "busy",
    title: null,
    messageCount: messages.length,
    finalAssistantText,
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
