import { createHeadlessThreadClient } from "@openwork/headless-threads"
import { and, asc, eq, isNull } from "@openwork-ee/den-db/drizzle"
import { MemberTable, OrganizationTable, WorkerTable } from "@openwork-ee/den-db/schema"
import { normalizeDenTypeId } from "@openwork-ee/utils/typeid"
import type { AutomationAction, AutomationError } from "@openwork/types/automations"
import { db } from "../db.js"
import { env } from "../env.js"
import { loadTelegramWorkerAccess, type TelegramWorkerAccess } from "../capability-sources/telegram-worker.js"
import { organizationCloudEnabled } from "../capability-sources/cloud-rollout.js"
import { CLOUD_INSTANCE_BACKEND } from "../workers/cloud-constants.js"
import { wakeCloudWorker } from "../workers/cloud-lifecycle.js"

const WORKER_READY_TIMEOUT_MS = 120_000
const WORKER_READY_POLL_MS = 1_000
const WORKER_REQUEST_TIMEOUT_MS = 15_000
const RESULT_SUMMARY_LIMIT = 20_000

type OwnerScope = { organizationId: string; ownerMemberId: string }
type AgentAction = Extract<AutomationAction, { kind: "agent" }>
type CloudAgentReceipt = {
  workerId: string
  workspaceId: string
  nativeThreadId: string
}

export type CloudAgentExecution =
  | { ok: true; threadId: string; resultSummary: string }
  | { ok: false; status: "failed" | "cancelled"; code: AutomationError["code"]; message: string; retryable: boolean; needsAttention?: boolean }

export type CloudAgentExecutorInput = OwnerScope & {
  automationName: string
  action: AgentAction
  maximumRuntimeMs: number
  previousReceipt: Record<string, unknown> | null
  signal: AbortSignal
  onAdmitted: (receipt: Record<string, unknown>) => Promise<void>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function parseReceipt(value: unknown): CloudAgentReceipt | null {
  if (!isRecord(value)) return null
  if (typeof value.workerId !== "string" || typeof value.workspaceId !== "string" || typeof value.nativeThreadId !== "string") return null
  return { workerId: value.workerId, workspaceId: value.workspaceId, nativeThreadId: value.nativeThreadId }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function ownerCloudWorker(scope: OwnerScope) {
  const organizationId = normalizeDenTypeId("organization", scope.organizationId)
  const ownerMemberId = normalizeDenTypeId("member", scope.ownerMemberId)
  const members = await db.select({ userId: MemberTable.userId }).from(MemberTable).where(and(
    eq(MemberTable.id, ownerMemberId),
    eq(MemberTable.organizationId, organizationId),
    isNull(MemberTable.removedAt),
  )).limit(1)
  const userId = members[0]?.userId
  if (!userId) return null
  const workers = await db.select({
    id: WorkerTable.id,
    status: WorkerTable.status,
  }).from(WorkerTable).where(and(
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
  return organizationCloudEnabled(organizations[0]?.metadata, { orgMode: env.orgMode }) && (await ownerCloudWorker(scope)) !== null
}

async function readWorkspace(access: TelegramWorkerAccess, signal: AbortSignal) {
  const headers = {
    Accept: "application/json",
    Authorization: `Bearer ${access.clientToken}`,
    "X-OpenWork-Host-Token": access.hostToken,
  }
  for (const baseUrl of access.candidates) {
    try {
      const response = await fetch(`${baseUrl}/workspaces`, {
        headers,
        signal: AbortSignal.any([signal, AbortSignal.timeout(WORKER_REQUEST_TIMEOUT_MS)]),
      })
      if (!response.ok) continue
      const payload: unknown = await response.json()
      if (isRecord(payload) && typeof payload.activeId === "string" && payload.activeId) {
        return { baseUrl, workspaceId: payload.activeId }
      }
    } catch (error) {
      if (signal.aborted) throw error
    }
  }
  return null
}

async function readyWorker(scope: OwnerScope, signal: AbortSignal) {
  const worker = await ownerCloudWorker(scope)
  if (!worker) return { ok: false as const, code: "cloud_worker_required", message: "Set up OpenWork Cloud before creating a Cloud Automation." }
  if (worker.status === "stopped") await wakeCloudWorker(worker.id)
  const deadline = Date.now() + WORKER_READY_TIMEOUT_MS
  while (!signal.aborted && Date.now() < deadline) {
    const access = await loadTelegramWorkerAccess({ organizationId: normalizeDenTypeId("organization", scope.organizationId), workerId: worker.id })
    if (access) {
      const workspace = await readWorkspace(access, signal)
      if (workspace) return { ok: true as const, workerId: worker.id, access, ...workspace }
    }
    const current = await ownerCloudWorker(scope)
    if (!current || current.status === "failed") break
    await sleep(WORKER_READY_POLL_MS)
  }
  return { ok: false as const, code: "cloud_worker_unavailable", message: "OpenWork Cloud could not be started for this Automation run." }
}

export async function executeCloudAgent(input: CloudAgentExecutorInput): Promise<CloudAgentExecution> {
  const runtime = await readyWorker(input, input.signal)
  if (!runtime.ok) {
    return { ok: false, status: input.signal.aborted ? "cancelled" : "failed", code: input.signal.aborted ? "cancelled" : "execution_runtime_unavailable", message: runtime.message, retryable: true, needsAttention: !input.signal.aborted }
  }

  const previousReceipt = parseReceipt(input.previousReceipt)
  if (previousReceipt && previousReceipt.workerId !== runtime.workerId) {
    return { ok: false, status: "failed", code: "execution_runtime_unavailable", message: "The Cloud worker changed while this Automation run was recovering.", retryable: false, needsAttention: true }
  }

  const workspaceId = previousReceipt?.workspaceId ?? runtime.workspaceId
  const client = createHeadlessThreadClient({
    baseUrl: runtime.baseUrl,
    workspaceId,
    token: runtime.access.clientToken,
    hostToken: runtime.access.hostToken,
    defaultModel: {
      providerId: input.action.model.providerId,
      modelId: input.action.model.modelId,
      ...(input.action.model.variant ? { variant: input.action.model.variant } : {}),
    },
  })

  let nativeThreadId = previousReceipt?.nativeThreadId
  if (!nativeThreadId) {
    const thread = await client.createThread({
      title: `Automation: ${input.automationName}`,
      prompt: input.action.instructions,
    })
    nativeThreadId = thread.id
    try {
      await input.onAdmitted({ workerId: runtime.workerId, workspaceId, nativeThreadId })
    } catch (error) {
      await client.abortThread(nativeThreadId).catch(() => undefined)
      throw error
    }
  }

  const waited = await client.waitForThread(nativeThreadId, { timeoutMs: input.maximumRuntimeMs, signal: input.signal })
  if (waited.outcome !== "settled") {
    await client.abortThread(nativeThreadId).catch(() => undefined)
    const cancelled = waited.outcome === "aborted"
    return {
      ok: false,
      status: cancelled ? "cancelled" : "failed",
      code: cancelled ? "cancelled" : "execution_timed_out",
      message: cancelled ? "The Automation run was cancelled." : "The Automation run exceeded its maximum runtime.",
      retryable: !cancelled,
    }
  }

  const transcript = await client.exportTranscript(nativeThreadId)
  const resultSummary = transcript.finalAssistantText.trim() || "OpenWork Cloud completed the Automation run."
  return { ok: true, threadId: nativeThreadId, resultSummary: resultSummary.slice(0, RESULT_SUMMARY_LIMIT) }
}
