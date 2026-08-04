import {
  createScheduledTaskDraftSchema,
  createLocalScheduledTaskPlacement,
  isTerminalScheduledTaskRunStatus,
  nextScheduledTaskOccurrence,
  previewScheduledTaskSchedule,
  reviewScheduledTaskGrantSchema,
  scheduledTaskOccurrenceIdentity,
  scheduledTaskAttemptSchema,
  scheduledTaskExecutionResultSchema,
  scheduledTaskGrantSchema,
  scheduledTaskPlacementIdentity,
  scheduledTaskRevisionSchema,
  scheduledTaskRunSchema,
  scheduledTaskSchema,
  selectScheduledTasksForTick,
  updateScheduledTaskDraftSchema,
  type CreateScheduledTaskDraft,
  type ReviewScheduledTaskGrant,
  type ScheduledTask,
  type ScheduledTaskAttempt,
  type ScheduledTaskAuthorityValidation,
  type ScheduledTaskAuthorityValidator,
  type ScheduledTaskCancellationReason,
  type ScheduledTaskCancellationRequest,
  type ScheduledTaskCapabilityReference,
  type ScheduledTaskClaimResult,
  type ScheduledTaskDefinition,
  type ScheduledTaskDetail,
  type ScheduledTaskExecutionAdapter,
  type ScheduledTaskExecutionEvent,
  type ScheduledTaskExecutionResult,
  type ScheduledTaskGrant,
  type ScheduledTaskListItem,
  type ScheduledTaskNeedsAttention,
  type ScheduledTaskPlacement,
  type ScheduledTaskRevision,
  type ScheduledTaskRun,
  type ScheduledTaskRunReceipt,
  type ScheduledTaskSchedule,
  type ScheduledTaskTickInput,
  type ScheduledTaskTickResult,
  type ScheduledTaskTypedError,
  type SynchronousScheduledTaskRepository,
  type UpdateScheduledTaskDraft,
} from "@openwork/scheduled-tasks";
import { ApiError } from "../errors.js";

const EMPTY_USAGE = {
  inputTokens: null,
  outputTokens: null,
  costMicros: null,
} as const;

type CancellationReason = ScheduledTaskCancellationReason;

interface LiveExecution {
  controller: AbortController;
  attemptId: string;
  sessionId: string | null;
  reason: CancellationReason;
}

export type {
  ScheduledTaskAuthorityValidation,
  ScheduledTaskAuthorityValidator,
  ScheduledTaskTickResult,
} from "@openwork/scheduled-tasks";

export interface CreateScheduledTaskServiceOptions {
  store: SynchronousScheduledTaskRepository;
  execution: ScheduledTaskExecutionAdapter;
  validateAuthority?: ScheduledTaskAuthorityValidator;
  clock?: () => number;
  id?: (prefix: "task" | "rev" | "grant" | "run" | "attempt") => string;
  scheduleExecutionTimeout?: (
    onTimeout: () => void,
    durationMs: number,
  ) => () => void;
}

export interface ScheduledTaskService {
  list(workspaceId: string): ScheduledTaskListItem[];
  get(workspaceId: string, taskId: string): ScheduledTaskDetail;
  createDraft(input: CreateScheduledTaskDraft, actorId: string): ScheduledTaskListItem;
  updateDraft(
    workspaceId: string,
    taskId: string,
    input: UpdateScheduledTaskDraft,
    actorId: string,
  ): { task: ScheduledTask; revision: ScheduledTaskRevision };
  duplicate(
    workspaceId: string,
    taskId: string,
    actorId: string,
    name?: string,
  ): { task: ScheduledTask; revision: ScheduledTaskRevision };
  preview(schedule: ScheduledTaskSchedule, after?: number): ReturnType<typeof previewScheduledTaskSchedule>;
  review(
    workspaceId: string,
    taskId: string,
    input: ReviewScheduledTaskGrant,
    actorId: string,
  ): Promise<{ task: ScheduledTask; revision: ScheduledTaskRevision; grant: ScheduledTaskGrant }>;
  enable(workspaceId: string, taskId: string): Promise<ScheduledTask>;
  pause(workspaceId: string, taskId: string): ScheduledTask;
  resume(workspaceId: string, taskId: string): Promise<ScheduledTask>;
  revokeGrant(
    workspaceId: string,
    taskId: string,
    reason: string,
    actorId: string,
  ): Promise<{ task: ScheduledTask; grant: ScheduledTaskGrant }>;
  markWorkspaceUnavailable(
    workspaceId: string,
  ): Promise<{ taskIds: string[]; runIds: string[] }>;
  delete(workspaceId: string, taskId: string): Promise<ScheduledTask>;
  runOnce(workspaceId: string, taskId: string): Promise<ScheduledTaskRun>;
  listRuns(workspaceId: string, taskId: string, limit?: number): ScheduledTaskRun[];
  getRunReceipt(workspaceId: string, taskId: string, runId: string): ScheduledTaskRunReceipt;
  cancelRun(workspaceId: string, taskId: string, runId: string): Promise<ScheduledTaskRun>;
  recoverInterruptedRuns(): { runIds: string[] };
  tick(input: ScheduledTaskTickInput): Promise<ScheduledTaskTickResult>;
  stop(reason?: CancellationReason): Promise<void>;
}

function defaultId(prefix: "task" | "rev" | "grant" | "run" | "attempt"): string {
  return `${prefix}_${crypto.randomUUID()}`;
}

function requireTask(store: SynchronousScheduledTaskRepository, workspaceId: string, taskId: string): ScheduledTask {
  const task = store.getTask(taskId);
  if (!task || task.workspaceId !== workspaceId || task.deletedAt !== null) {
    throw new ApiError(404, "scheduled_task_not_found", "Scheduled task not found");
  }
  return task;
}

function requireRevision(store: SynchronousScheduledTaskRepository, revisionId: string): ScheduledTaskRevision {
  const revision = store.getRevision(revisionId);
  if (!revision) {
    throw new ApiError(409, "scheduled_task_revision_missing", "Scheduled task revision is missing");
  }
  return revision;
}

function requireGrant(store: SynchronousScheduledTaskRepository, grantId: string | null): ScheduledTaskGrant {
  const grant = grantId ? store.getGrant(grantId) : null;
  if (!grant) {
    throw new ApiError(409, "scheduled_task_grant_missing", "Review and grant this revision before enabling or running it");
  }
  return grant;
}

function validateGrant(
  task: ScheduledTask,
  revision: ScheduledTaskRevision,
  grant: ScheduledTaskGrant,
  now: number,
): void {
  if (
    task.activeRevisionId !== revision.id
    || task.activeGrantId !== grant.id
    || grant.taskRevisionId !== revision.id
    || grant.taskId !== task.id
    || grant.workspaceId !== task.workspaceId
    || revision.definition.workspaceId !== task.workspaceId
  ) {
    throw new ApiError(409, "scheduled_task_stale_grant", "The active grant does not match the active revision");
  }
  const placement = grant.placement ?? revision.definition.placement;
  if (
    placement
    && grant.placementIdentity
    && grant.placementIdentity !== scheduledTaskPlacementIdentity(placement)
  ) {
    throw new ApiError(
      409,
      "scheduled_task_stale_placement",
      "The reviewed placement no longer matches the active grant",
    );
  }
  if (grant.revokedAt !== null) {
    throw new ApiError(409, "scheduled_task_grant_revoked", "The active scheduled-task grant was revoked");
  }
  if (grant.expiresAt !== null && grant.expiresAt <= now) {
    throw new ApiError(409, "scheduled_task_grant_expired", "The active scheduled-task grant has expired");
  }
  if (
    grant.communicationPolicy !== "deny"
    || grant.destructiveActionPolicy !== "deny"
    || grant.selfModificationPolicy !== "deny"
  ) {
    throw new ApiError(409, "scheduled_task_invalid_grant", "Unattended grants must deny communication, destructive actions, and self-modification");
  }
  if (revision.definition.maximumRuntimeMs > grant.maximumRuntimeMs) {
    throw new ApiError(409, "scheduled_task_invalid_grant", "The active revision exceeds its reviewed maximum runtime");
  }
  const definitionModel = revision.definition.model;
  if (
    definitionModel.providerId !== grant.model.providerId
    || definitionModel.modelId !== grant.model.modelId
    || definitionModel.agent !== grant.model.agent
  ) {
    throw new ApiError(409, "scheduled_task_invalid_grant", "The reviewed model must match the task revision");
  }
  if (
    (grant.filesystem.read && !grant.actionClasses.includes("read"))
    || (grant.filesystem.write && !grant.actionClasses.includes("write"))
  ) {
    throw new ApiError(409, "scheduled_task_invalid_grant", "Filesystem access exceeds the reviewed action classes");
  }
}

function localCapabilityReferences(
  capabilityIds: readonly string[],
): ScheduledTaskCapabilityReference[] {
  return capabilityIds.map((id) => ({
    id,
    source: "openwork",
    actionClass: id.endsWith(".read")
      ? "read"
      : id.endsWith(".write")
        ? "write"
        : "execute",
    reviewedVersion: "1",
    reviewedDigest: null,
  }));
}

function localPlacement(input: {
  workspaceId: string;
  identityId: string;
  capabilityIds?: readonly string[];
  existing?: ScheduledTaskPlacement;
}): ScheduledTaskPlacement {
  if (input.existing?.target.kind === "den-worker") return input.existing;
  return createLocalScheduledTaskPlacement({
    workspaceId: input.workspaceId,
    identityId: input.identityId,
    executionAvailability: input.existing?.executionAvailability === "background-device"
      ? "background-device"
      : "app-open",
    capabilityReferences: localCapabilityReferences(input.capabilityIds ?? []),
  });
}

function grantError(error: unknown): ScheduledTaskTypedError {
  if (error instanceof ApiError) {
    const code: ScheduledTaskTypedError["code"] =
      error.code.includes("expired") ? "grant-expired"
        : error.code.includes("revoked") ? "grant-revoked"
          : error.code.includes("workspace") ? "workspace-inaccessible"
            : "invalid-grant";
    return {
      code,
      message: error.message,
      retryable: false,
      ambiguous: false,
      details: { apiCode: error.code },
    };
  }
  return {
    code: "internal-error",
    message: error instanceof Error ? error.message : "Scheduled task execution failed",
    retryable: true,
    ambiguous: false,
  };
}

function attentionForError(
  error: ScheduledTaskTypedError,
  run: ScheduledTaskRun,
  now: number,
): ScheduledTaskNeedsAttention | null {
  const mapping: Partial<Record<ScheduledTaskTypedError["code"], ScheduledTaskNeedsAttention["code"]>> = {
    "permission-required": "approval-required",
    "question-required": "question-required",
    "capability-unavailable": "capability-lost",
    "credential-unavailable": "credential-unavailable",
    "grant-expired": "grant-expired",
    "grant-revoked": "grant-revoked",
    "workspace-inaccessible": "workspace-inaccessible",
    "workspace-removed": "workspace-removed",
    "signed-out": "signed-out",
    "invalid-revision": "stale-revision",
    "invalid-grant": "stale-revision",
    "adapter-unavailable": "capability-lost",
  };
  const code = mapping[error.code];
  if (!code) return null;
  return {
    code,
    message: error.message,
    repairable: true,
    runId: run.id,
    sessionId: run.sessionId,
    createdAt: now,
  };
}

function runBase(input: {
  id: string;
  task: ScheduledTask;
  revision: ScheduledTaskRevision;
  grant: ScheduledTaskGrant;
  occurrenceId: string;
  trigger: ScheduledTaskRun["trigger"];
  scheduledFor: number | null;
  idempotencyKey: string;
  now: number;
  status?: ScheduledTaskRun["status"];
}): ScheduledTaskRun {
  const terminal = input.status && isTerminalScheduledTaskRunStatus(input.status);
  return scheduledTaskRunSchema.parse({
    id: input.id,
    taskId: input.task.id,
    taskRevisionId: input.revision.id,
    grantRevisionId: input.grant.id,
    placement: input.grant.placement
      ?? input.revision.definition.placement
      ?? localPlacement({
        workspaceId: input.revision.definition.workspaceId,
        identityId: input.grant.grantor,
        capabilityIds: input.grant.capabilityIds,
      }),
    occurrenceId: input.occurrenceId,
    trigger: input.trigger,
    status: input.status ?? "claimed",
    scheduledFor: input.scheduledFor,
    claimedAt: input.now,
    startedAt: null,
    completedAt: terminal ? input.now : null,
    durationMs: terminal ? 0 : null,
    idempotencyKey: input.idempotencyKey,
    sessionId: null,
    attemptCount: 0,
    boundedUsage: EMPTY_USAGE,
    error: null,
    needsAttention: null,
    artifacts: [],
    cancelRequestedAt: null,
    createdAt: input.now,
    updatedAt: input.now,
  });
}

function waitForDelay(delayMs: number, signal: AbortSignal): Promise<void> {
  if (delayMs <= 0 || signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(done, delayMs);
    function done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });
}

function validateDefinitionSchedule(definition: ScheduledTaskDefinition, timestamp: number): void {
  try {
    previewScheduledTaskSchedule(definition.schedule, {
      after: timestamp,
      generatedAt: timestamp,
    });
  } catch (error) {
    if (error instanceof RangeError) {
      throw new ApiError(400, "invalid_scheduled_task_timezone", error.message);
    }
    throw error;
  }
}

export function createScheduledTaskService(
  options: CreateScheduledTaskServiceOptions,
): ScheduledTaskService {
  const { store, execution } = options;
  const now = options.clock ?? Date.now;
  const makeId = options.id ?? defaultId;
  const scheduleExecutionTimeout = options.scheduleExecutionTimeout
    ?? ((onTimeout: () => void, durationMs: number) => {
      const timer = setTimeout(onTimeout, durationMs);
      return () => clearTimeout(timer);
    });
  const live = new Map<string, LiveExecution>();
  const inFlight = new Set<Promise<void>>();

  async function validateAuthority(input: ScheduledTaskAuthorityValidation): Promise<void> {
    if (input.grant) validateGrant(input.task, input.revision, input.grant, input.now);
    await options.validateAuthority?.(input);
  }

  function activeAuthority(task: ScheduledTask): {
    revision: ScheduledTaskRevision;
    grant: ScheduledTaskGrant;
  } {
    if (!task.activeRevisionId) {
      throw new ApiError(409, "scheduled_task_not_reviewed", "Review this scheduled task before enabling or running it");
    }
    const revision = requireRevision(store, task.activeRevisionId);
    const grant = requireGrant(store, task.activeGrantId);
    validateGrant(task, revision, grant, now());
    return { revision, grant };
  }

  function nextRevisionNumber(taskId: string): number {
    const detail = store.getDetail(taskId, 1);
    if (!detail) return 1;
    return Math.max(
      detail.draftRevision.revision,
      detail.activeRevision?.revision ?? 0,
    ) + 1;
  }

  function nextGrantNumber(task: ScheduledTask): number {
    return task.activeGrantId
      ? (store.getGrant(task.activeGrantId)?.revision ?? 0) + 1
      : 1;
  }

  function setTaskAttention(
    task: ScheduledTask,
    attention: ScheduledTaskNeedsAttention,
    timestamp = now(),
  ): void {
    store.saveTask(scheduledTaskSchema.parse({
      ...task,
      state: "needs-attention",
      enabled: false,
      nextRunAt: null,
      needsAttention: attention,
      updatedAt: timestamp,
    }));
  }

  async function handleExecutionEvent(
    runId: string,
    attemptId: string,
    event: ScheduledTaskExecutionEvent,
  ): Promise<void> {
    const run = store.getRun(runId);
    if (!run || isTerminalScheduledTaskRunStatus(run.status)) return;
    const attempt = store.listAttempts(runId).find((item) => item.id === attemptId);
    const sessionId = "sessionId" in event ? event.sessionId : run.sessionId;
    const timestamp = Math.max(now(), event.at);
    const nextRun = scheduledTaskRunSchema.parse({
      ...run,
      status: event.type === "needs-attention" ? "needs-attention" : "running",
      sessionId,
      needsAttention: event.type === "needs-attention" ? event.attention : run.needsAttention,
      updatedAt: timestamp,
    });
    store.saveRun(nextRun);
    if (event.type === "needs-attention") {
      const task = store.getTask(run.taskId);
      if (task && task.deletedAt === null) setTaskAttention(task, event.attention, timestamp);
    }
    const liveRun = live.get(runId);
    if (liveRun && sessionId) liveRun.sessionId = sessionId;
    if (attempt) {
      store.saveAttempt(scheduledTaskAttemptSchema.parse({
        ...attempt,
        status: event.type === "needs-attention" ? "needs-attention" : "running",
        sessionId,
        error: null,
      }));
    }
  }

  async function finalizeResult(
    run: ScheduledTaskRun,
    attempt: ScheduledTaskAttempt,
    resultInput: ScheduledTaskExecutionResult,
  ): Promise<{ run: ScheduledTaskRun; retry: boolean }> {
    const result = scheduledTaskExecutionResultSchema.parse(resultInput);
    const timestamp = now();
    if (result.status === "completed") {
      const completedRun = scheduledTaskRunSchema.parse({
        ...run,
        status: "completed",
        sessionId: result.sessionId,
        completedAt: timestamp,
        durationMs: Math.max(0, timestamp - (run.startedAt ?? run.claimedAt)),
        boundedUsage: result.boundedUsage,
        artifacts: result.artifacts.slice(0, 200),
        error: null,
        needsAttention: null,
        updatedAt: timestamp,
      });
      store.saveAttempt(scheduledTaskAttemptSchema.parse({
        ...attempt,
        status: "completed",
        sessionId: result.sessionId,
        completedAt: timestamp,
        error: null,
      }));
      store.saveRun(completedRun);
      const task = store.getTask(run.taskId);
      if (
        run.trigger === "recovery"
        && task?.needsAttention?.code === "missed-occurrence"
        && task.deletedAt === null
      ) {
        store.saveTask(scheduledTaskSchema.parse({
          ...task,
          state: "paused",
          enabled: false,
          nextRunAt: null,
          needsAttention: null,
          updatedAt: timestamp,
        }));
      }
      return { run: completedRun, retry: false };
    }

    if (result.status === "needs-attention") {
      const attentionRun = scheduledTaskRunSchema.parse({
        ...run,
        status: "needs-attention",
        sessionId: result.sessionId,
        completedAt: timestamp,
        durationMs: Math.max(0, timestamp - (run.startedAt ?? run.claimedAt)),
        needsAttention: result.attention,
        updatedAt: timestamp,
      });
      store.saveAttempt(scheduledTaskAttemptSchema.parse({
        ...attempt,
        status: "needs-attention",
        sessionId: result.sessionId,
        completedAt: timestamp,
        error: null,
      }));
      store.saveRun(attentionRun);
      const task = store.getTask(run.taskId);
      if (task) setTaskAttention(task, result.attention);
      return { run: attentionRun, retry: false };
    }

    const retry = result.status === "failed" && result.error.retryable;
    const failedRun = scheduledTaskRunSchema.parse({
      ...run,
      status: result.status,
      sessionId: result.sessionId,
      completedAt: retry ? null : timestamp,
      durationMs: retry ? null : Math.max(0, timestamp - (run.startedAt ?? run.claimedAt)),
      error: result.error,
      updatedAt: timestamp,
    });
    store.saveAttempt(scheduledTaskAttemptSchema.parse({
      ...attempt,
      status: result.error.code === "execution-timed-out" ? "timed-out" : result.status,
      sessionId: result.sessionId,
      completedAt: timestamp,
      error: result.error,
    }));
    store.saveRun(failedRun);
    return { run: failedRun, retry };
  }

  async function executeClaim(initialRun: ScheduledTaskRun): Promise<void> {
    let run = initialRun;
    try {
      const task = requireTask(store, requireRevision(store, run.taskRevisionId).definition.workspaceId, run.taskId);
      const revision = requireRevision(store, run.taskRevisionId);
      const grant = requireGrant(store, run.grantRevisionId);

      try {
        await validateAuthority({ phase: "execute", task, revision, grant, now: now() });
      } catch (error) {
        const typed = grantError(error);
        const attention = attentionForError(typed, run, now());
        const timestamp = now();
        run = scheduledTaskRunSchema.parse({
          ...run,
          status: attention ? "needs-attention" : "failed",
          completedAt: timestamp,
          durationMs: 0,
          error: typed,
          needsAttention: attention,
          updatedAt: timestamp,
        });
        store.saveRun(run);
        if (attention) setTaskAttention(task, attention);
        return;
      }

      const maximumAttempts = revision.definition.retryPolicy.maximumAttempts;
      for (let attemptNumber = 1; attemptNumber <= maximumAttempts; attemptNumber += 1) {
        const beforeAttempt = store.getRun(run.id) ?? run;
        if (beforeAttempt.cancelRequestedAt !== null) {
          const timestamp = now();
          store.saveRun(scheduledTaskRunSchema.parse({
            ...beforeAttempt,
            status: "cancelled",
            completedAt: timestamp,
            durationMs: Math.max(0, timestamp - (beforeAttempt.startedAt ?? beforeAttempt.claimedAt)),
            updatedAt: timestamp,
          }));
          return;
        }
        const startedAt = now();
        const attempt = scheduledTaskAttemptSchema.parse({
          id: makeId("attempt"),
          runId: run.id,
          attempt: attemptNumber,
          status: "starting",
          sessionId: null,
          startedAt,
          completedAt: null,
          error: null,
        });
        store.createAttempt(attempt);
        run = scheduledTaskRunSchema.parse({
          ...run,
          status: attemptNumber === 1 ? "running" : "retrying",
          startedAt: run.startedAt ?? startedAt,
          completedAt: null,
          durationMs: null,
          attemptCount: attemptNumber,
          error: null,
          updatedAt: startedAt,
        });
        store.saveRun(run);

        const controller = new AbortController();
        const running: LiveExecution = {
          controller,
          attemptId: attempt.id,
          sessionId: null,
          reason: "timeout",
        };
        live.set(run.id, running);
        const cancelTimeout = scheduleExecutionTimeout(() => {
          running.reason = "timeout";
          controller.abort();
        }, Math.min(revision.definition.maximumRuntimeMs, grant.maximumRuntimeMs));

        let result: ScheduledTaskExecutionResult;
        try {
          result = await execution.execute({
            runId: run.id,
            attemptId: attempt.id,
            idempotencyKey: `${run.idempotencyKey}:attempt:${attemptNumber}`,
            placement: run.placement,
            taskRevision: revision,
            grantRevision: grant,
          }, {
            signal: controller.signal,
            onEvent: (event) => handleExecutionEvent(run.id, attempt.id, event),
          });
          if (
            controller.signal.aborted
            && running.reason === "timeout"
            && result.status === "cancelled"
          ) {
            result = {
              status: "failed",
              sessionId: result.sessionId,
              error: {
                code: "execution-timed-out",
                message: "Scheduled task exceeded its maximum runtime",
                retryable: false,
                ambiguous: false,
              },
            };
          }
        } catch (error) {
          const aborted = controller.signal.aborted;
          result = {
            status: aborted && running.reason !== "timeout" ? "cancelled" : "failed",
            sessionId: running.sessionId,
            error: {
              code: aborted
                ? running.reason === "timeout" ? "execution-timed-out" : "execution-failed"
                : "internal-error",
              message: aborted
                ? running.reason === "timeout" ? "Scheduled task exceeded its maximum runtime" : "Scheduled task execution was cancelled"
                : error instanceof Error ? error.message : "Scheduled task adapter failed",
              retryable: !aborted,
              ambiguous: false,
            },
          };
        } finally {
          cancelTimeout();
          live.delete(run.id);
        }

        const currentRun = store.getRun(run.id) ?? run;
        const finalized = await finalizeResult(currentRun, attempt, result);
        run = finalized.run;
        if (!finalized.retry || attemptNumber >= maximumAttempts) {
          if (finalized.retry && attemptNumber >= maximumAttempts) {
            const timestamp = now();
            run = scheduledTaskRunSchema.parse({
              ...run,
              status: "failed",
              completedAt: timestamp,
              durationMs: Math.max(0, timestamp - (run.startedAt ?? run.claimedAt)),
              updatedAt: timestamp,
            });
            store.saveRun(run);
          }
          const attention = run.error ? attentionForError(run.error, run, now()) : null;
          if (attention) {
            const attentionRun = scheduledTaskRunSchema.parse({
              ...run,
              status: "needs-attention",
              needsAttention: attention,
              updatedAt: now(),
            });
            store.saveRun(attentionRun);
            setTaskAttention(task, attention);
          }
          return;
        }
        run = scheduledTaskRunSchema.parse({
          ...run,
          status: "retrying",
          completedAt: null,
          durationMs: null,
          updatedAt: now(),
        });
        store.saveRun(run);
        const retryController = new AbortController();
        const retryExecution: LiveExecution = {
          controller: retryController,
          attemptId: attempt.id,
          sessionId: run.sessionId,
          reason: "shutdown",
        };
        live.set(run.id, retryExecution);
        await waitForDelay(revision.definition.retryPolicy.delayMs, retryController.signal);
        live.delete(run.id);
        if (retryController.signal.aborted) {
          const timestamp = now();
          const interrupted = store.getRun(run.id) ?? run;
          store.saveRun(scheduledTaskRunSchema.parse({
            ...interrupted,
            status: "cancelled",
            completedAt: timestamp,
            durationMs: Math.max(0, timestamp - (interrupted.startedAt ?? interrupted.claimedAt)),
            updatedAt: timestamp,
          }));
          return;
        }
      }
    } catch (error) {
      const timestamp = now();
      const current = store.getRun(initialRun.id) ?? initialRun;
      if (isTerminalScheduledTaskRunStatus(current.status)) return;
      store.saveRun(scheduledTaskRunSchema.parse({
        ...current,
        status: "failed",
        completedAt: timestamp,
        durationMs: Math.max(0, timestamp - (current.startedAt ?? current.claimedAt)),
        error: grantError(error),
        updatedAt: timestamp,
      }));
    }
  }

  function trackExecution(run: ScheduledTaskRun): Promise<void> {
    const promise = executeClaim(run)
      .catch(() => undefined)
      .finally(() => inFlight.delete(promise));
    inFlight.add(promise);
    return promise;
  }

  function claim(
    task: ScheduledTask,
    revision: ScheduledTaskRevision,
    grant: ScheduledTaskGrant,
    trigger: ScheduledTaskRun["trigger"],
    scheduledFor: number | null,
    timestamp: number,
    taskAfterClaim?: ScheduledTask,
  ): ScheduledTaskClaimResult {
    const nonce = scheduledFor === null ? crypto.randomUUID() : undefined;
    const identity = scheduledTaskOccurrenceIdentity({
      taskId: task.id,
      taskRevisionId: revision.id,
      trigger,
      scheduledFor,
      nonce,
    });
    const claimedRun = runBase({
      id: makeId("run"),
      task,
      revision,
      grant,
      occurrenceId: identity.occurrenceId,
      trigger,
      scheduledFor,
      idempotencyKey: identity.idempotencyKey,
      now: timestamp,
    });
    const overlapRun = runBase({
      id: makeId("run"),
      task,
      revision,
      grant,
      occurrenceId: identity.occurrenceId,
      trigger,
      scheduledFor,
      idempotencyKey: identity.idempotencyKey,
      now: timestamp,
      status: "skipped-overlap",
    });
    return store.claimOccurrence({
      id: identity.occurrenceId,
      taskId: task.id,
      taskRevisionId: revision.id,
      scheduledFor,
      trigger,
      status: "claimed",
      claimedAt: timestamp,
    }, claimedRun, overlapRun, taskAfterClaim);
  }

  async function setEnabled(
    workspaceId: string,
    taskId: string,
    phase: "enable" | "resume",
  ): Promise<ScheduledTask> {
    const task = requireTask(store, workspaceId, taskId);
    const { revision, grant } = activeAuthority(task);
    if (revision.definition.schedule.kind === "manual") {
      throw new ApiError(
        409,
        "scheduled_task_manual_only",
        "Manual Scheduled Tasks run only with Run once",
      );
    }
    await validateAuthority({ phase: "enable", task, revision, grant, now: now() });
    const timestamp = now();
    const updated = scheduledTaskSchema.parse({
      ...task,
      state: "enabled",
      enabled: true,
      nextRunAt: nextScheduledTaskOccurrence(revision.definition.schedule, timestamp),
      needsAttention: null,
      updatedAt: timestamp,
    });
    store.saveTask(updated);
    void phase;
    return updated;
  }

  async function cancelRunForReason(
    workspaceId: string,
    taskId: string,
    runId: string,
    reason: CancellationReason,
  ): Promise<ScheduledTaskRun> {
    requireTask(store, workspaceId, taskId);
    let run = store.getRun(runId);
    if (!run || run.taskId !== taskId) {
      throw new ApiError(404, "scheduled_task_run_not_found", "Scheduled task run not found");
    }
    if (isTerminalScheduledTaskRunStatus(run.status)) return run;
    const timestamp = now();
    run = scheduledTaskRunSchema.parse({
      ...run,
      cancelRequestedAt: timestamp,
      updatedAt: timestamp,
    });
    store.saveRun(run);
    const running = live.get(runId);
    if (running) {
      running.reason = reason;
      // Once a session exists the adapter owns cancellation and reconciles its
      // single OpenCode abort result. Aborting the signal as well would race a
      // second abort (true/false) and could downgrade a confirmed cancellation
      // to an ambiguous outcome.
      if (!running.sessionId) running.controller.abort();
    }
    if (running && !running.sessionId) return store.getRun(runId) ?? run;
    const attempt = store.listAttempts(runId).at(-1);
    const sessionId = running?.sessionId ?? run.sessionId ?? attempt?.sessionId ?? null;
    if (!attempt || !sessionId) return store.getRun(runId) ?? run;
    const result = await execution.cancel({
      runId,
      attemptId: attempt.id,
      sessionId,
      reason,
    });
    const completedAt = now();
    const reconciled = store.getRun(runId);
    if (reconciled && isTerminalScheduledTaskRunStatus(reconciled.status)) return reconciled;
    if (result.status === "not-running") {
      const current = store.getRun(runId) ?? run;
      const error: ScheduledTaskTypedError = {
        code: "ambiguous-outcome",
        message: "The exact session is no longer running, but its terminal outcome could not be confirmed.",
        retryable: false,
        ambiguous: true,
      };
      const attention: ScheduledTaskNeedsAttention = {
        code: "approval-required",
        message: "Review the session outcome before resuming this schedule.",
        repairable: true,
        runId,
        sessionId: result.sessionId,
        createdAt: completedAt,
      };
      const ambiguous = scheduledTaskRunSchema.parse({
        ...current,
        status: "ambiguous",
        sessionId: result.sessionId,
        completedAt,
        durationMs: Math.max(0, completedAt - (current.startedAt ?? current.claimedAt)),
        error,
        needsAttention: attention,
        updatedAt: completedAt,
      });
      store.saveRun(ambiguous);
      const task = store.getTask(taskId);
      if (task && task.deletedAt === null && task.needsAttention === null) {
        setTaskAttention(task, attention, completedAt);
      }
      return ambiguous;
    }
    const cancellationError = "error" in result ? result.error : null;
    const cancellationAttention = cancellationError
      ? attentionForError(cancellationError, run, completedAt)
      : null;
    const terminal = scheduledTaskRunSchema.parse({
      ...(store.getRun(runId) ?? run),
      status: result.status === "cancelled" ? "cancelled" : "ambiguous",
      sessionId: result.sessionId,
      completedAt,
      durationMs: Math.max(0, completedAt - (run.startedAt ?? run.claimedAt)),
      error: cancellationError,
      needsAttention: cancellationAttention,
      updatedAt: completedAt,
    });
    store.saveRun(terminal);
    if (cancellationAttention) {
      const task = store.getTask(taskId);
      if (task && task.deletedAt === null && task.needsAttention === null) {
        setTaskAttention(task, cancellationAttention, completedAt);
      }
    }
    return terminal;
  }

  const service: ScheduledTaskService = {
    list(workspaceId) {
      return store.listTasks(workspaceId);
    },

    get(workspaceId, taskId) {
      requireTask(store, workspaceId, taskId);
      const detail = store.getDetail(taskId);
      if (!detail) throw new ApiError(404, "scheduled_task_not_found", "Scheduled task not found");
      return detail;
    },

    createDraft(input, actorId) {
      const parsedDefinition = createScheduledTaskDraftSchema.parse(input);
      const definition = createScheduledTaskDraftSchema.parse({
        ...parsedDefinition,
        placement: parsedDefinition.placement ?? localPlacement({
          workspaceId: parsedDefinition.workspaceId,
          identityId: actorId,
        }),
      });
      const timestamp = now();
      validateDefinitionSchedule(definition, timestamp);
      const taskId = makeId("task");
      const revision = scheduledTaskRevisionSchema.parse({
        id: makeId("rev"),
        taskId,
        revision: 1,
        definition,
        createdAt: timestamp,
        createdBy: actorId,
        reviewedAt: null,
        reviewedBy: null,
      });
      const task = scheduledTaskSchema.parse({
        id: taskId,
        workspaceId: definition.workspaceId,
        state: "draft",
        enabled: false,
        draftRevisionId: revision.id,
        activeRevisionId: null,
        activeGrantId: null,
        nextRunAt: null,
        needsAttention: null,
        createdAt: timestamp,
        updatedAt: timestamp,
        deletedAt: null,
      });
      store.createTask(task, revision);
      return { task, revision };
    },

    updateDraft(workspaceId, taskId, input, actorId) {
      const parsedInput = updateScheduledTaskDraftSchema.parse(input);
      const parsed = updateScheduledTaskDraftSchema.parse({
        ...parsedInput,
        definition: {
          ...parsedInput.definition,
          placement: parsedInput.definition.placement ?? localPlacement({
            workspaceId: parsedInput.definition.workspaceId,
            identityId: actorId,
          }),
        },
      });
      const task = requireTask(store, workspaceId, taskId);
      if (task.draftRevisionId !== parsed.expectedRevisionId) {
        throw new ApiError(409, "scheduled_task_revision_conflict", "The scheduled task was edited by another client");
      }
      if (parsed.definition.workspaceId !== workspaceId) {
        throw new ApiError(400, "scheduled_task_workspace_mismatch", "The definition workspace must match the route workspace");
      }
      const timestamp = now();
      validateDefinitionSchedule(parsed.definition, timestamp);
      const revision = scheduledTaskRevisionSchema.parse({
        id: makeId("rev"),
        taskId,
        revision: nextRevisionNumber(taskId),
        definition: parsed.definition,
        createdAt: timestamp,
        createdBy: actorId,
        reviewedAt: null,
        reviewedBy: null,
      });
      const updated = scheduledTaskSchema.parse({
        ...task,
        draftRevisionId: revision.id,
        updatedAt: timestamp,
      });
      store.createRevision(updated, revision);
      return { task: updated, revision };
    },

    duplicate(workspaceId, taskId, actorId, name) {
      const source = requireTask(store, workspaceId, taskId);
      const sourceRevision = requireRevision(store, source.draftRevisionId);
      return service.createDraft({
        ...sourceRevision.definition,
        name: name?.trim() || `${sourceRevision.definition.name} copy`,
      }, actorId);
    },

    preview(schedule, after) {
      try {
        return previewScheduledTaskSchedule(schedule, {
          after,
          generatedAt: now(),
        });
      } catch (error) {
        if (error instanceof RangeError) {
          throw new ApiError(400, "invalid_scheduled_task_timezone", error.message);
        }
        throw error;
      }
    },

    async review(workspaceId, taskId, input, actorId) {
      const parsed = reviewScheduledTaskGrantSchema.parse(input);
      const task = requireTask(store, workspaceId, taskId);
      if (task.draftRevisionId !== parsed.expectedRevisionId) {
        throw new ApiError(409, "scheduled_task_revision_conflict", "Review the latest scheduled-task revision");
      }
      const draft = requireRevision(store, task.draftRevisionId);
      if (draft.definition.workspaceId !== workspaceId) {
        throw new ApiError(409, "scheduled_task_workspace_mismatch", "The draft belongs to a different workspace");
      }
      const timestamp = now();
      validateDefinitionSchedule(draft.definition, timestamp);
      const revision = scheduledTaskRevisionSchema.parse({
        ...draft,
        id: makeId("rev"),
        revision: nextRevisionNumber(taskId),
        createdAt: timestamp,
        createdBy: actorId,
        reviewedAt: timestamp,
        reviewedBy: actorId,
      });
      const placement = localPlacement({
        workspaceId,
        identityId: actorId,
        capabilityIds: parsed.capabilityIds,
        existing: revision.definition.placement,
      });
      const grant = scheduledTaskGrantSchema.parse({
        id: makeId("grant"),
        taskId,
        revision: nextGrantNumber(task),
        taskRevisionId: revision.id,
        workspaceId,
        placement,
        placementIdentity: scheduledTaskPlacementIdentity(placement),
        filesystemScope: parsed.filesystemScope ?? {
          kind: "local-workspace-roots",
          roots: parsed.authorizedWorkspaceRoots,
        },
        authorizedWorkspaceRoots: parsed.authorizedWorkspaceRoots,
        capabilityIds: parsed.capabilityIds,
        actionClasses: parsed.actionClasses,
        filesystem: parsed.filesystem,
        maximumRuntimeMs: parsed.maximumRuntimeMs,
        model: parsed.model,
        communicationPolicy: "deny",
        destructiveActionPolicy: "deny",
        selfModificationPolicy: "deny",
        grantor: actorId,
        reviewedAt: timestamp,
        expiresAt: parsed.expiresAt,
        revokedAt: null,
        revocationReason: null,
        createdAt: timestamp,
      });
      const updated = scheduledTaskSchema.parse({
        ...task,
        state:
          task.state === "draft"
            ? "ready"
            : task.state === "needs-attention"
              ? "paused"
            : task.state,
        draftRevisionId: revision.id,
        activeRevisionId: revision.id,
        activeGrantId: grant.id,
        nextRunAt: task.enabled
          ? nextScheduledTaskOccurrence(revision.definition.schedule, timestamp)
          : null,
        needsAttention: null,
        updatedAt: timestamp,
      });
      await validateAuthority({ phase: "review", task: updated, revision, grant, now: timestamp });
      store.activateGrant(updated, revision, grant);
      return { task: updated, revision, grant };
    },

    enable(workspaceId, taskId) {
      return setEnabled(workspaceId, taskId, "enable");
    },

    pause(workspaceId, taskId) {
      const task = requireTask(store, workspaceId, taskId);
      const timestamp = now();
      const updated = scheduledTaskSchema.parse({
        ...task,
        state: "paused",
        enabled: false,
        nextRunAt: null,
        updatedAt: timestamp,
      });
      store.saveTask(updated);
      return updated;
    },

    resume(workspaceId, taskId) {
      return setEnabled(workspaceId, taskId, "resume");
    },

    async revokeGrant(workspaceId, taskId, reason, actorId) {
      const task = requireTask(store, workspaceId, taskId);
      const grant = requireGrant(store, task.activeGrantId);
      const timestamp = now();
      const revoked = store.revokeGrant(
        grant.id,
        timestamp,
        reason.trim() || "Revoked by owner",
        actorId,
      );
      const attention: ScheduledTaskNeedsAttention = {
        code: "grant-revoked",
        message: revoked.revocationReason ?? "The scheduled-task grant was revoked.",
        repairable: true,
        runId: null,
        sessionId: null,
        createdAt: timestamp,
      };
      setTaskAttention(task, attention, timestamp);
      const activeRuns = store.listRuns(taskId, 20).filter(
        (run) => !isTerminalScheduledTaskRunStatus(run.status),
      );
      await Promise.all(
        activeRuns.map((run) =>
          cancelRunForReason(workspaceId, taskId, run.id, "grant-revoked")
        ),
      );
      return { task: requireTask(store, workspaceId, taskId), grant: revoked };
    },

    async markWorkspaceUnavailable(workspaceId) {
      const timestamp = now();
      const taskIds: string[] = [];
      const activeRuns: ScheduledTaskRun[] = [];
      for (const item of store.listTasks(workspaceId)) {
        const attention: ScheduledTaskNeedsAttention = {
          code: "workspace-removed",
          message: "This scheduled task's workspace was removed from OpenWork.",
          repairable: true,
          runId: null,
          sessionId: null,
          createdAt: timestamp,
        };
        setTaskAttention(item.task, attention, timestamp);
        taskIds.push(item.task.id);
        activeRuns.push(
          ...store.listRuns(item.task.id, 20).filter(
            (run) => !isTerminalScheduledTaskRunStatus(run.status),
          ),
        );
      }
      await Promise.all(
        activeRuns.map((run) =>
          cancelRunForReason(workspaceId, run.taskId, run.id, "workspace-removed")
        ),
      );
      return {
        taskIds,
        runIds: activeRuns.map((run) => run.id),
      };
    },

    async delete(workspaceId, taskId) {
      const task = requireTask(store, workspaceId, taskId);
      const activeRuns = store.listRuns(taskId, 20).filter((run) => !isTerminalScheduledTaskRunStatus(run.status));
      await Promise.all(activeRuns.map((run) => service.cancelRun(workspaceId, taskId, run.id)));
      const timestamp = now();
      const deleted = scheduledTaskSchema.parse({
        ...task,
        state: "deleted",
        enabled: false,
        nextRunAt: null,
        deletedAt: timestamp,
        updatedAt: timestamp,
      });
      store.saveTask(deleted);
      return deleted;
    },

    async runOnce(workspaceId, taskId) {
      const task = requireTask(store, workspaceId, taskId);
      const { revision, grant } = activeAuthority(task);
      await validateAuthority({ phase: "execute", task, revision, grant, now: now() });
      const trigger = task.needsAttention?.code === "missed-occurrence"
        ? "recovery"
        : "manual";
      const result = claim(task, revision, grant, trigger, null, now());
      if (result.kind === "claimed") void trackExecution(result.run);
      return result.run;
    },

    listRuns(workspaceId, taskId, limit) {
      requireTask(store, workspaceId, taskId);
      return store.listRuns(taskId, limit);
    },

    getRunReceipt(workspaceId, taskId, runId) {
      requireTask(store, workspaceId, taskId);
      const run = store.getRun(runId);
      if (!run || run.taskId !== taskId) {
        throw new ApiError(404, "scheduled_task_run_not_found", "Scheduled task run not found");
      }
      const revision = requireRevision(store, run.taskRevisionId);
      const grant = requireGrant(store, run.grantRevisionId);
      return {
        run,
        taskRevision: revision,
        grantRevision: grant,
        placement: run.placement
          ?? grant.placement
          ?? revision.definition.placement
          ?? localPlacement({
            workspaceId,
            identityId: grant.grantor,
            capabilityIds: grant.capabilityIds,
          }),
        attempts: store.listAttempts(run.id),
        sessionRoute: run.sessionId
          ? `/workspace/${encodeURIComponent(workspaceId)}/session/${encodeURIComponent(run.sessionId)}`
          : null,
        artifacts: run.artifacts,
      };
    },

    async cancelRun(workspaceId, taskId, runId) {
      return cancelRunForReason(workspaceId, taskId, runId, "user");
    },

    recoverInterruptedRuns() {
      const timestamp = now();
      const recovered: string[] = [];
      for (const run of store.listInterruptedRuns()) {
        const error: ScheduledTaskTypedError = {
          code: "ambiguous-outcome",
          message: "OpenWork restarted before this run reached a durable terminal outcome.",
          retryable: false,
          ambiguous: true,
        };
        const attention: ScheduledTaskNeedsAttention = {
          code: "approval-required",
          message: "This run may still have changed the workspace. Review it before resuming the schedule.",
          repairable: true,
          runId: run.id,
          sessionId: run.sessionId,
          createdAt: timestamp,
        };
        store.saveRun(scheduledTaskRunSchema.parse({
          ...run,
          status: "ambiguous",
          completedAt: timestamp,
          durationMs: Math.max(0, timestamp - (run.startedAt ?? run.claimedAt)),
          error,
          needsAttention: attention,
          updatedAt: timestamp,
        }));
        for (const attempt of store.listAttempts(run.id)) {
          if (attempt.completedAt !== null) continue;
          store.saveAttempt(scheduledTaskAttemptSchema.parse({
            ...attempt,
            status: "ambiguous",
            completedAt: timestamp,
            error,
          }));
        }
        const task = store.getTask(run.taskId);
        if (task && task.deletedAt === null) setTaskAttention(task, attention, timestamp);
        recovered.push(run.id);
      }
      return { runIds: recovered };
    },

    async tick(input) {
      const processedAt = Math.floor(input.now);
      const scope = input.scope ?? input.workspaceId;
      const due = selectScheduledTasksForTick(
        store.listDueTasks(processedAt, scope),
        { ...input, now: processedAt },
      );
      const claimed: ScheduledTaskRun[] = [];
      for (const task of due) {
        let revision: ScheduledTaskRevision;
        let grant: ScheduledTaskGrant;
        try {
          ({ revision, grant } = activeAuthority(task));
        } catch (error) {
          const typed = grantError(error);
          const attention: ScheduledTaskNeedsAttention = {
            code: typed.code === "grant-expired" ? "grant-expired"
              : typed.code === "grant-revoked" ? "grant-revoked"
                : "stale-revision",
            message: typed.message,
            repairable: true,
            runId: null,
            sessionId: null,
            createdAt: processedAt,
          };
          setTaskAttention(task, attention, processedAt);
          continue;
        }
        const scheduledFor = task.nextRunAt;
        if (scheduledFor === null) continue;
        const definition = revision.definition;
        const nextRunAt = nextScheduledTaskOccurrence(definition.schedule, processedAt);
        const tooLate = processedAt - scheduledFor > definition.missedRunPolicy.graceMs;
        if (tooLate) {
          const pendingAttention: ScheduledTaskNeedsAttention = {
            code: "missed-occurrence",
            message: "A scheduled occurrence was missed while OpenWork was not running.",
            repairable: true,
            runId: null,
            sessionId: null,
            createdAt: processedAt,
          };
          const attentionTask = scheduledTaskSchema.parse({
            ...task,
            state: "needs-attention",
            enabled: false,
            nextRunAt: null,
            needsAttention: pendingAttention,
            updatedAt: processedAt,
          });
          const result = claim(
            task,
            revision,
            grant,
            "recovery",
            scheduledFor,
            processedAt,
            attentionTask,
          );
          const attention: ScheduledTaskNeedsAttention = {
            ...pendingAttention,
            runId: result.run.id,
          };
          const missed = scheduledTaskRunSchema.parse({
            ...result.run,
            status: result.kind === "overlap" ? "skipped-overlap" : "missed",
            completedAt: processedAt,
            durationMs: 0,
            needsAttention: attention,
            updatedAt: processedAt,
          });
          store.saveRun(missed);
          setTaskAttention(attentionTask, attention, processedAt);
          continue;
        }

        const updatedTask = scheduledTaskSchema.parse({
          ...task,
          nextRunAt,
          updatedAt: processedAt,
        });
        const result = claim(
          task,
          revision,
          grant,
          "scheduled",
          scheduledFor,
          processedAt,
          updatedTask,
        );
        if (result.kind === "claimed") claimed.push(result.run);
      }
      for (const run of claimed) void trackExecution(run);
      return {
        processedAt,
        source: input.source,
        selectedTaskIds: due.map((task) => task.id),
        claimedRunIds: claimed.map((run) => run.id),
        nextDueAt: store.nextDueAt(scope),
      };
    },

    async stop(reason = "shutdown") {
      const cancellations = [...live.entries()].map(async ([runId, running]) => {
        running.reason = reason;
        if (!running.sessionId) {
          running.controller.abort();
          return;
        }
        await execution.cancel({
          runId,
          attemptId: running.attemptId,
          sessionId: running.sessionId,
          reason,
        }).catch(() => undefined);
      });
      await Promise.all(cancellations);
      await Promise.allSettled([...inFlight]);
    },
  };
  service.recoverInterruptedRuns();
  return service;
}
