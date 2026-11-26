import { createHash } from "node:crypto"
import { connectionBlockerFromToolCalls } from "@openwork/headless-threads"
import { and, eq, inArray, isNull } from "@openwork-ee/den-db/drizzle"
import { ExternalMcpConnectionTable, MemberTable } from "@openwork-ee/den-db/schema"
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
import { isModelAccessRefusal } from "../headless-runner/model-access-refusal.js"
import { parseExternalCapabilityName } from "../mcp/external-capabilities.js"
import { DEN_MCP_HEADLESS_RUN_TOKEN_MAX_TTL_MS } from "../mcp/headless-run-token.js"
import { parseNativeCapabilityName } from "../mcp/native-capabilities.js"
import { connectionBlockedExecution, type CloudAgentEvent, type CloudAgentExecution, type CloudAgentExecutorInput } from "./cloud-agent-executor.js"
import { cloudAutomationRuntime } from "./headless-runtime.js"
import { organizationCloudModel } from "../workbot/model.js"
import { headlessRunCostMicros, headlessRunPricing } from "./headless-run-pricing.js"
import { cloudAgentGatewayCatalog } from "../workbot/gateway-model.js"
import { collectRunStepFacts, runStepConnector, runStepOutcome, type RunStepCandidate } from "./run-step-facts.js"

const POLL_INTERVAL_MS = 2_000
const RUNNER_UNREACHABLE = { ok: false as const, status: 503, error: "headless_send_unavailable" }
const ABORT_SETTLE_TIMEOUT_MS = 15_000
const MAX_CONSECUTIVE_READ_FAILURES = 30
const RESULT_SUMMARY_LIMIT = 20_000
const TOKEN_GRACE_MS = 5 * 60_000

export function automationRepeatLimits(maximumRuntimeMs: number): RunnerRepeatLimits {
  return { maxWaitingMs: Math.min(Math.max(Math.floor(maximumRuntimeMs / 3), 10_000), 24 * 3_600_000), maxIdenticalFailures: 3 }
}

export const HEADLESS_AUTOMATION_INSTRUCTIONS = [
  "This conversation is one run of a scheduled Automation. Nobody is watching while it runs.",
  "OpenWork already decided this run should happen now, on its schedule or because someone chose Run now. Do the task now; never skip it because of a day, time or schedule written in the message, and use today's date for anything dated.",
  "Do the work the message describes, then reply with the result. Your reply is saved as the run's result, so lead with what matters and keep it short.",
  "If something you need is missing (a connection, access, or information), say exactly what is missing instead of guessing.",
].join("\n")

type OwnerScope = { organizationId: string; ownerMemberId: string }

export type HeadlessAgentExecutorDeps = {
  client: HeadlessRunnerClient | null
  ownerUserId: (scope: OwnerScope) => Promise<string | null>
  stillHeadless: (organizationId: string) => Promise<boolean>
  cloudModel: typeof organizationCloudModel
  gatewayCatalog: typeof cloudAgentGatewayCatalog
  stepTurns: (organizationId: string) => Promise<boolean>
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
  const members = await db.$primary.select({ userId: MemberTable.userId }).from(MemberTable).where(and(
    eq(MemberTable.id, normalizeDenTypeId("member", scope.ownerMemberId)),
    eq(MemberTable.organizationId, normalizeDenTypeId("organization", scope.organizationId)),
    isNull(MemberTable.removedAt),
  )).limit(1)
  return members[0]?.userId ?? null
}

function defaultDeps(): HeadlessAgentExecutorDeps {
  const runner = defaultHeadlessRunnerDeps(process.env, { indexKind: "automation" })
  return {
    client: runner ? createHeadlessRunnerClient(runner) : null,
    ownerUserId,
    stillHeadless: async (organizationId) => (await cloudAutomationRuntime(organizationId)) === "headless",
    cloudModel: organizationCloudModel,
    gatewayCatalog: cloudAgentGatewayCatalog,
    stepTurns: async () => true,
    sleep: abortableSleep,
    pollIntervalMs: POLL_INTERVAL_MS,
  }
}

function usageFromTurn(turn: RunnerTurn, rates: unknown): AutomationUsage {
  return {
    inputTokens: turn?.usage?.inputTokens ?? null,
    outputTokens: turn?.usage?.outputTokens ?? null,
    costMicros: headlessRunCostMicros(rates, turn.usage),
  }
}

async function enrichConnectorEvents(
  organizationId: string,
  events: CloudAgentEvent[],
  steps: Map<number, RunStepCandidate>,
) {
  const facts = await collectRunStepFacts(steps, async (connectionIds) => (
    db.$primary.select({ id: ExternalMcpConnectionTable.id, name: ExternalMcpConnectionTable.name })
      .from(ExternalMcpConnectionTable).where(and(
        eq(ExternalMcpConnectionTable.organizationId, normalizeDenTypeId("organization", organizationId)),
        inArray(ExternalMcpConnectionTable.id, connectionIds),
      ))
  ))
  for (const [index, stepFacts] of facts) Object.assign(events[index].payload, stepFacts)
}

async function transcriptEvents(organizationId: string, messages: RunnerMessage[], usage: AutomationUsage): Promise<CloudAgentEvent[]> {
  const events: CloudAgentEvent[] = []
  const steps = new Map<number, RunStepCandidate>()
  for (const message of messages.slice(-100)) {
    const messageId = message.messageId ?? null
    if (message.role === "user") events.push({ type: "user", payload: { messageId, text: message.text.slice(0, 20_000) } })
    if (message.role === "assistant") {
      events.push({ type: "assistant", payload: { messageId, text: message.text.slice(0, 20_000) } })
      for (const call of message.toolCalls) {
        const connector = runStepConnector(call, (name) => parseExternalCapabilityName(name) ?? parseNativeCapabilityName(name))
        if (connector) steps.set(events.length, connector)
        events.push({ type: "capability_execution", payload: { messageId, partId: call.id, callId: call.id, name: call.name, status: null } })
      }
    }
    if (message.role === "tool") {
      const index = events.findIndex((event) => event.type === "capability_execution" && event.payload.callId === message.callId)
      if (index >= 0) events[index] = { ...events[index], payload: { ...events[index].payload, status: message.isError ? "error" : "completed" } }
      const step = steps.get(index)
      if (step) step.outcome = runStepOutcome(message)
    }
  }
  if (steps.size) await enrichConnectorEvents(organizationId, events, steps)
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

function turnFailure(turn: RunnerTurn, transcript: CloudAgentEvent[], usage: AutomationUsage): CloudAgentExecution {
  const events = [...transcript, { type: "terminal" as const, payload: { status: "failed", code: turn.error } }]
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
    const runsFor = input.forAgent ? "the person this run uses" : "the Automation owner"
    const userId = await deps.ownerUserId(input)
    if (!userId) {
      return failure({ code: "owner_membership_lost", message: input.forAgent ? "The person this run uses is no longer a member of this organization." : "The Automation owner is no longer an active organization member.", needsAttention: true })
    }
    const actor = { userId, organizationId: input.organizationId }

    if (input.previousReceipt && !previous) {
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
      if (!created.ok) return failure({ code: "execution_runtime_unavailable", message: "The headless runner is unavailable.", retryable: true })
      sessionId = created.value.id
      await input.onAdmitted({ runtime: "headless", sessionId, messageId })
    }

    let model: string
    let storedTurn: RunnerTurn | undefined
    if (previous) {
      const read = await client.readSession(sessionId, { messageId, limit: 1 })
      if (!read.ok) return failure({ code: "execution_runtime_unavailable", message: "OpenWork could not read the saved run's model. Try resuming it again.", needsAttention: true })
      storedTurn = read.value.turns.find((turn) => turn.messageId === messageId)
    }
    if (storedTurn?.model) {
      model = storedTurn.model
    } else {
      if (storedTurn) return failure({ code: "provider_unavailable", message: "The saved run has no model and cannot be resumed safely.", needsAttention: true })
      try {
        const selected = isAutomationCloudDefaultModel(input.action.model)
          ? await deps.cloudModel(actor)
          : input.action.model.modelId
        const catalog = await deps.gatewayCatalog(actor)
        if (!selected || !catalog.models.some((entry) => entry.id === selected)) throw new Error("cloud_agent_gateway_model_unavailable")
        model = selected
      } catch {
        return failure({ code: "provider_unavailable", message: `The selected cloud model is not available to ${runsFor}. Check their model access and try again.`, needsAttention: true })
      }
    }
    const priced = async (modelId: string) => {
      if (!input.forAgent) return null
      const found = await headlessRunPricing(input.organizationId, modelId).catch(() => null)
      if (found) await input.onModelResolved?.(found.model)
      return found
    }
    let pricing = await priced(model)
    let modelAccessRequired = storedTurn?.modelAccessRequired === true
    const ttlMs = Math.min(input.maximumRuntimeMs + TOKEN_GRACE_MS, DEN_MCP_HEADLESS_RUN_TOKEN_MAX_TTL_MS)
    const runSessionId = sessionId
    const execution: "steps" | undefined = (await deps.stepTurns(input.organizationId).catch(() => false)) ? "steps" : undefined
    const sendTurn = () => client.sendTurn(actor, {
      sessionId: runSessionId,
      messageId,
      prompt: input.action.instructions,
      model,
      ttlMs,
      ...(modelAccessRequired ? { modelAccessRequired: true } : {}),
      ...(execution ? { execution } : {}),
      ...(input.mcpScopes?.length ? { mcpScopes: input.mcpScopes } : {}),
    }).catch((error: unknown) => (isModelAccessRefusal(error) ? null : RUNNER_UNREACHABLE))
    const accessFailure = () => failure({ code: "provider_unavailable", message: `The cloud model is not available to ${runsFor}. Check their model access and try again.`, needsAttention: true })

    const sent = await sendTurn()
    if (!sent) return accessFailure()
    if (!sent.ok) {
      if (sent.error === "headless_saved_model_unavailable" || sent.error === "headless_model_access_unavailable") return accessFailure()
      if (sent.status === 404) {
        return failure({ code: "execution_runtime_unavailable", message: "The headless runner lost this run's session.", needsAttention: Boolean(previous) })
      }
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
        if (turn.model && turn.model !== model) {
          model = turn.model
          pricing = await priced(model)
        }
        modelAccessRequired ||= turn.modelAccessRequired === true
        const resumed = await sendTurn()
        if (!resumed) return accessFailure()
        if (!resumed.ok && (resumed.error === "headless_saved_model_unavailable" || resumed.error === "headless_model_access_unavailable")) return accessFailure()
        if (!resumed.ok && resumed.status === 404) {
          return failure({ code: "execution_failed", message: "The headless runner lost this run's session before it finished.", needsAttention: true })
        }
        continue
      }
      const usage = usageFromTurn(turn, pricing?.rates)
      if (turn.status === "aborted") {
        return failure({ code: "cancelled", status: "cancelled", message: "The Automation run was cancelled.", ...(input.forAgent ? { usage } : {}), events: [{ type: "terminal", payload: { status: "cancelled" } }] })
      }
      const events = await transcriptEvents(input.organizationId, read.value.messages, usage)
      if (turn.status === "failed") return turnFailure(turn, events, usage)
      const answer = read.value.messages.filter((message) => message.role === "assistant" && message.toolCalls.length === 0).at(-1)
      const resultSummary = (answer?.role === "assistant" ? answer.text : read.value.finalAssistantText).trim()
        || "The Automation run finished without a written result."
      const blocker = connectionBlockerFromToolCalls(read.value.messages.flatMap((message) => message.role === "tool" ? [{ name: message.name, output: message.output }] : []))
      if (blocker) {
        return connectionBlockedExecution({ blocker, answer: answer?.role === "assistant" ? answer.text : read.value.finalAssistantText, usage, events })
      }
      return {
        ok: true,
        threadId: runSessionId,
        workspaceId: "headless",
        resultSummary: resultSummary.slice(0, RESULT_SUMMARY_LIMIT),
        usage,
        events: [
          ...events,
          { type: "terminal", payload: { status: "succeeded", model: turn.model ?? null } },
        ],
      }
    }
  } catch (error) {
    const cancelled = input.signal.aborted
    const timedOut = deadline.signal.aborted
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
