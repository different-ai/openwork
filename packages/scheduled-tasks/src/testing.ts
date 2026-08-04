import {
  scheduledTaskAttemptSchema,
  scheduledTaskDefinitionSchema,
  scheduledTaskGrantSchema,
  scheduledTaskPlacementSchema,
  scheduledTaskRevisionSchema,
  scheduledTaskRunSchema,
  scheduledTaskSchema,
  type ScheduledTask,
  type ScheduledTaskAttempt,
  type ScheduledTaskGrant,
  type ScheduledTaskRevision,
  type ScheduledTaskRun,
} from "@openwork/types/scheduled-tasks"
import type { Awaitable, ScheduledTaskRepository } from "./ports.js"
import { scheduledTaskPlacementIdentity } from "./contracts.js"

export interface ScheduledTaskRepositoryConformanceOptions {
  createRepository(): Awaitable<ScheduledTaskRepository>
}

export interface ScheduledTaskRepositoryConformanceResult {
  checked: string[]
}

function invariant(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`ScheduledTaskRepository conformance: ${message}`)
}

function createFixtures() {
  const createdAt = 1_000
  const workspaceId = "ws_conformance"
  const placement = scheduledTaskPlacementSchema.parse({
    target: { kind: "local-workspace", workspaceId },
    schedulerOwner: "local-server",
    executionAvailability: "app-open",
    executionPrincipal: { kind: "local-user", identityId: "member_conformance" },
    capabilityReferences: [{
      id: "workspace.files.read",
      source: "openwork",
      actionClass: "read",
      reviewedVersion: "1",
      reviewedDigest: null,
    }],
  })
  const definition = scheduledTaskDefinitionSchema.parse({
    name: "Repository conformance",
    description: "Portable repository behavior",
    prompt: "Write a deterministic result.",
    workspaceId,
    placement,
    schedule: {
      kind: "daily",
      timezone: "UTC",
      hour: 9,
      minute: 0,
    },
    model: { providerId: null, modelId: null, agent: null },
    maximumRuntimeMs: 60_000,
    overlapPolicy: "skip",
    retryPolicy: { maximumAttempts: 1, delayMs: 0 },
    missedRunPolicy: {
      kind: "skip",
      graceMs: 60_000,
      maximumRecoverableOccurrences: 1,
    },
  })
  const revision1 = scheduledTaskRevisionSchema.parse({
    id: "rev_conformance_1",
    taskId: "task_conformance",
    revision: 1,
    definition,
    createdAt,
    createdBy: "member_conformance",
    reviewedAt: null,
    reviewedBy: null,
  })
  const task1 = scheduledTaskSchema.parse({
    id: revision1.taskId,
    workspaceId,
    state: "draft",
    enabled: false,
    draftRevisionId: revision1.id,
    activeRevisionId: null,
    activeGrantId: null,
    nextRunAt: null,
    needsAttention: null,
    createdAt,
    updatedAt: createdAt,
    deletedAt: null,
  })
  const revision2 = scheduledTaskRevisionSchema.parse({
    ...revision1,
    id: "rev_conformance_2",
    revision: 2,
    createdAt: createdAt + 1,
  })
  const task2 = scheduledTaskSchema.parse({
    ...task1,
    draftRevisionId: revision2.id,
    updatedAt: createdAt + 1,
  })
  const reviewedRevision = scheduledTaskRevisionSchema.parse({
    ...revision2,
    id: "rev_conformance_3",
    revision: 3,
    createdAt: createdAt + 2,
    reviewedAt: createdAt + 2,
    reviewedBy: "member_conformance",
  })
  const grant = scheduledTaskGrantSchema.parse({
    id: "grant_conformance_1",
    taskId: task1.id,
    revision: 1,
    taskRevisionId: reviewedRevision.id,
    workspaceId,
    placement,
    placementIdentity: scheduledTaskPlacementIdentity(placement),
    filesystemScope: {
      kind: "local-workspace-roots",
      roots: ["/conformance/workspace"],
    },
    authorizedWorkspaceRoots: ["/conformance/workspace"],
    capabilityIds: ["workspace.files.read"],
    actionClasses: ["read"],
    filesystem: { read: true, write: false },
    maximumRuntimeMs: definition.maximumRuntimeMs,
    model: definition.model,
    communicationPolicy: "deny",
    destructiveActionPolicy: "deny",
    selfModificationPolicy: "deny",
    grantor: "member_conformance",
    reviewedAt: createdAt + 2,
    expiresAt: null,
    revokedAt: null,
    revocationReason: null,
    createdAt: createdAt + 2,
  })
  const activeTask = scheduledTaskSchema.parse({
    ...task2,
    state: "enabled",
    enabled: true,
    draftRevisionId: reviewedRevision.id,
    activeRevisionId: reviewedRevision.id,
    activeGrantId: grant.id,
    nextRunAt: createdAt + 100,
    updatedAt: createdAt + 2,
  })
  return {
    createdAt,
    workspaceId,
    revision1,
    task1,
    revision2,
    task2,
    reviewedRevision,
    grant,
    activeTask,
    placement,
  }
}

function runFixture(input: {
  id: string
  occurrenceId: string
  idempotencyKey: string
  task: ScheduledTask
  revision: ScheduledTaskRevision
  grant: ScheduledTaskGrant
  claimedAt: number
  status?: ScheduledTaskRun["status"]
}): ScheduledTaskRun {
  return scheduledTaskRunSchema.parse({
    id: input.id,
    taskId: input.task.id,
    taskRevisionId: input.revision.id,
    grantRevisionId: input.grant.id,
    placement: input.grant.placement,
    occurrenceId: input.occurrenceId,
    trigger: "scheduled",
    status: input.status ?? "claimed",
    scheduledFor: input.claimedAt,
    claimedAt: input.claimedAt,
    startedAt: null,
    completedAt: input.status === "skipped-overlap" ? input.claimedAt : null,
    durationMs: input.status === "skipped-overlap" ? 0 : null,
    idempotencyKey: input.idempotencyKey,
    sessionId: null,
    attemptCount: 0,
    boundedUsage: { inputTokens: null, outputTokens: null, costMicros: null },
    error: null,
    needsAttention: null,
    artifacts: [],
    cancelRequestedAt: null,
    createdAt: input.claimedAt,
    updatedAt: input.claimedAt,
  })
}

function attemptFixture(run: ScheduledTaskRun): ScheduledTaskAttempt {
  return scheduledTaskAttemptSchema.parse({
    id: "attempt_conformance_1",
    runId: run.id,
    attempt: 1,
    status: "running",
    sessionId: "session_conformance_1",
    startedAt: run.claimedAt + 1,
    completedAt: null,
    error: null,
  })
}

/**
 * Framework-neutral adapter contract. SQLite and Den MySQL tests call this
 * same verifier with their own isolated repository factory.
 */
export async function verifyScheduledTaskRepositoryConformance(
  options: ScheduledTaskRepositoryConformanceOptions,
): Promise<ScheduledTaskRepositoryConformanceResult> {
  const repository = await options.createRepository()
  const checked: string[] = []
  const fixtures = createFixtures()
  try {
    await repository.createTask(fixtures.task1, fixtures.revision1)
    invariant(
      (await repository.getTask(fixtures.task1.id))?.draftRevisionId ===
        fixtures.revision1.id,
      "createTask must persist the task and initial revision atomically",
    )
    checked.push("task-and-initial-revision")

    await repository.createRevision(fixtures.task2, fixtures.revision2)
    invariant(
      (await repository.getRevision(fixtures.revision2.id))?.revision === 2,
      "createRevision must persist immutable revision history",
    )
    checked.push("immutable-revisions")

    await repository.activateGrant(
      fixtures.activeTask,
      fixtures.reviewedRevision,
      fixtures.grant,
    )
    const detail = await repository.getDetail(fixtures.activeTask.id)
    invariant(
      detail?.activeRevision?.id === fixtures.reviewedRevision.id &&
        detail.grant?.id === fixtures.grant.id,
      "activateGrant must atomically bind the reviewed revision and grant",
    )
    checked.push("reviewed-authority-binding")

    const due = await repository.listDueTasks(fixtures.createdAt + 100)
    invariant(
      due.map((task) => task.id).includes(fixtures.activeTask.id),
      "listDueTasks must return enabled due tasks",
    )
    invariant(
      (await repository.nextDueAt(fixtures.workspaceId)) ===
        fixtures.createdAt + 100,
      "nextDueAt must expose the earliest enabled occurrence",
    )
    invariant(
      (await repository.listTasks({
        kind: "target",
        target: fixtures.placement.target,
      })).some((item) => item.task.id === fixtures.activeTask.id),
      "target scopes must select tasks bound to that execution target",
    )
    invariant(
      (await repository.listTasks({
        kind: "scheduler-owner",
        schedulerOwner: "den",
        organizationId: "org_other",
      })).length === 0,
      "scheduler-owner scopes must not leak tasks from another runtime",
    )
    checked.push("due-selection")
    checked.push("runtime-scope-isolation")

    const run = runFixture({
      id: "run_conformance_1",
      occurrenceId: "occ_conformance_1",
      idempotencyKey: "scheduled:conformance:1",
      task: fixtures.activeTask,
      revision: fixtures.reviewedRevision,
      grant: fixtures.grant,
      claimedAt: fixtures.createdAt + 100,
    })
    const overlap = runFixture({
      id: "run_conformance_overlap_template",
      occurrenceId: run.occurrenceId,
      idempotencyKey: run.idempotencyKey,
      task: fixtures.activeTask,
      revision: fixtures.reviewedRevision,
      grant: fixtures.grant,
      claimedAt: run.claimedAt,
      status: "skipped-overlap",
    })
    const taskAfterClaim = scheduledTaskSchema.parse({
      ...fixtures.activeTask,
      nextRunAt: fixtures.createdAt + 200,
      updatedAt: fixtures.createdAt + 100,
    })
    const claimed = await repository.claimOccurrence(
      {
        id: run.occurrenceId,
        taskId: run.taskId,
        taskRevisionId: run.taskRevisionId,
        scheduledFor: run.scheduledFor,
        trigger: run.trigger,
        status: run.status,
        claimedAt: run.claimedAt,
      },
      run,
      overlap,
      taskAfterClaim,
    )
    invariant(claimed.kind === "claimed", "the first occurrence must be claimed")
    const duplicate = await repository.claimOccurrence(
      {
        id: run.occurrenceId,
        taskId: run.taskId,
        taskRevisionId: run.taskRevisionId,
        scheduledFor: run.scheduledFor,
        trigger: run.trigger,
        status: run.status,
        claimedAt: run.claimedAt,
      },
      runFixture({
        id: "run_conformance_duplicate",
        occurrenceId: run.occurrenceId,
        idempotencyKey: run.idempotencyKey,
        task: fixtures.activeTask,
        revision: fixtures.reviewedRevision,
        grant: fixtures.grant,
        claimedAt: run.claimedAt,
      }),
      overlap,
    )
    invariant(
      duplicate.kind === "duplicate" && duplicate.run.id === run.id,
      "claimOccurrence must return the original run for a duplicate identity",
    )
    checked.push("atomic-idempotent-claim")

    const secondRun = runFixture({
      id: "run_conformance_2",
      occurrenceId: "occ_conformance_2",
      idempotencyKey: "scheduled:conformance:2",
      task: taskAfterClaim,
      revision: fixtures.reviewedRevision,
      grant: fixtures.grant,
      claimedAt: fixtures.createdAt + 200,
    })
    const secondOverlap = runFixture({
      id: "run_conformance_overlap_2",
      occurrenceId: secondRun.occurrenceId,
      idempotencyKey: secondRun.idempotencyKey,
      task: taskAfterClaim,
      revision: fixtures.reviewedRevision,
      grant: fixtures.grant,
      claimedAt: secondRun.claimedAt,
      status: "skipped-overlap",
    })
    const overlapResult = await repository.claimOccurrence(
      {
        id: secondRun.occurrenceId,
        taskId: secondRun.taskId,
        taskRevisionId: secondRun.taskRevisionId,
        scheduledFor: secondRun.scheduledFor,
        trigger: secondRun.trigger,
        status: secondRun.status,
        claimedAt: secondRun.claimedAt,
      },
      secondRun,
      secondOverlap,
    )
    invariant(
      overlapResult.kind === "overlap" &&
        overlapResult.run.status === "skipped-overlap",
      "an active run must make the next occurrence a durable overlap result",
    )
    checked.push("atomic-overlap-policy")

    const attempt = attemptFixture(run)
    await repository.createAttempt(attempt)
    invariant(
      (await repository.listAttempts(run.id))[0]?.id === attempt.id,
      "attempts must be listed in attempt order",
    )
    await repository.saveAttempt(
      scheduledTaskAttemptSchema.parse({
        ...attempt,
        status: "completed",
        completedAt: fixtures.createdAt + 150,
      }),
    )
    checked.push("attempt-ledger")

    const completedRun = scheduledTaskRunSchema.parse({
      ...run,
      status: "completed",
      completedAt: fixtures.createdAt + 150,
      durationMs: 50,
      attemptCount: 1,
      updatedAt: fixtures.createdAt + 150,
    })
    await repository.saveRun(completedRun)
    invariant(
      (await repository.getRun(run.id))?.status === "completed",
      "saveRun must durably update a claimed run",
    )
    invariant(
      (await repository.listInterruptedRuns()).every(
        (interrupted) => interrupted.id !== run.id,
      ),
      "terminal runs must not be returned as interrupted",
    )
    checked.push("durable-terminal-run")

    const revoked = await repository.revokeGrant(
      fixtures.grant.id,
      fixtures.createdAt + 300,
      "conformance revocation",
      "member_conformance",
    )
    invariant(
      revoked.revokedAt === fixtures.createdAt + 300 &&
        (await repository.getGrant(fixtures.grant.id))?.revokedAt ===
          fixtures.createdAt + 300,
      "grant revocation must be durable and observable",
    )
    checked.push("grant-revocation")

    return { checked }
  } finally {
    await repository.close()
  }
}
