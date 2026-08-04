import type {
  ScheduledTask,
  ScheduledTaskArtifactReference,
  ScheduledTaskAttempt,
  ScheduledTaskCapabilityReference,
  ScheduledTaskExecutionEvent,
  ScheduledTaskExecutionRequest,
  ScheduledTaskExecutionResult,
  ScheduledTaskExecutionTarget,
  ScheduledTaskGrant,
  ScheduledTaskRevision,
  ScheduledTaskRun,
  ScheduledTaskPlacement,
  ScheduledTaskTypedError,
} from "@openwork/types/scheduled-tasks"
import type { ScheduledTaskTickPort } from "./tick.js"
import type { ScheduledTaskRepositoryFilter } from "./contracts.js"

export type Awaitable<T> = T | Promise<T>

export interface ScheduledTaskListItem {
  task: ScheduledTask
  revision: ScheduledTaskRevision
  grant?: ScheduledTaskGrant
  latestRun?: ScheduledTaskRun
}

export interface ScheduledTaskDetail {
  task: ScheduledTask
  draftRevision: ScheduledTaskRevision
  activeRevision: ScheduledTaskRevision | null
  grant: ScheduledTaskGrant | null
  runs: ScheduledTaskRun[]
}

export interface ScheduledTaskOccurrenceRecord {
  id: string
  taskId: string
  taskRevisionId: string
  scheduledFor: number | null
  trigger: ScheduledTaskRun["trigger"]
  status: ScheduledTaskRun["status"]
  claimedAt: number
}

export type ScheduledTaskClaimResult =
  | { kind: "claimed"; run: ScheduledTaskRun }
  | { kind: "duplicate"; run: ScheduledTaskRun }
  | { kind: "overlap"; run: ScheduledTaskRun }

/**
 * Durable ledger port. `claimOccurrence` must atomically enforce occurrence
 * uniqueness and overlap policy. Awaitable results let SQLite stay synchronous
 * while networked MySQL adapters implement the same contract asynchronously.
 */
export interface ScheduledTaskRepository {
  createTask(task: ScheduledTask, revision: ScheduledTaskRevision): Awaitable<void>
  createRevision(task: ScheduledTask, revision: ScheduledTaskRevision): Awaitable<void>
  activateGrant(
    task: ScheduledTask,
    reviewedRevision: ScheduledTaskRevision,
    grant: ScheduledTaskGrant,
  ): Awaitable<void>
  saveTask(task: ScheduledTask): Awaitable<void>
  getTask(taskId: string): Awaitable<ScheduledTask | null>
  getRevision(revisionId: string): Awaitable<ScheduledTaskRevision | null>
  getGrant(grantId: string): Awaitable<ScheduledTaskGrant | null>
  revokeGrant(
    grantId: string,
    revokedAt: number,
    reason: string,
    revokedBy: string,
  ): Awaitable<ScheduledTaskGrant>
  getDetail(taskId: string, runLimit?: number): Awaitable<ScheduledTaskDetail | null>
  listTasks(scope: ScheduledTaskRepositoryFilter): Awaitable<ScheduledTaskListItem[]>
  listDueTasks(
    now: number,
    scope?: ScheduledTaskRepositoryFilter,
  ): Awaitable<ScheduledTask[]>
  nextDueAt(scope?: ScheduledTaskRepositoryFilter): Awaitable<number | null>
  claimOccurrence(
    occurrence: ScheduledTaskOccurrenceRecord,
    claimedRun: ScheduledTaskRun,
    overlapRun: ScheduledTaskRun,
    taskAfterClaim?: ScheduledTask,
  ): Awaitable<ScheduledTaskClaimResult>
  saveRun(run: ScheduledTaskRun): Awaitable<void>
  getRun(runId: string): Awaitable<ScheduledTaskRun | null>
  listRuns(taskId: string, limit?: number): Awaitable<ScheduledTaskRun[]>
  listInterruptedRuns(): Awaitable<ScheduledTaskRun[]>
  createAttempt(attempt: ScheduledTaskAttempt): Awaitable<void>
  saveAttempt(attempt: ScheduledTaskAttempt): Awaitable<void>
  listAttempts(runId: string): Awaitable<ScheduledTaskAttempt[]>
  close(): Awaitable<void>
}

/** Synchronous specialization used by the local SQLite service. */
export interface SynchronousScheduledTaskRepository extends ScheduledTaskRepository {
  createTask(task: ScheduledTask, revision: ScheduledTaskRevision): void
  createRevision(task: ScheduledTask, revision: ScheduledTaskRevision): void
  activateGrant(
    task: ScheduledTask,
    reviewedRevision: ScheduledTaskRevision,
    grant: ScheduledTaskGrant,
  ): void
  saveTask(task: ScheduledTask): void
  getTask(taskId: string): ScheduledTask | null
  getRevision(revisionId: string): ScheduledTaskRevision | null
  getGrant(grantId: string): ScheduledTaskGrant | null
  revokeGrant(
    grantId: string,
    revokedAt: number,
    reason: string,
    revokedBy: string,
  ): ScheduledTaskGrant
  getDetail(taskId: string, runLimit?: number): ScheduledTaskDetail | null
  listTasks(scope: ScheduledTaskRepositoryFilter): ScheduledTaskListItem[]
  listDueTasks(now: number, scope?: ScheduledTaskRepositoryFilter): ScheduledTask[]
  nextDueAt(scope?: ScheduledTaskRepositoryFilter): number | null
  claimOccurrence(
    occurrence: ScheduledTaskOccurrenceRecord,
    claimedRun: ScheduledTaskRun,
    overlapRun: ScheduledTaskRun,
    taskAfterClaim?: ScheduledTask,
  ): ScheduledTaskClaimResult
  saveRun(run: ScheduledTaskRun): void
  getRun(runId: string): ScheduledTaskRun | null
  listRuns(taskId: string, limit?: number): ScheduledTaskRun[]
  listInterruptedRuns(): ScheduledTaskRun[]
  createAttempt(attempt: ScheduledTaskAttempt): void
  saveAttempt(attempt: ScheduledTaskAttempt): void
  listAttempts(runId: string): ScheduledTaskAttempt[]
  close(): void
}

export interface ScheduledTaskWakeCapabilities {
  supported: boolean
  strategy: "dynamic-next-wake" | "fixed-poll" | "external"
  minimumIntervalMs: number | null
}

export interface ScheduledTaskWakeAdapter {
  capabilities(): Promise<ScheduledTaskWakeCapabilities>
  reconcile(input: { nextDueAt: number | null }): Promise<void>
  stop(): Promise<void>
}

export interface ScheduledTaskExecutionOptions {
  signal: AbortSignal
  onEvent?: (event: ScheduledTaskExecutionEvent) => void | Promise<void>
}

export type ScheduledTaskCancellationReason =
  | "user"
  | "timeout"
  | "shutdown"
  | "grant-revoked"
  | "workspace-removed"
  | "capability-lost"

export interface ScheduledTaskCancellationRequest {
  runId: string
  attemptId: string
  sessionId: string
  reason: ScheduledTaskCancellationReason
}

export type ScheduledTaskCancellationResult =
  | { status: "cancelled"; sessionId: string }
  | { status: "not-running"; sessionId: string }
  | {
      status: "unsupported"
      sessionId: string
      error: ScheduledTaskTypedError
    }
  | {
      status: "ambiguous"
      sessionId: string
      error: ScheduledTaskTypedError
    }

export interface ScheduledTaskExecutionAdapter {
  execute(
    request: ScheduledTaskExecutionRequest,
    options: ScheduledTaskExecutionOptions,
  ): Promise<ScheduledTaskExecutionResult>
  cancel(
    request: ScheduledTaskCancellationRequest,
  ): Promise<ScheduledTaskCancellationResult>
}

export interface ScheduledTaskAuthorityValidation {
  phase: "review" | "enable" | "execute"
  task: ScheduledTask
  revision: ScheduledTaskRevision
  grant: ScheduledTaskGrant | null
  now: number
}

export type ScheduledTaskAuthorityValidator = (
  input: ScheduledTaskAuthorityValidation,
) => void | Promise<void>

export type ScheduledTaskAuthorityValidationResult =
  | {
      ok: true
      capabilityReferences: ScheduledTaskCapabilityReference[]
    }
  | { ok: false; error: ScheduledTaskTypedError }

export interface ScheduledTaskAuthorityResolver {
  validate(input: {
    phase: "review" | "enable" | "execute"
    taskRevision: ScheduledTaskRevision
    grantRevision: ScheduledTaskGrant
    target: ScheduledTaskExecutionTarget
    principal: ScheduledTaskPlacement["executionPrincipal"]
    now: number
  }): Promise<ScheduledTaskAuthorityValidationResult>
}

export interface ScheduledTaskArtifactResolver {
  resolve(input: {
    run: ScheduledTaskRun
    placement: ScheduledTaskPlacement
    candidates: readonly string[]
  }): Promise<ScheduledTaskArtifactReference[]>
}

export type ScheduledTaskNotification =
  | { type: "run-terminal"; run: ScheduledTaskRun }
  | { type: "needs-attention"; task: ScheduledTask; run: ScheduledTaskRun | null }

export interface ScheduledTaskNotifier {
  notify(notification: ScheduledTaskNotification): Promise<void>
}

export interface ScheduledTaskRuntimeProfile {
  repository: ScheduledTaskRepository
  tick: ScheduledTaskTickPort
  wake: ScheduledTaskWakeAdapter
  execution: ScheduledTaskExecutionAdapter
  authority: ScheduledTaskAuthorityResolver
  artifacts: ScheduledTaskArtifactResolver
  notifications: ScheduledTaskNotifier
}
