import type { DenTypeId } from "@openwork-ee/utils/typeid"
import type { McpDiagnosticSnapshot } from "@openwork/types/den/mcp-diagnostics"
import { env } from "../env.js"
import { createOAuthStateToken } from "./generic-oauth.js"
import {
  diagnoseExternalMcp,
  diagnosticEvidenceFromError,
  diagnosticPhaseFromError,
  type ExternalMcpDiagnosticObserver,
  type ExternalMcpDiagnosticResult,
} from "./external-mcp-client.js"
import {
  appendMcpDiagnosticEvent,
  claimMcpDiagnosticExecutionLease,
  expireMcpDiagnosticAuthorizationIfEligible,
  failMcpDiagnosticAttempt,
  getMcpDiagnosticSnapshot,
  isMcpDiagnosticAttemptClosedError,
  MCP_DIAGNOSTIC_EXECUTION_LEASE_MS,
  releaseMcpDiagnosticExecutionLease,
  renewMcpDiagnosticExecutionLease,
  reserveMcpDiagnosticAuthorizationGeneration,
  safeMcpDiagnosticEvidence,
} from "./external-mcp-diagnostic-store.js"
import {
  deleteExternalMcpOAuthPendingGrant,
  type ExternalMcpConnectionRow,
} from "./external-mcp-connections.js"

const DEFAULT_AUTH_WAIT_MS = 10 * 60 * 1000
const DEFAULT_CALLBACK_COMPLETION_WAIT_MS = 60_000
const DEFAULT_POLL_MS = 250
const EXECUTION_RESULT_RETENTION_MS = 60_000

export type ExternalMcpDiagnosticExecutionState = {
  attemptId: DenTypeId<"mcpDiagnosticAttempt">
  connectionId: DenTypeId<"externalMcpConnection">
  authorizationUrl: string | null
  generation: number | null
  cancel: () => void
  done: Promise<void>
}

type Diagnose = typeof diagnoseExternalMcp

const executions = new Map<string, ExternalMcpDiagnosticExecutionState>()

class ExternalMcpDiagnosticExecutionCancelledError extends Error {
  constructor() {
    super("The external MCP diagnostic execution was cancelled.")
    this.name = "ExternalMcpDiagnosticExecutionCancelledError"
  }
}

async function withExecutionCancellation<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw new ExternalMcpDiagnosticExecutionCancelledError()
  let rejectCancellation: ((reason: ExternalMcpDiagnosticExecutionCancelledError) => void) | undefined
  const cancelled = new Promise<never>((_resolve, reject) => {
    rejectCancellation = reject
  })
  const onAbort = () => rejectCancellation?.(new ExternalMcpDiagnosticExecutionCancelledError())
  signal.addEventListener("abort", onAbort, { once: true })
  try {
    return await Promise.race([operation, cancelled])
  } finally {
    signal.removeEventListener("abort", onAbort)
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (!signal) return new Promise((resolve) => setTimeout(resolve, ms))
  if (signal.aborted) return Promise.reject(new ExternalMcpDiagnosticExecutionCancelledError())
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer)
      reject(new ExternalMcpDiagnosticExecutionCancelledError())
    }
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort)
      resolve()
    }, ms)
    signal.addEventListener("abort", onAbort, { once: true })
  })
}

function isTerminal(snapshot: McpDiagnosticSnapshot): boolean {
  return snapshot.attempt.status === "succeeded"
    || snapshot.attempt.status === "failed"
    || snapshot.attempt.status === "expired"
}

function persistentObserver(input: {
  organizationId: DenTypeId<"organization">
  attemptId: DenTypeId<"mcpDiagnosticAttempt">
  signal?: AbortSignal
}): ExternalMcpDiagnosticObserver {
  return async (signal) => {
    if (input.signal?.aborted) throw new ExternalMcpDiagnosticExecutionCancelledError()
    await appendMcpDiagnosticEvent({
      organizationId: input.organizationId,
      attemptId: input.attemptId,
      phase: signal.phase,
      outcome: signal.outcome,
      healthLevel: signal.healthLevel,
      messageSafe: signal.messageSafe,
      phaseDurationMs: signal.phaseDurationMs,
      category: signal.category,
      retryable: signal.retryable,
      actionOwner: signal.actionOwner,
      operatorAction: signal.operatorAction,
      evidence: signal.evidence,
      attemptStatus: signal.attemptStatus,
    })
  }
}

export async function runExternalMcpDiagnosticExecution(input: {
  organizationId: DenTypeId<"organization">
  attemptId: DenTypeId<"mcpDiagnosticAttempt">
  connection: ExternalMcpConnectionRow
  orgMembershipId: DenTypeId<"member">
  redirectUri: string
  state: Pick<ExternalMcpDiagnosticExecutionState, "authorizationUrl" | "generation">
  authWaitMs?: number
  callbackCompletionWaitMs?: number
  pollMs?: number
  executionLeaseMs?: number
  executionHeartbeatMs?: number
  diagnose?: Diagnose
  onComplete?: (snapshot: McpDiagnosticSnapshot) => Promise<void>
  signal?: AbortSignal
}): Promise<void> {
  const observer = persistentObserver({ organizationId: input.organizationId, attemptId: input.attemptId, signal: input.signal })
  const diagnose = input.diagnose ?? diagnoseExternalMcp
  const pollMs = input.pollMs ?? DEFAULT_POLL_MS
  const member = input.connection.credentialMode === "per_member"
    ? { orgMembershipId: input.orgMembershipId }
    : undefined
  let signedState: string | undefined
  const executionLeaseMs = input.executionLeaseMs ?? MCP_DIAGNOSTIC_EXECUTION_LEASE_MS
  const executionLease = await claimMcpDiagnosticExecutionLease({
    organizationId: input.organizationId,
    attemptId: input.attemptId,
    leaseMs: executionLeaseMs,
  })
  if (!executionLease) return
  const executionHeartbeatMs = input.executionHeartbeatMs ?? Math.max(1_000, Math.floor(executionLeaseMs / 3))
  const heartbeat = setInterval(() => {
    void renewMcpDiagnosticExecutionLease({
      organizationId: input.organizationId,
      attemptId: input.attemptId,
      leaseId: executionLease.leaseId,
      leaseMs: executionLeaseMs,
    }).catch((error) => {
      console.error("external_mcp_diagnostic_execution_heartbeat_failed", {
        attemptId: input.attemptId,
        organizationId: input.organizationId,
        errorName: error instanceof Error ? error.name : "UnknownError",
      })
    })
  }, executionHeartbeatMs)
  heartbeat.unref()

  try {
    await observer({
      phase: "CONFIGURATION",
      outcome: "passed",
      healthLevel: "configured",
      messageSafe: "The connection configuration is syntactically valid and tenant scoped.",
      evidence: safeMcpDiagnosticEvidence({ url: input.connection.url }),
    })
    if (input.connection.authType === "oauth") {
      input.state.generation = await reserveMcpDiagnosticAuthorizationGeneration({
        organizationId: input.organizationId,
        attemptId: input.attemptId,
      })
      signedState = createOAuthStateToken({
        organizationId: input.organizationId,
        orgMembershipId: input.orgMembershipId,
        providerId: input.connection.id,
        diagnosticAttemptId: input.attemptId,
        diagnosticAttemptGeneration: input.state.generation,
        secret: env.betterAuthSecret,
      })
    }

    const diagnosis = diagnose({
      connection: input.connection,
      redirectUri: input.redirectUri,
      signedState,
      member,
      ...(input.state.generation === null
        ? {}
        : { diagnosticAuthorization: { attemptId: input.attemptId, generation: input.state.generation } }),
      observe: observer,
    })
    const result: ExternalMcpDiagnosticResult = input.signal
      ? await withExecutionCancellation(diagnosis, input.signal)
      : await diagnosis
    if (result.status === "needs_auth") {
      input.state.authorizationUrl = result.authorizeUrl
      const waitDeadline = Date.now() + (input.authWaitMs ?? DEFAULT_AUTH_WAIT_MS)
      while (Date.now() < waitDeadline) {
        const snapshot = await getMcpDiagnosticSnapshot({
          organizationId: input.organizationId,
          attemptId: input.attemptId,
        })
        if (!snapshot || isTerminal(snapshot)) return
        await sleep(Math.max(1, Math.min(pollMs, waitDeadline - Date.now())), input.signal)
      }

      if (input.state.generation === null) return
      while (true) {
        const expiry = await expireMcpDiagnosticAuthorizationIfEligible({
          organizationId: input.organizationId,
          attemptId: input.attemptId,
          generation: input.state.generation,
        })
        if (expiry.status === "terminal") return
        if (expiry.status === "expired") {
          return
        }
        if (expiry.status === "not_eligible") {
          const callbackDeadline = Date.now() + (input.callbackCompletionWaitMs ?? DEFAULT_CALLBACK_COMPLETION_WAIT_MS)
          while (Date.now() < callbackDeadline) {
            const snapshot = await getMcpDiagnosticSnapshot({
              organizationId: input.organizationId,
              attemptId: input.attemptId,
            })
            if (!snapshot || isTerminal(snapshot)) return
            await sleep(Math.max(1, Math.min(pollMs, callbackDeadline - Date.now())), input.signal)
          }
          await observer({
            phase: "AUTH_TOKEN_ACQUISITION",
            outcome: "failed",
            healthLevel: "reachable",
            messageSafe: "The OAuth callback committed credentials but did not complete the bounded MCP verification.",
            category: "oauth_callback_incomplete",
            retryable: true,
            actionOwner: "provider_admin",
            operatorAction: "restart_provider_authorization",
            attemptStatus: "failed",
          })
          return
        }
        await sleep(Math.max(1, Math.min(pollMs, expiry.retryAt.getTime() - Date.now())), input.signal)
      }
    }
  } catch (error) {
    if (input.signal?.aborted || error instanceof ExternalMcpDiagnosticExecutionCancelledError) return
    if (!isMcpDiagnosticAttemptClosedError(error)) {
      const phase = diagnosticPhaseFromError(error)
      try {
        await failMcpDiagnosticAttempt({
          organizationId: input.organizationId,
          attemptId: input.attemptId,
          phase,
          healthLevel: phase.startsWith("MCP_") ? "authorized" : "configured",
          error,
          url: input.connection.url,
          evidence: diagnosticEvidenceFromError(error),
        })
      } catch (failureError) {
        if (!isMcpDiagnosticAttemptClosedError(failureError)) throw failureError
      }
    }
  } finally {
    clearInterval(heartbeat)
    input.state.authorizationUrl = null
    if (signedState) {
      await deleteExternalMcpOAuthPendingGrant({
        organizationId: input.organizationId,
        connectionId: input.connection.id,
        orgMembershipId: member?.orgMembershipId ?? null,
        signedState,
      }).catch((error) => {
        console.error("external_mcp_diagnostic_pending_grant_cleanup_failed", {
          attemptId: input.attemptId,
          connectionId: input.connection.id,
          organizationId: input.organizationId,
          errorName: error instanceof Error ? error.name : "UnknownError",
        })
      })
    }
    await releaseMcpDiagnosticExecutionLease({
      organizationId: input.organizationId,
      attemptId: input.attemptId,
      leaseId: executionLease.leaseId,
    }).catch((error) => {
      console.error("external_mcp_diagnostic_execution_lease_release_failed", {
        attemptId: input.attemptId,
        organizationId: input.organizationId,
        errorName: error instanceof Error ? error.name : "UnknownError",
      })
    })
    const snapshot = await getMcpDiagnosticSnapshot({
      organizationId: input.organizationId,
      attemptId: input.attemptId,
    })
    if (snapshot && isTerminal(snapshot)) await input.onComplete?.(snapshot)
  }
}

export function startExternalMcpDiagnosticExecution(input: Omit<
  Parameters<typeof runExternalMcpDiagnosticExecution>[0],
  "state"
>): ExternalMcpDiagnosticExecutionState {
  const existing = executions.get(input.attemptId)
  if (existing) return existing
  const cancellation = new AbortController()
  const mutable = { authorizationUrl: null as string | null, generation: null as number | null }
  const state: ExternalMcpDiagnosticExecutionState = {
    attemptId: input.attemptId,
    connectionId: input.connection.id,
    get authorizationUrl() { return mutable.authorizationUrl },
    set authorizationUrl(value: string | null) { mutable.authorizationUrl = value },
    get generation() { return mutable.generation },
    set generation(value: number | null) { mutable.generation = value },
    cancel: () => cancellation.abort(new ExternalMcpDiagnosticExecutionCancelledError()),
    done: Promise.resolve(),
  }
  state.done = runExternalMcpDiagnosticExecution({ ...input, state: mutable, signal: cancellation.signal }).finally(() => {
    const timer = setTimeout(() => executions.delete(input.attemptId), EXECUTION_RESULT_RETENTION_MS)
    timer.unref()
  })
  // Always attach a rejection handler; no request/socket owns this execution.
  void state.done.catch((error) => {
    console.error("external_mcp_diagnostic_execution_failed", {
      attemptId: input.attemptId,
      organizationId: input.organizationId,
      errorName: error instanceof Error ? error.name : "UnknownError",
    })
  })
  executions.set(input.attemptId, state)
  return state
}

export function getExternalMcpDiagnosticExecution(attemptId: DenTypeId<"mcpDiagnosticAttempt">) {
  return executions.get(attemptId) ?? null
}

export async function cancelExternalMcpDiagnosticExecutionsForConnection(
  connectionId: DenTypeId<"externalMcpConnection">,
): Promise<void> {
  const matching = [...executions.entries()].filter(([, execution]) => execution.connectionId === connectionId)
  for (const [attemptId, execution] of matching) {
    execution.cancel()
    executions.delete(attemptId)
  }
  await Promise.allSettled(matching.map(([, execution]) => execution.done))
}
