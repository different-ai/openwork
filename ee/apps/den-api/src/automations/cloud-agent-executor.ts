import { createHash } from "node:crypto"
import { createHeadlessThreadClient, type HeadlessThreadTranscript } from "@openwork/headless-threads"
import { and, asc, eq, isNull } from "@openwork-ee/den-db/drizzle"
import { MemberTable, OrganizationTable, WorkerTable } from "@openwork-ee/den-db/schema"
import { normalizeDenTypeId } from "@openwork-ee/utils/typeid"
import type { AutomationAction, AutomationError, AutomationUsage } from "@openwork/types/automations"
import { db } from "../db.js"
import { env } from "../env.js"
import { resolveCloudRuntimeAccess, type CloudWorkerAccess } from "../workers/worker-access.js"
import { organizationCloudEnabled } from "../capability-sources/cloud-rollout.js"
import { CLOUD_INSTANCE_BACKEND } from "../workers/cloud-constants.js"
import { wakeCloudWorker } from "../workers/cloud-lifecycle.js"
import { fetchPreviewNoRedirect, previewFetch } from "../workers/preview-fetch.js"
import { resolveAutomationModelAccess } from "./authority.js"

const WORKER_READY_TIMEOUT_MS = 120_000
const WORKER_READY_POLL_MS = 1_000
const WORKER_REQUEST_TIMEOUT_MS = 15_000
const ABORT_SETTLE_TIMEOUT_MS = 15_000
const RESULT_SUMMARY_LIMIT = 20_000

type OwnerScope = { organizationId: string; ownerMemberId: string }
type AgentAction = Extract<AutomationAction, { kind: "agent" }>
type CloudAgentRuntimeUnavailableReason = "missing" | "failed" | "waking" | "unreachable"
type CloudAgentRuntimeResult =
  | { ok: true; workerId: string; access: CloudWorkerAccess; baseUrl: string; workspaceId: string }
  | { ok: false; reason: CloudAgentRuntimeUnavailableReason; message: string }
type CloudAgentReceipt = {
  workerId: string
  workspaceId: string
  nativeThreadId: string
  messageId: string
}

export type CloudAgentEvent = {
  type: "user" | "assistant" | "capability_execution" | "usage" | "warning" | "terminal"
  payload: Record<string, unknown>
}

export type CloudAgentExecution =
  | {
      ok: true
      threadId: string
      workspaceId: string
      resultSummary: string
      usage: AutomationUsage
      events: CloudAgentEvent[]
    }
  | {
      ok: false
      status: "failed" | "cancelled"
      code: AutomationError["code"]
      message: string
      retryable: boolean
      needsAttention?: boolean
      events?: CloudAgentEvent[]
      usage?: AutomationUsage
    }

export type CloudAgentExecutorInput = OwnerScope & {
  automationRunId: string
  automationName: string
  action: AgentAction
  maximumRuntimeMs: number
  previousReceipt: Record<string, unknown> | null
  signal: AbortSignal
  onAdmitted: (receipt: Record<string, unknown>) => Promise<void>
  /** Workspace pinned on the revision; null falls back to the worker's active workspace. */
  workspaceId?: string | null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function parseReceipt(value: unknown): CloudAgentReceipt | null {
  if (!isRecord(value)) return null
  if (typeof value.workerId !== "string" || typeof value.workspaceId !== "string"
    || typeof value.nativeThreadId !== "string" || typeof value.messageId !== "string") return null
  return {
    workerId: value.workerId,
    workspaceId: value.workspaceId,
    nativeThreadId: value.nativeThreadId,
    messageId: value.messageId,
  }
}

function messageIdForRun(runId: string): string {
  return `msg_${createHash("sha256").update(`automation:${runId}`).digest("hex").slice(0, 26)}`
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

function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason)
  return new Promise((resolve, reject) => {
    const aborted = () => reject(signal.reason)
    signal.addEventListener("abort", aborted, { once: true })
    operation.then(
      (value) => {
        signal.removeEventListener("abort", aborted)
        resolve(value)
      },
      (error) => {
        signal.removeEventListener("abort", aborted)
        reject(error)
      },
    )
  })
}

async function ownerCloudUserId(scope: OwnerScope) {
  const organizationId = normalizeDenTypeId("organization", scope.organizationId)
  const ownerMemberId = normalizeDenTypeId("member", scope.ownerMemberId)
  const members = await db.select({ userId: MemberTable.userId }).from(MemberTable).where(and(
    eq(MemberTable.id, ownerMemberId),
    eq(MemberTable.organizationId, organizationId),
    isNull(MemberTable.removedAt),
  )).limit(1)
  return members[0]?.userId ?? null
}

async function ownerCloudWorker(scope: OwnerScope) {
  const organizationId = normalizeDenTypeId("organization", scope.organizationId)
  const userId = await ownerCloudUserId(scope)
  if (!userId) return null
  const workers = await db.select({ id: WorkerTable.id, status: WorkerTable.status })
    .from(WorkerTable).where(and(
      eq(WorkerTable.org_id, organizationId),
      eq(WorkerTable.created_by_user_id, userId),
      eq(WorkerTable.destination, "cloud"),
      eq(WorkerTable.sandbox_backend, CLOUD_INSTANCE_BACKEND),
    )).orderBy(asc(WorkerTable.created_at), asc(WorkerTable.id)).limit(1)
  return workers[0] ?? null
}

export async function cloudAgentRuntimeAvailable(scope: OwnerScope): Promise<boolean> {
  if (env.provisionerMode !== "daytona" || !env.daytona.apiKey) return false
  const organizationId = normalizeDenTypeId("organization", scope.organizationId)
  const members = await db.select({ id: MemberTable.id }).from(MemberTable).where(and(
    eq(MemberTable.id, normalizeDenTypeId("member", scope.ownerMemberId)),
    eq(MemberTable.organizationId, organizationId),
    isNull(MemberTable.removedAt),
  )).limit(1)
  if (!members[0]) return false
  const organizations = await db.select({ metadata: OrganizationTable.metadata }).from(OrganizationTable)
    .where(eq(OrganizationTable.id, organizationId)).limit(1)
  const worker = await ownerCloudWorker(scope)
  return organizationCloudEnabled(organizations[0]?.metadata, { orgMode: env.orgMode })
    && worker !== null && worker.status !== "failed"
}

function workerHeaders(access: CloudWorkerAccess) {
  return {
    Accept: "application/json",
    Authorization: `Bearer ${access.clientToken}`,
    "X-OpenWork-Host-Token": access.hostToken,
  }
}

export async function resolveCloudAgentWorkspace(
  access: CloudWorkerAccess,
  signal: AbortSignal,
  fetchImpl: typeof fetch = fetch,
) {
  try {
    const response = await fetchPreviewNoRedirect(fetchImpl, `${access.url}/workspaces`, {
      headers: workerHeaders(access),
      signal: AbortSignal.any([signal, AbortSignal.timeout(WORKER_REQUEST_TIMEOUT_MS)]),
    })
    if (!response.ok) return null
    const payload: unknown = await response.json()
    if (isRecord(payload) && typeof payload.activeId === "string" && payload.activeId) {
      return { baseUrl: access.url, workspaceId: payload.activeId }
    }
  } catch (error) {
    if (signal.aborted) throw error
    return null
  }
  return null
}

export type CloudAgentReadyWorkerDeps = {
  ownerUserId: typeof ownerCloudUserId
  resolveAccess: typeof resolveCloudRuntimeAccess
  wakeWorker: typeof wakeCloudWorker
  resolveWorkspace: typeof resolveCloudAgentWorkspace
  now: () => number
  sleep: typeof abortableSleep
}

export async function resolveCloudAgentReadyWorker(
  scope: OwnerScope,
  signal: AbortSignal,
  options: Partial<CloudAgentReadyWorkerDeps> = {},
): Promise<CloudAgentRuntimeResult> {
  const deps: CloudAgentReadyWorkerDeps = {
    ownerUserId: options.ownerUserId ?? ownerCloudUserId,
    resolveAccess: options.resolveAccess ?? resolveCloudRuntimeAccess,
    wakeWorker: options.wakeWorker ?? wakeCloudWorker,
    resolveWorkspace: options.resolveWorkspace ?? resolveCloudAgentWorkspace,
    now: options.now ?? Date.now,
    sleep: options.sleep ?? abortableSleep,
  }
  const userId = await deps.ownerUserId(scope)
  if (!userId) return { ok: false, reason: "missing", message: "Set up OpenWork Cloud before creating a Cloud Automation." }
  let deadline = deps.now() + WORKER_READY_TIMEOUT_MS
  let waitedForLifecycle = false
  let pending: Extract<CloudAgentRuntimeResult, { ok: false }> = {
    ok: false,
    reason: "waking",
    message: "OpenWork Cloud is still starting for this Automation run.",
  }
  while (!signal.aborted && deps.now() < deadline) {
    const access = await deps.resolveAccess({
      organizationId: normalizeDenTypeId("organization", scope.organizationId),
      userId,
    })
    if (access.status === "missing") {
      return { ok: false, reason: "missing", message: "Set up OpenWork Cloud before creating a Cloud Automation." }
    }
    if (
      !waitedForLifecycle &&
      access.status === "waking" &&
      (access.reason === "stopped" || access.reason === "recovering")
    ) {
      waitedForLifecycle = true
      await abortable(deps.wakeWorker(access.workerId), signal)
      deadline = deps.now() + WORKER_READY_TIMEOUT_MS
      continue
    }
    if (access.status !== "ready" && access.reason === "unreachable") {
      pending = { ok: false, reason: "unreachable", message: "The OpenWork Cloud runtime is healthy but unreachable for this Automation run." }
      await deps.sleep(WORKER_READY_POLL_MS, signal)
      continue
    }
    if (access.status === "failed") {
      return { ok: false, reason: "failed", message: "The OpenWork Cloud runtime needs repair before this Automation can run." }
    }
    if (access.status === "ready") {
      const workspace = await deps.resolveWorkspace(access, signal)
      if (workspace) return { ok: true, workerId: access.workerId, access, ...workspace }
      pending = { ok: false, reason: "unreachable", message: "The OpenWork Cloud runtime session API is unreachable for this Automation run." }
    } else {
      pending = { ok: false, reason: "waking", message: "OpenWork Cloud is still starting for this Automation run." }
    }
    await deps.sleep(WORKER_READY_POLL_MS, signal)
  }
  return pending
}

export function cloudAgentRuntimeUnavailableResult(input: {
  reason: CloudAgentRuntimeUnavailableReason
  message: string
  cancelled: boolean
  timedOut: boolean
}): CloudAgentExecution {
  if (input.cancelled) {
    return { ok: false, status: "cancelled", code: "cancelled", message: "The Automation run was cancelled.", retryable: false }
  }
  if (input.timedOut) {
    return {
      ok: false,
      status: "failed",
      code: "execution_timed_out",
      message: "The Automation run exceeded its maximum runtime while starting OpenWork Cloud.",
      retryable: false,
    }
  }
  return {
    ok: false,
    status: "failed",
    code: "execution_runtime_unavailable",
    message: input.message,
    retryable: false,
    needsAttention: true,
  }
}

async function connectHealth(input: {
  baseUrl: string
  workspaceId: string
  access: CloudWorkerAccess
  action: AgentAction
  signal: AbortSignal
}): Promise<{ ok: true } | { ok: false; code: "connect_access_unavailable" | "model_access_lost"; message: string }> {
  const encodedWorkspace = encodeURIComponent(input.workspaceId)
  const query = new URLSearchParams({
    provider: input.action.model.providerId,
    model: input.action.model.modelId,
    probe: "true",
  })
  const request = async (method: "GET" | "POST", path: string, body?: unknown) => {
    const response = await fetchPreviewNoRedirect(previewFetch(), `${input.baseUrl}${path}`, {
      method,
      headers: {
        ...workerHeaders(input.access),
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.any([input.signal, AbortSignal.timeout(WORKER_REQUEST_TIMEOUT_MS)]),
    })
    if (!response.ok) return null
    const value: unknown = await response.json()
    return isRecord(value) ? value : null
  }
  let value = await request("GET", `/workspace/${encodedWorkspace}/mcp/openwork-cloud/health?${query}`)
  let health = value
  if (health?.usable !== true || health.usableByCurrentModel !== true) {
    value = await request("POST", `/workspace/${encodedWorkspace}/mcp/openwork-cloud/engine-refresh`, {
      provider: input.action.model.providerId,
      model: input.action.model.modelId,
      trigger: "automation_run",
    })
    health = isRecord(value?.health) ? value.health : null
  }
  if (health?.usable === true && health.usableByCurrentModel === true) return { ok: true }
  if (health?.usable === true && health.usableByCurrentModel !== true) {
    return { ok: false, code: "model_access_lost", message: "The selected model cannot use the current OpenWork Connect capabilities." }
  }
  const failure = isRecord(health?.firstFailure) ? health.firstFailure : null
  return {
    ok: false,
    code: "connect_access_unavailable",
    message: typeof failure?.message === "string"
      ? failure.message
      : "OpenWork Connect is not ready in the Cloud runtime. Reconnect it before retrying this Automation.",
  }
}

function usageFromTranscript(usage: {
  inputTokens: number
  outputTokens: number
  reasoningTokens: number
  cacheReadTokens: number
  cost: number
}): AutomationUsage {
  return {
    inputTokens: usage.inputTokens + usage.cacheReadTokens,
    outputTokens: usage.outputTokens + usage.reasoningTokens,
    costMicros: Math.max(0, Math.round(usage.cost * 1_000_000)),
  }
}

function transcriptEvents(
  transcript: HeadlessThreadTranscript,
  usage: AutomationUsage,
): CloudAgentEvent[] {
  const events: CloudAgentEvent[] = []
  for (const message of transcript.messages.slice(-100)) {
    if (message.role === "user") events.push({ type: "user", payload: { messageId: message.id, text: message.text.slice(0, 20_000) } })
    if (message.role === "assistant") {
      // Keep the native thread as the source of any provider-visible reasoning
      // trace. Den receipts need the answer and tool activity, not a second
      // durable copy of the model's internal working text.
      events.push({ type: "assistant", payload: { messageId: message.id, text: message.text.slice(0, 20_000) } })
      for (const tool of message.toolCalls) {
        events.push({ type: "capability_execution", payload: { messageId: message.id, ...tool } })
      }
    }
  }
  events.push({ type: "usage", payload: usage })
  return events
}

function terminalFailure(input: {
  error: { name: string; message: string; retryable: boolean | null }
  transcript: HeadlessThreadTranscript
  usage: AutomationUsage
}): CloudAgentExecution {
  const { error, transcript, usage } = input
  const modelAccess = error.name === "ProviderAuthError"
  return {
    ok: false,
    status: "failed",
    code: modelAccess ? "model_access_lost" : "execution_failed",
    message: error.message,
    retryable: false,
    needsAttention: modelAccess,
    usage,
    events: [
      ...transcriptEvents(transcript, usage),
      { type: "terminal", payload: { status: "failed", errorName: error.name, message: error.message } },
    ],
  }
}

async function abortAndObserve(
  client: ReturnType<typeof createHeadlessThreadClient>,
  nativeThreadId: string,
): Promise<boolean> {
  const cleanupSignal = AbortSignal.timeout(ABORT_SETTLE_TIMEOUT_MS)
  const accepted = await client.abortThread(nativeThreadId, { signal: cleanupSignal }).catch(() => null)
  if (!accepted?.accepted) return false
  const stopped = await client.waitUntilIdle(nativeThreadId, {
    timeoutMs: ABORT_SETTLE_TIMEOUT_MS,
    signal: cleanupSignal,
  }).catch(() => null)
  return stopped?.outcome === "settled"
}

async function currentAgentAuthority(input: OwnerScope & { action: AgentAction }): Promise<CloudAgentExecution | null> {
  const access = await resolveAutomationModelAccess({
    organizationId: input.organizationId,
    ownerMemberId: input.ownerMemberId,
    providerId: input.action.model.providerId,
    modelId: input.action.model.modelId,
  })
  if (access.ok) return null
  return {
    ok: false,
    status: "failed",
    code: access.code,
    message: access.message,
    retryable: false,
    needsAttention: true,
  }
}

export async function executeCloudAgent(input: CloudAgentExecutorInput): Promise<CloudAgentExecution> {
  const deadlineController = new AbortController()
  const deadlineTimer = setTimeout(() => deadlineController.abort(new Error("automation_deadline_exceeded")), input.maximumRuntimeMs)
  const signal = AbortSignal.any([input.signal, deadlineController.signal])
  let client: ReturnType<typeof createHeadlessThreadClient> | null = null
  let nativeThreadId: string | null = null
  try {
    const initialAuthorityFailure = await currentAgentAuthority(input)
    if (initialAuthorityFailure) return initialAuthorityFailure
    const runtime = await resolveCloudAgentReadyWorker(input, signal)
    if (!runtime.ok) {
      return cloudAgentRuntimeUnavailableResult({
        reason: runtime.reason,
        message: runtime.message,
        cancelled: input.signal.aborted,
        timedOut: deadlineController.signal.aborted,
      })
    }

    const previousReceipt = parseReceipt(input.previousReceipt)
    if (input.previousReceipt && !previousReceipt) {
      return { ok: false, status: "failed", code: "execution_runtime_unavailable", message: "The saved Cloud execution receipt is incomplete and cannot be recovered safely.", retryable: false, needsAttention: true }
    }
    if (previousReceipt && previousReceipt.workerId !== runtime.workerId) {
      return { ok: false, status: "failed", code: "execution_runtime_unavailable", message: "The Cloud worker changed while this Automation run was recovering.", retryable: false, needsAttention: true }
    }

    // Recovery keeps the receipt's workspace (the turn may already be running
    // there); otherwise the revision pin wins over the worker's active workspace.
    const workspaceId = previousReceipt?.workspaceId ?? input.workspaceId ?? runtime.workspaceId
    const connect = await connectHealth({ ...runtime, workspaceId, action: input.action, signal })
    if (!connect.ok) {
      return { ok: false, status: "failed", code: connect.code, message: connect.message, retryable: false, needsAttention: true }
    }

    client = createHeadlessThreadClient({
      baseUrl: runtime.baseUrl,
      workspaceId,
      token: runtime.access.clientToken,
      hostToken: runtime.access.hostToken,
      requestTimeoutMs: WORKER_REQUEST_TIMEOUT_MS,
      fetch: (url, init = {}) => fetchPreviewNoRedirect(previewFetch(), url, init),
      defaultModel: {
        providerId: input.action.model.providerId,
        modelId: input.action.model.modelId,
        ...(input.action.model.variant ? { variant: input.action.model.variant } : {}),
      },
    })

    const messageId = previousReceipt?.messageId ?? messageIdForRun(input.automationRunId)
    nativeThreadId = previousReceipt?.nativeThreadId ?? null
    const recoveringNativeThread = nativeThreadId !== null
    if (!nativeThreadId) {
      // Wake-up and Connect repair can take minutes. Re-check live authority at
      // the native-thread boundary so queued recovery cannot use credentials
      // materialized before the owner or model grant was revoked.
      const authorityFailure = await currentAgentAuthority(input)
      if (authorityFailure) return authorityFailure
      const thread = await client.createThread({ title: `Automation: ${input.automationName}`, signal })
      nativeThreadId = thread.id
      // Persist the native session and stable user-message id before any work
      // is submitted. Recovery can now observe-or-submit the exact same turn.
      await input.onAdmitted({ workerId: runtime.workerId, workspaceId, nativeThreadId, messageId })
    }

    // Thread creation and receipt persistence are also asynchronous. Make the
    // final authorization decision immediately before submitting the turn.
    const authorityFailure = await currentAgentAuthority(input)
    if (authorityFailure) {
      // A recovered receipt may refer to a turn admitted by a previous Den
      // process. Do not terminalize the run until that thread is observably
      // stopped, or a retry could overlap side effects from the revoked turn.
      if (recoveringNativeThread && !await abortAndObserve(client, nativeThreadId)) {
        return {
          ok: false,
          status: "failed",
          code: "execution_failed",
          message: "Model authority was revoked, but OpenWork Cloud could not confirm that the native thread stopped. Inspect the native run before retrying.",
          retryable: false,
          needsAttention: true,
          events: [{ type: "warning", payload: { code: "authority_revoked_abort_not_observed", nativeThreadId } }],
        }
      }
      return authorityFailure
    }
    const accepted = await client.sendTurn(nativeThreadId, {
      prompt: input.action.instructions,
      messageId,
      signal,
    })
    const waited = await client.waitForThread(nativeThreadId, {
      timeoutMs: Math.max(1, input.maximumRuntimeMs),
      since: accepted,
      signal,
    })
    if (waited.outcome === "failed" && waited.terminalError) {
      const transcript = await client.exportTranscript(nativeThreadId, { signal })
      const usage = usageFromTranscript(transcript.usage)
      return terminalFailure({ error: waited.terminalError, transcript, usage })
    }
    if (waited.outcome !== "settled") {
      const stopped = await abortAndObserve(client, nativeThreadId)
      const cancelled = input.signal.aborted
      if (!stopped) {
        return {
          ok: false,
          status: "failed",
          code: "execution_failed",
          message: "OpenWork Cloud could not confirm that the cancelled agent thread stopped. Inspect the native run before retrying.",
          retryable: false,
          needsAttention: true,
          events: [{ type: "warning", payload: { code: "abort_not_observed", nativeThreadId } }],
        }
      }
      return {
        ok: false,
        status: cancelled ? "cancelled" : "failed",
        code: cancelled ? "cancelled" : "execution_timed_out",
        message: cancelled ? "The Automation run was cancelled." : "The Automation run exceeded its maximum runtime.",
        retryable: false,
        events: [{ type: "terminal", payload: { status: cancelled ? "cancelled" : "failed" } }],
      }
    }

    const transcript = await client.exportTranscript(nativeThreadId, { signal })
    const usage = usageFromTranscript(transcript.usage)
    if (transcript.terminalError) return terminalFailure({ error: transcript.terminalError, transcript, usage })
    const resultSummary = transcript.finalAssistantText.trim() || "OpenWork Cloud completed the Automation run."
    return {
      ok: true,
      threadId: nativeThreadId,
      workspaceId,
      resultSummary: resultSummary.slice(0, RESULT_SUMMARY_LIMIT),
      usage,
      events: [
        ...transcriptEvents(transcript, usage),
        { type: "terminal", payload: { status: "succeeded" } },
      ],
    }
  } catch (error) {
    const cancelled = input.signal.aborted
    const timedOut = deadlineController.signal.aborted
    // Once a native thread exists, any exception may have happened after the
    // deterministic user turn was accepted (including an individual request
    // timeout). Do not terminalize until the engine is observably idle.
    if (client && nativeThreadId) {
      const stopped = await abortAndObserve(client, nativeThreadId)
      if (!stopped) {
        return {
          ok: false,
          status: "failed",
          code: "execution_failed",
          message: "OpenWork Cloud could not confirm that the interrupted agent thread stopped. Inspect the native run before retrying.",
          retryable: false,
          needsAttention: true,
          events: [{ type: "warning", payload: { code: "abort_not_observed", nativeThreadId } }],
        }
      }
    }
    return {
      ok: false,
      status: cancelled ? "cancelled" : "failed",
      code: cancelled ? "cancelled" : timedOut ? "execution_timed_out" : "execution_failed",
      message: cancelled ? "The Automation run was cancelled."
        : timedOut ? "The Automation run exceeded its maximum runtime." : error instanceof Error ? error.message : "Cloud agent execution failed.",
      // A thrown transport or executor error may happen after OpenCode accepted
      // the stable user-message id. Never replay agent work automatically when
      // we cannot prove that no side effects started.
      retryable: false,
    }
  } finally {
    clearTimeout(deadlineTimer)
  }
}
