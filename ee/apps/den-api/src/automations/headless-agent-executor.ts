import { createHash } from "node:crypto"
import { and, eq, isNull } from "@openwork-ee/den-db/drizzle"
import { MemberTable } from "@openwork-ee/den-db/schema"
import { normalizeDenTypeId } from "@openwork-ee/utils/typeid"
import { isAutomationCloudDefaultModel, type AutomationUsage } from "@openwork/types/automations"
import { db } from "../db.js"
import {
  ACTIVE_TURN_STATUSES,
  createHeadlessRunnerClient,
  defaultHeadlessRunnerDeps,
  type HeadlessRunnerClient,
  type RunnerMessage,
  type RunnerRepeatLimits,
  type RunnerTurn,
} from "../headless-runner/client.js"
import { DEN_MCP_HEADLESS_RUN_TOKEN_MAX_TTL_MS } from "../mcp/headless-run-token.js"
import type { CloudAgentEvent, CloudAgentExecution, CloudAgentExecutorInput } from "./cloud-agent-executor.js"
import { cloudAutomationRuntime } from "./headless-runtime.js"
import { organizationDefaultModel } from "../workbot/model.js"

/**
 * Runs one cloud agent Automation on the shared headless runner.
 *
 * Cheap: no OpenWork Web computer is woken, provisioned or kept awake; a run
 * is one agent turn in its own runner session. Reliable: the receipt
 * (session + message id) is saved before the turn is sent, so a Den restart
 * resumes the same turn instead of starting a second one, and a runner restart
 * resumes it by re-sending the same message id. Safe: every send carries a
 * fresh MCP token scoped to the owner and to this run's lifetime.
 */

const POLL_INTERVAL_MS = 2_000
const ABORT_SETTLE_TIMEOUT_MS = 15_000
const MAX_CONSECUTIVE_READ_FAILURES = 30
const RESULT_SUMMARY_LIMIT = 20_000
/** The token outlives the run's own deadline a little, so the last steps never lose MCP mid-call. */
const TOKEN_GRACE_MS = 5 * 60_000

/**
 * Nobody is waiting on an Automation, but its run has a deadline: waiting on an unchanged answer gets a third of
 * it (5 of the default 15 minutes), so the agent still has time to report before the run is cut off.
 */
export function automationRepeatLimits(maximumRuntimeMs: number): RunnerRepeatLimits {
  return { maxWaitingMs: Math.min(Math.max(Math.floor(maximumRuntimeMs / 3), 10_000), 24 * 3_600_000), maxIdenticalFailures: 3 }
}

export const HEADLESS_AUTOMATION_INSTRUCTIONS = [
  "This conversation is one run of a scheduled Automation. Nobody is watching while it runs.",
  "Do the work the message describes, then reply with the result. Your reply is saved as the run's result, so lead with what matters and keep it short.",
  "If something you need is missing (a connection, access, or information), say exactly what is missing instead of guessing.",
].join("\n")

type OwnerScope = { organizationId: string; ownerMemberId: string }

export type HeadlessAgentExecutorDeps = {
  client: HeadlessRunnerClient | null
  ownerUserId: (scope: OwnerScope) => Promise<string | null>
  /** Live check that the organization still runs Automations headless. */
  stillHeadless: (organizationId: string) => Promise<boolean>
  /** The organization's default model for runs on the cloud default (workbotDefaultModel); null: the runner's. */
  defaultModel: (organizationId: string) => Promise<string | null>
  sleep: (ms: number, signal: AbortSignal) => Promise<void>
  pollIntervalMs: number
}

type HeadlessReceipt = { runtime: "headless"; sessionId: string; messageId: string }

export function parseHeadlessReceipt(value: unknown): HeadlessReceipt | null {
  if (typeof value !== "object" || value === null) return null
  if (!("runtime" in value) || value.runtime !== "headless") return null
  if (!("sessionId" in value) || typeof value.sessionId !== "string" || !value.sessionId) return null
  if (!("messageId" in value) || typeof value.messageId !== "string" || !value.messageId) return null
  return { runtime: "headless", sessionId: value.sessionId, messageId: value.messageId }
}

/** Stable per run, so every Den replica and every resume names the same turn. */
export function headlessMessageIdForRun(runId: string) {
  return `auto_${createHash("sha256").update(`automation:${runId}`).digest("hex").slice(0, 32)}`
}

function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(signal.reason)
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", aborted)
      resolve()
    }, ms)
    const aborted = () => {
      clearTimeout(timer)
      reject(signal.reason)
    }
    signal.addEventListener("abort", aborted, { once: true })
  })
}

async function ownerUserId(scope: OwnerScope) {
  const members = await db.select({ userId: MemberTable.userId }).from(MemberTable).where(and(
    eq(MemberTable.id, normalizeDenTypeId("member", scope.ownerMemberId)),
    eq(MemberTable.organizationId, normalizeDenTypeId("organization", scope.organizationId)),
    isNull(MemberTable.removedAt),
  )).limit(1)
  return members[0]?.userId ?? null
}

function defaultDeps(): HeadlessAgentExecutorDeps {
  const runner = defaultHeadlessRunnerDeps()
  return {
    client: runner ? createHeadlessRunnerClient(runner) : null,
    ownerUserId,
    stillHeadless: async (organizationId) => (await cloudAutomationRuntime(organizationId)) === "headless",
    defaultModel: (organizationId) => organizationDefaultModel(organizationId),
    sleep: abortableSleep,
    pollIntervalMs: POLL_INTERVAL_MS,
  }
}

function usageFromTurn(turn: RunnerTurn | undefined): AutomationUsage {
  return {
    inputTokens: turn?.usage?.inputTokens ?? null,
    outputTokens: turn?.usage?.outputTokens ?? null,
    // The Gateway meters and bills the tokens; the runner does not price them.
    costMicros: null,
  }
}

function transcriptEvents(messages: RunnerMessage[], usage: AutomationUsage): CloudAgentEvent[] {
  const events: CloudAgentEvent[] = []
  for (const message of messages.slice(-100)) {
    const messageId = message.messageId ?? null
    if (message.role === "user") events.push({ type: "user", payload: { messageId, text: message.text.slice(0, 20_000) } })
    if (message.role === "assistant") {
      events.push({ type: "assistant", payload: { messageId, text: message.text.slice(0, 20_000) } })
      for (const call of message.toolCalls) {
        events.push({ type: "capability_execution", payload: { messageId, partId: call.id, callId: call.id, name: call.name, status: null } })
      }
    }
    if (message.role === "tool") {
      const index = events.findIndex((event) => event.type === "capability_execution" && event.payload.callId === message.callId)
      if (index >= 0) events[index] = { ...events[index], payload: { ...events[index].payload, status: message.isError ? "error" : "completed" } }
    }
  }
  events.push({ type: "usage", payload: usage })
  return events
}

function failure(input: {
  code: Extract<CloudAgentExecution, { ok: false }>["code"]
  message: string
  retryable?: boolean
  needsAttention?: boolean
  status?: "failed" | "cancelled"
  events?: CloudAgentEvent[]
  usage?: AutomationUsage
}): CloudAgentExecution {
  return {
    ok: false,
    status: input.status ?? "failed",
    code: input.code,
    message: input.message,
    retryable: input.retryable ?? false,
    ...(input.needsAttention ? { needsAttention: true } : {}),
    ...(input.events ? { events: input.events } : {}),
    ...(input.usage ? { usage: input.usage } : {}),
  }
}

/**
 * Runner failures mapped to the Automation contract. A transient failure is
 * retried: the retry re-sends the same message id, which resumes the turn
 * where it stopped, and the runner never re-runs a tool call it already made.
 */
function turnFailure(turn: RunnerTurn, messages: RunnerMessage[]): CloudAgentExecution {
  const usage = usageFromTurn(turn)
  const events = [...transcriptEvents(messages, usage), { type: "terminal" as const, payload: { status: "failed", code: turn.error } }]
  const code = turn.error ?? "headless_run_failed"
  if (code === "turn_timeout") {
    return failure({ code: "execution_timed_out", message: "The Automation run exceeded its maximum runtime.", events, usage })
  }
  if (code === "mcp_unavailable") {
    return failure({ code: "connect_access_unavailable", message: "OpenWork could not reach the owner's connections for this run.", retryable: true, events, usage })
  }
  if (code === "model_unreachable" || code === "model_http_429" || code === "model_http_529" || /^model_http_5\d\d$/.test(code)) {
    return failure({ code: "execution_failed", message: "The cloud model was briefly unavailable.", retryable: true, events, usage })
  }
  if (code === "model_credentials_missing" || code === "model_http_401" || code === "model_http_403") {
    return failure({ code: "provider_unavailable", message: "The cloud model is not available. An admin needs to check the headless runner's model access.", needsAttention: true, events, usage })
  }
  return failure({ code: "execution_failed", message: `The Automation run failed (${code}).`, events, usage })
}

/**
 * The member's own selection when the runner can serve it, otherwise the
 * runner's default model. An Automation on the cloud default runs on the
 * organization's default model when admins chose one, else the runner's
 * default. Either way the run records which model it used.
 */
export async function chooseModel(
  client: Pick<HeadlessRunnerClient, "listModels">,
  model: { providerId: string; modelId: string },
  organizationModel: string | null = null,
) {
  if (isAutomationCloudDefaultModel(model)) return { model: organizationModel ?? undefined, warning: null }
  const modelId = model.modelId
  const catalog = await client.listModels()
  if (!catalog) return { model: undefined, warning: null }
  if (catalog.models.some((model) => model.id === modelId)) return { model: modelId, warning: null }
  return {
    model: undefined,
    warning: { type: "warning" as const, payload: { code: "headless_default_model", requestedModel: modelId, model: catalog.defaultModel } },
  }
}

export async function executeHeadlessAgent(
  input: CloudAgentExecutorInput,
  suppliedDeps?: Partial<HeadlessAgentExecutorDeps>,
): Promise<CloudAgentExecution> {
  const deps: HeadlessAgentExecutorDeps = { ...defaultDeps(), ...suppliedDeps }
  const client = deps.client
  if (!client) {
    return failure({ code: "execution_runtime_unavailable", message: "The headless runner is not configured for this deployment.", needsAttention: true })
  }

  const deadline = new AbortController()
  const deadlineTimer = setTimeout(() => deadline.abort(new Error("automation_deadline_exceeded")), input.maximumRuntimeMs)
  const signal = AbortSignal.any([input.signal, deadline.signal])
  const previous = parseHeadlessReceipt(input.previousReceipt)
  let sessionId: string | null = previous?.sessionId ?? null
  const messageId = previous?.messageId ?? headlessMessageIdForRun(input.automationRunId)
  try {
    const userId = await deps.ownerUserId(input)
    if (!userId) {
      return failure({ code: "owner_membership_lost", message: "The Automation owner is no longer an active organization member.", needsAttention: true })
    }
    const actor = { userId, organizationId: input.organizationId }

    if (input.previousReceipt && !previous) {
      // A receipt from the OpenWork Web computer cannot be continued here, and
      // starting over could repeat side effects the earlier attempt had.
      return failure({ code: "execution_runtime_unavailable", message: "This run started on another runtime and cannot be resumed safely.", needsAttention: true })
    }
    if (!previous && !await deps.stillHeadless(input.organizationId)) {
      return failure({ code: "execution_runtime_unavailable", message: "Headless Automations were switched off for this organization.", retryable: true })
    }

    if (!sessionId) {
      const created = await client.createSession({
        title: `Automation: ${input.automationName}`,
        instructions: HEADLESS_AUTOMATION_INSTRUCTIONS,
        repeats: automationRepeatLimits(input.maximumRuntimeMs),
      })
      // Nothing has run yet, so a runner outage here is safe to retry.
      if (!created.ok) return failure({ code: "execution_runtime_unavailable", message: "The headless runner is unavailable.", retryable: true })
      sessionId = created.value.id
      // Saved before any work is sent: recovery observes or resumes this exact turn.
      await input.onAdmitted({ runtime: "headless", sessionId, messageId })
    }

    // Read only for runs on the cloud default; a failed read keeps the runner's default for this run.
    const organizationModel = isAutomationCloudDefaultModel(input.action.model)
      ? await deps.defaultModel(input.organizationId).catch(() => null)
      : null
    const { model, warning } = await chooseModel(client, input.action.model, organizationModel)
    const ttlMs = Math.min(input.maximumRuntimeMs + TOKEN_GRACE_MS, DEN_MCP_HEADLESS_RUN_TOKEN_MAX_TTL_MS)
    const runSessionId = sessionId
    const sendTurn = () => client.sendTurn(actor, { sessionId: runSessionId, messageId, prompt: input.action.instructions, model, ttlMs })

    const sent = await sendTurn()
    if (!sent.ok) {
      if (sent.status === 404) {
        return failure({ code: "execution_runtime_unavailable", message: "The headless runner lost this run's session.", needsAttention: Boolean(previous) })
      }
      // A first send that was refused never started; a resumed one may have run, so only the first is retried.
      return failure({ code: "execution_runtime_unavailable", message: "The headless runner is unavailable.", retryable: !previous })
    }

    let readFailures = 0
    for (;;) {
      await deps.sleep(deps.pollIntervalMs, signal)
      const read = await client.readSession(runSessionId, { messageId, limit: 500 }).catch(() => null)
      if (!read || !read.ok) {
        if (read && read.status === 404) {
          return failure({ code: "execution_failed", message: "The headless runner lost this run's session before it finished.", needsAttention: true })
        }
        readFailures += 1
        if (readFailures >= MAX_CONSECUTIVE_READ_FAILURES) {
          return failure({ code: "execution_failed", message: "Lost contact with the headless runner while the run was in progress.", needsAttention: true })
        }
        continue
      }
      readFailures = 0
      const turn = read.value.turns.find((entry) => entry.messageId === messageId)
      if (!turn || ACTIVE_TURN_STATUSES.has(turn.status)) continue
      if (turn.status === "interrupted") {
        // The runner restarted mid-turn. The same message id resumes it; tool
        // calls whose outcome is unknown are never re-run by the runner.
        const resumed = await sendTurn()
        if (!resumed.ok && resumed.status === 404) {
          return failure({ code: "execution_failed", message: "The headless runner lost this run's session before it finished.", needsAttention: true })
        }
        continue
      }
      if (turn.status === "aborted") {
        return failure({ code: "cancelled", status: "cancelled", message: "The Automation run was cancelled.", events: [{ type: "terminal", payload: { status: "cancelled" } }] })
      }
      if (turn.status === "failed") return turnFailure(turn, read.value.messages)

      const usage = usageFromTurn(turn)
      // The answer is the last reply without tool calls; narration between steps is not the result.
      const answer = read.value.messages.filter((message) => message.role === "assistant" && message.toolCalls.length === 0).at(-1)
      const resultSummary = (answer?.role === "assistant" ? answer.text : read.value.finalAssistantText).trim()
        || "The Automation run finished without a written result."
      return {
        ok: true,
        threadId: runSessionId,
        workspaceId: "headless",
        resultSummary: resultSummary.slice(0, RESULT_SUMMARY_LIMIT),
        usage,
        events: [
          ...(warning ? [warning] : []),
          ...transcriptEvents(read.value.messages, usage),
          { type: "terminal", payload: { status: "succeeded", model: turn.model ?? null } },
        ],
      }
    }
  } catch (error) {
    const cancelled = input.signal.aborted
    const timedOut = deadline.signal.aborted
    // Once a turn may have been sent, never end the run while it could still be working.
    if (sessionId && !await stopTurn(client, sessionId, messageId)) {
      return failure({
        code: "execution_failed",
        message: "OpenWork could not confirm that the stopped run ended. Check its result before running it again.",
        needsAttention: true,
        events: [{ type: "warning", payload: { code: "abort_not_observed", sessionId } }],
      })
    }
    if (!cancelled && !timedOut) {
      return failure({ code: "execution_failed", message: error instanceof Error ? error.message : "Headless Automation execution failed." })
    }
    return failure({
      code: cancelled ? "cancelled" : "execution_timed_out",
      status: cancelled ? "cancelled" : "failed",
      message: cancelled ? "The Automation run was cancelled." : "The Automation run exceeded its maximum runtime.",
      events: [{ type: "terminal", payload: { status: cancelled ? "cancelled" : "failed" } }],
    })
  } finally {
    clearTimeout(deadlineTimer)
  }
}

/**
 * Stops the run's turn and waits until the runner reports it idle. Returns
 * true when nothing can still be running.
 */
async function stopTurn(client: HeadlessRunnerClient, sessionId: string, messageId: string) {
  const settle = AbortSignal.timeout(ABORT_SETTLE_TIMEOUT_MS)
  await client.abort(sessionId, messageId).catch(() => null)
  while (!settle.aborted) {
    const read = await client.readSession(sessionId, { messageId, limit: 1 }).catch(() => null)
    const turn = read?.ok ? read.value.turns.find((entry) => entry.messageId === messageId) : undefined
    if (read?.ok && (!turn || !ACTIVE_TURN_STATUSES.has(turn.status))) return true
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  return false
}
