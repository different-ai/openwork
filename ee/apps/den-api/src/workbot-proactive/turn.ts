import { createHash } from "node:crypto"
import { parseAgentReply, type AgentReply } from "@openwork/automations/proactive"
import {
  ACTIVE_TURN_STATUSES,
  createHeadlessRunnerClient,
  defaultHeadlessRunnerDeps,
  type HeadlessRunnerActor,
  type HeadlessRunnerClient,
} from "../headless-runner/client.js"

/**
 * One pass of a member's agent on the standard headless runner.
 *
 * - Its own durable session, one per agent (`hs_agent_…`, derived, so Den keeps no mapping). Never the member's
 *   Workbot chat and never `memoryOf` it: what the agent reads stays in its own transcript and `memory/` notes.
 *   Only the text Den actually delivers leaves it.
 * - Standard runner tools only (its scratch files, so `memory/` notes persist across passes) plus Connect tools
 *   with a read-scoped MCP token (`mcp:read`) that carries its sources as an allowlist (agent-read-sources.ts): it
 *   reads the member's calendar, email, team chat and other sources that are on, and can't send, edit or accept
 *   anything. Not `credentials.readOnly`, which would also take away its file tools.
 * - Silence by default: the answer is parsed with the shared `NO_REPLY` rule; anything unexpected is silence too.
 */

export type AgentTurnResult = AgentReply | { kind: "unavailable"; code: string }

/** Tokens one turn used, as the runner reports them; null from runners that don't. */
export type AgentTurnUsage = { inputTokens: number; cachedInputTokens: number; outputTokens: number } | null

/** A turn's final answer as written, for callers that read it themselves (`workbotAgentBrief`). */
export type AgentRawTurnResult = { kind: "answered"; text: string; usage: AgentTurnUsage } | { kind: "unavailable"; code: string }

export type AgentTurnDeps = {
  client: HeadlessRunnerClient | null
  sleep: (ms: number) => Promise<void>
  now: () => number
  pollMs: number
  deadlineMs: number
}

const TOKEN_TTL_MS = 15 * 60_000
const MAX_READ_FAILURES = 5

export function defaultAgentTurnDeps(): AgentTurnDeps {
  const runner = defaultHeadlessRunnerDeps()
  return {
    client: runner ? createHeadlessRunnerClient(runner) : null,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now: Date.now,
    pollMs: 2_000,
    deadlineMs: 5 * 60_000,
  }
}

/** The agent's own session: one per member, never shared with Workbot. */
export function agentSessionId(organizationId: string, memberId: string) {
  return `hs_agent_${createHash("sha256").update(`agent:${organizationId}:${memberId}`).digest("hex").slice(0, 40)}`
}

/** Stable per wake, so a resend never starts a second turn. */
export function agentMessageId(memberId: string, wakeAt: number) {
  return `wa_${createHash("sha256").update(`agent:${memberId}:${wakeAt}`).digest("hex").slice(0, 32)}`
}

/** The messenger's session for one check (`workbotAgentBrief`): fresh each time, deleted after, never shared. */
export function agentMessageSessionId(organizationId: string, memberId: string, wakeAt: number) {
  return `hs_agentmsg_${createHash("sha256").update(`agent-message:${organizationId}:${memberId}:${wakeAt}`).digest("hex").slice(0, 36)}`
}

export async function runAgentTurn(
  input: { actor: HeadlessRunnerActor; sessionId: string; instructions: string; model: string; prompt: string; messageId: string; scopes?: readonly string[] },
  deps: AgentTurnDeps,
): Promise<AgentTurnResult> {
  const answered = await runAgentSessionTurn(input, deps)
  return answered.kind === "answered" ? parseAgentReply(answered.text) : answered
}

/**
 * One turn of a member's agent, answered as written. `readOnly` (the messenger) also takes away its file tools; with
 * an empty read allowlist in `scopes` its token reads nothing, so it can only write the answer it is asked for.
 */
export async function runAgentSessionTurn(
  input: { actor: HeadlessRunnerActor; sessionId: string; instructions: string; model: string; prompt: string; messageId: string; scopes?: readonly string[]; title?: string; readOnly?: boolean },
  deps: AgentTurnDeps,
): Promise<AgentRawTurnResult> {
  const client = deps.client
  if (!client) return { kind: "unavailable", code: "runner_not_configured" }
  // Same id every pass: creates the session the first time, keeps its transcript and notes after that, and picks
  // up a new template version's instructions.
  const session = await client
    .putSession(input.sessionId, { title: input.title ?? "Your agent", instructions: input.instructions, repeats: { maxWaitingMs: 60_000, maxIdenticalFailures: 2 } })
    .catch(() => null)
  if (!session?.ok) return { kind: "unavailable", code: session?.error ?? "runner_unreachable" }
  const send = () => client
    .sendTurn(input.actor, {
      sessionId: input.sessionId,
      messageId: input.messageId,
      prompt: input.prompt,
      model: input.model,
      ...(input.readOnly ? { readOnly: true } : { mcpReadOnly: true }),
      ...(input.scopes?.length ? { mcpScopes: input.scopes } : {}),
      ttlMs: TOKEN_TTL_MS,
      execution: "steps",
    })
    .catch(() => null)
  const sent = await send()
  if (!sent?.ok) return { kind: "unavailable", code: sent?.error ?? "runner_unreachable" }
  const deadline = deps.now() + deps.deadlineMs
  let failures = 0
  while (deps.now() < deadline) {
    await deps.sleep(deps.pollMs)
    const read = await client.readSession(input.sessionId, { messageId: input.messageId, limit: 200, outputs: "none" }).catch(() => null)
    if (!read?.ok) {
      failures += 1
      if (failures >= MAX_READ_FAILURES) return { kind: "unavailable", code: "runner_read_failed" }
      continue
    }
    failures = 0
    const turn = read.value.turns.find((entry) => entry.messageId === input.messageId)
    if (!turn || ACTIVE_TURN_STATUSES.has(turn.status)) continue
    if (turn.status === "interrupted") {
      // The runner restarted mid-turn: the same message id resumes it, with a fresh read-scoped token.
      const resumed = await send()
      if (!resumed?.ok) return { kind: "unavailable", code: resumed?.error ?? "runner_unreachable" }
      continue
    }
    if (turn.status !== "completed") return { kind: "unavailable", code: turn.error ?? `turn_${turn.status}` }
    const answer = read.value.messages.filter((message) => message.role === "assistant" && message.toolCalls.length === 0).at(-1)
    return { kind: "answered", text: answer?.role === "assistant" ? answer.text : read.value.finalAssistantText, usage: turn.usage ?? null }
  }
  await client.abort(input.sessionId, input.messageId).catch(() => null)
  return { kind: "unavailable", code: "timed_out" }
}

/** Deletes the messenger's session once its answer is read; best effort (an orphan holds one short exchange). */
export async function endAgentMessageSession(sessionId: string, deps: Pick<AgentTurnDeps, "client">): Promise<void> {
  await deps.client?.deleteSession(sessionId).catch(() => null)
}
