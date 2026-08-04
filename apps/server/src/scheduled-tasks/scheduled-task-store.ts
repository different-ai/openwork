import {
  scheduledTaskAttemptSchema,
  scheduledTaskGrantSchema,
  localWorkspaceIdForScheduledTaskScope,
  scheduledTaskRevisionSchema,
  scheduledTaskRunSchema,
  scheduledTaskSchema,
  type ScheduledTask,
  type ScheduledTaskAttempt,
  type ScheduledTaskGrant,
  type ScheduledTaskRevision,
  type ScheduledTaskRun,
  type ScheduledTaskClaimResult,
  type ScheduledTaskDetail,
  type ScheduledTaskListItem,
  type ScheduledTaskOccurrenceRecord,
  type ScheduledTaskRepositoryFilter,
  type SynchronousScheduledTaskRepository,
} from "@openwork/scheduled-tasks";
import type { RuntimeSqliteDatabase } from "../runtime-db.js";
import {
  openRuntimeSqliteDatabase,
  runtimeDbPath,
} from "../runtime-db.js";
import type { ServerConfig } from "../types.js";
import { migrateScheduledTaskDatabase } from "./scheduled-task-migrations.js";

type Row = Record<string, unknown>;
type SqliteStatement = {
  run: (...params: unknown[]) => unknown;
  get: (...params: unknown[]) => unknown;
  all: (...params: unknown[]) => unknown;
};

function statement(database: RuntimeSqliteDatabase, sql: string): SqliteStatement {
  return database.sqlite.prepare(sql) as unknown as SqliteStatement;
}

function parseJson(value: unknown): unknown {
  return value === null || value === undefined ? null : JSON.parse(String(value));
}

function stringifyJson(value: unknown): string {
  return JSON.stringify(value);
}

function nullableNumber(value: unknown): number | null {
  return value === null || value === undefined ? null : Number(value);
}

function taskFromRow(row: Row): ScheduledTask {
  return scheduledTaskSchema.parse({
    id: row.id,
    workspaceId: row.workspace_id,
    state: row.state,
    enabled: Boolean(row.enabled),
    draftRevisionId: row.draft_revision_id,
    activeRevisionId: row.active_revision_id,
    activeGrantId: row.active_grant_id,
    nextRunAt: nullableNumber(row.next_run_at),
    needsAttention: parseJson(row.needs_attention_json),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    deletedAt: nullableNumber(row.deleted_at),
  });
}

function revisionFromRow(row: Row): ScheduledTaskRevision {
  return scheduledTaskRevisionSchema.parse({
    id: row.id,
    taskId: row.task_id,
    revision: Number(row.revision),
    definition: parseJson(row.definition_json),
    createdAt: Number(row.created_at),
    createdBy: row.created_by,
    reviewedAt: nullableNumber(row.reviewed_at),
    reviewedBy: row.reviewed_by,
  });
}

function grantFromRow(row: Row): ScheduledTaskGrant {
  return scheduledTaskGrantSchema.parse(parseJson(row.grant_json));
}

function runFromRow(row: Row): ScheduledTaskRun {
  return scheduledTaskRunSchema.parse({
    id: row.id,
    taskId: row.task_id,
    taskRevisionId: row.task_revision_id,
    grantRevisionId: row.grant_revision_id,
    placement: row.placement_json === null || row.placement_json === undefined
      ? undefined
      : parseJson(row.placement_json),
    occurrenceId: row.occurrence_id,
    trigger: row.trigger,
    status: row.status,
    scheduledFor: nullableNumber(row.scheduled_for),
    claimedAt: Number(row.claimed_at),
    startedAt: nullableNumber(row.started_at),
    completedAt: nullableNumber(row.completed_at),
    durationMs: nullableNumber(row.duration_ms),
    idempotencyKey: row.idempotency_key,
    sessionId: row.session_id,
    attemptCount: Number(row.attempt_count),
    boundedUsage: parseJson(row.bounded_usage_json),
    error: parseJson(row.error_json),
    needsAttention: parseJson(row.needs_attention_json),
    artifacts: parseJson(row.artifacts_json),
    cancelRequestedAt: nullableNumber(row.cancel_requested_at),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  });
}

function attemptFromRow(row: Row): ScheduledTaskAttempt {
  return scheduledTaskAttemptSchema.parse({
    id: row.id,
    runId: row.run_id,
    attempt: Number(row.attempt),
    status: row.status,
    sessionId: row.session_id,
    startedAt: Number(row.started_at),
    completedAt: nullableNumber(row.completed_at),
    error: parseJson(row.error_json),
  });
}

export type {
  ScheduledTaskClaimResult,
  ScheduledTaskDetail,
  ScheduledTaskListItem,
  ScheduledTaskOccurrenceRecord,
} from "@openwork/scheduled-tasks";

export type ScheduledTaskStore = SynchronousScheduledTaskRepository;

function insertTask(database: RuntimeSqliteDatabase, task: ScheduledTask): void {
  statement(database, `
    INSERT INTO openwork_scheduled_tasks(
      id, workspace_id, state, enabled, draft_revision_id, active_revision_id,
      active_grant_id, next_run_at, needs_attention_json, created_at, updated_at, deleted_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    task.id,
    task.workspaceId,
    task.state,
    task.enabled ? 1 : 0,
    task.draftRevisionId,
    task.activeRevisionId,
    task.activeGrantId,
    task.nextRunAt,
    task.needsAttention === null ? null : stringifyJson(task.needsAttention),
    task.createdAt,
    task.updatedAt,
    task.deletedAt,
  );
}

function insertRevision(database: RuntimeSqliteDatabase, revision: ScheduledTaskRevision): void {
  statement(database, `
    INSERT INTO openwork_scheduled_task_revisions(
      id, task_id, revision, definition_json, created_at, created_by, reviewed_at, reviewed_by
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    revision.id,
    revision.taskId,
    revision.revision,
    stringifyJson(revision.definition),
    revision.createdAt,
    revision.createdBy,
    revision.reviewedAt,
    revision.reviewedBy,
  );
}

function insertGrant(database: RuntimeSqliteDatabase, grant: ScheduledTaskGrant): void {
  statement(database, `
    INSERT INTO openwork_scheduled_task_grants(
      id, task_id, revision, task_revision_id, workspace_id, grant_json, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    grant.id,
    grant.taskId,
    grant.revision,
    grant.taskRevisionId,
    grant.workspaceId,
    stringifyJson(grant),
    grant.createdAt,
  );
}

function updateTask(database: RuntimeSqliteDatabase, task: ScheduledTask): void {
  statement(database, `
    UPDATE openwork_scheduled_tasks SET
      workspace_id = ?, state = ?, enabled = ?, draft_revision_id = ?,
      active_revision_id = ?, active_grant_id = ?, next_run_at = ?,
      needs_attention_json = ?, updated_at = ?, deleted_at = ?
    WHERE id = ?
  `).run(
    task.workspaceId,
    task.state,
    task.enabled ? 1 : 0,
    task.draftRevisionId,
    task.activeRevisionId,
    task.activeGrantId,
    task.nextRunAt,
    task.needsAttention === null ? null : stringifyJson(task.needsAttention),
    task.updatedAt,
    task.deletedAt,
    task.id,
  );
}

function insertRun(database: RuntimeSqliteDatabase, run: ScheduledTaskRun): void {
  statement(database, `
    INSERT INTO openwork_scheduled_task_runs(
      id, task_id, task_revision_id, grant_revision_id, placement_json, occurrence_id, trigger,
      status, scheduled_for, claimed_at, started_at, completed_at, duration_ms,
      idempotency_key, session_id, attempt_count, bounded_usage_json, error_json,
      needs_attention_json, artifacts_json, cancel_requested_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    run.id,
    run.taskId,
    run.taskRevisionId,
    run.grantRevisionId,
    run.placement === undefined ? null : stringifyJson(run.placement),
    run.occurrenceId,
    run.trigger,
    run.status,
    run.scheduledFor,
    run.claimedAt,
    run.startedAt,
    run.completedAt,
    run.durationMs,
    run.idempotencyKey,
    run.sessionId,
    run.attemptCount,
    stringifyJson(run.boundedUsage),
    run.error === null ? null : stringifyJson(run.error),
    run.needsAttention === null ? null : stringifyJson(run.needsAttention),
    stringifyJson(run.artifacts),
    run.cancelRequestedAt,
    run.createdAt,
    run.updatedAt,
  );
}

function updateRun(database: RuntimeSqliteDatabase, run: ScheduledTaskRun): void {
  statement(database, `
    UPDATE openwork_scheduled_task_runs SET
      status = ?, placement_json = ?, started_at = ?, completed_at = ?, duration_ms = ?, session_id = ?,
      attempt_count = ?, bounded_usage_json = ?, error_json = ?,
      needs_attention_json = ?, artifacts_json = ?, cancel_requested_at = ?, updated_at = ?
    WHERE id = ?
  `).run(
    run.status,
    run.placement === undefined ? null : stringifyJson(run.placement),
    run.startedAt,
    run.completedAt,
    run.durationMs,
    run.sessionId,
    run.attemptCount,
    stringifyJson(run.boundedUsage),
    run.error === null ? null : stringifyJson(run.error),
    run.needsAttention === null ? null : stringifyJson(run.needsAttention),
    stringifyJson(run.artifacts),
    run.cancelRequestedAt,
    run.updatedAt,
    run.id,
  );
}

function runInImmediateTransaction<T>(database: RuntimeSqliteDatabase, callback: () => T): T {
  database.sqlite.exec("BEGIN IMMEDIATE");
  try {
    const result = callback();
    database.sqlite.exec("COMMIT");
    return result;
  } catch (error) {
    database.sqlite.exec("ROLLBACK");
    throw error;
  }
}

class SqliteScheduledTaskStore implements SynchronousScheduledTaskRepository {
  constructor(
    private readonly database: RuntimeSqliteDatabase,
    private readonly ownsDatabase: boolean,
  ) {}

  createTask(task: ScheduledTask, revision: ScheduledTaskRevision): void {
    runInImmediateTransaction(this.database, () => {
      insertTask(this.database, scheduledTaskSchema.parse(task));
      insertRevision(this.database, scheduledTaskRevisionSchema.parse(revision));
    });
  }

  createRevision(task: ScheduledTask, revision: ScheduledTaskRevision): void {
    runInImmediateTransaction(this.database, () => {
      insertRevision(this.database, scheduledTaskRevisionSchema.parse(revision));
      updateTask(this.database, scheduledTaskSchema.parse(task));
    });
  }

  activateGrant(
    task: ScheduledTask,
    reviewedRevision: ScheduledTaskRevision,
    grant: ScheduledTaskGrant,
  ): void {
    runInImmediateTransaction(this.database, () => {
      insertRevision(this.database, scheduledTaskRevisionSchema.parse(reviewedRevision));
      insertGrant(this.database, scheduledTaskGrantSchema.parse(grant));
      updateTask(this.database, scheduledTaskSchema.parse(task));
    });
  }

  saveTask(task: ScheduledTask): void {
    updateTask(this.database, scheduledTaskSchema.parse(task));
  }

  getTask(taskId: string): ScheduledTask | null {
    const row = statement(
      this.database,
      "SELECT * FROM openwork_scheduled_tasks WHERE id = ?",
    ).get(taskId) as Row | undefined;
    return row ? taskFromRow(row) : null;
  }

  getRevision(revisionId: string): ScheduledTaskRevision | null {
    const row = statement(
      this.database,
      "SELECT * FROM openwork_scheduled_task_revisions WHERE id = ?",
    ).get(revisionId) as Row | undefined;
    return row ? revisionFromRow(row) : null;
  }

  getGrant(grantId: string): ScheduledTaskGrant | null {
    const row = statement(
      this.database,
      "SELECT * FROM openwork_scheduled_task_grants WHERE id = ?",
    ).get(grantId) as Row | undefined;
    if (!row) return null;
    const grant = grantFromRow(row);
    const revocation = statement(this.database, `
      SELECT revoked_at, reason FROM openwork_scheduled_task_grant_revocations
      WHERE grant_id = ?
    `).get(grantId) as Row | undefined;
    return revocation
      ? scheduledTaskGrantSchema.parse({
          ...grant,
          revokedAt: Number(revocation.revoked_at),
          revocationReason: String(revocation.reason),
        })
      : grant;
  }

  revokeGrant(
    grantId: string,
    revokedAt: number,
    reason: string,
    revokedBy: string,
  ): ScheduledTaskGrant {
    runInImmediateTransaction(this.database, () => {
      statement(this.database, `
        INSERT INTO openwork_scheduled_task_grant_revocations(
          grant_id, revoked_at, reason, revoked_by
        ) VALUES (?, ?, ?, ?)
        ON CONFLICT(grant_id) DO NOTHING
      `).run(grantId, revokedAt, reason, revokedBy);
    });
    const grant = this.getGrant(grantId);
    if (!grant) throw new Error(`Scheduled task grant ${grantId} does not exist`);
    return grant;
  }

  getDetail(taskId: string, runLimit = 100): ScheduledTaskDetail | null {
    const task = this.getTask(taskId);
    if (!task) return null;
    const draftRevision = this.getRevision(task.draftRevisionId);
    if (!draftRevision) {
      throw new Error(`Scheduled task ${taskId} points to a missing draft revision`);
    }
    return {
      task,
      draftRevision,
      activeRevision: task.activeRevisionId ? this.getRevision(task.activeRevisionId) : null,
      grant: task.activeGrantId ? this.getGrant(task.activeGrantId) : null,
      runs: this.listRuns(taskId, runLimit),
    };
  }

  listTasks(scope: ScheduledTaskRepositoryFilter): ScheduledTaskListItem[] {
    const workspaceId = localWorkspaceIdForScheduledTaskScope(scope);
    if (workspaceId === null) return [];
    const rows = workspaceId === undefined
      ? statement(this.database, `
          SELECT * FROM openwork_scheduled_tasks
          WHERE deleted_at IS NULL
          ORDER BY updated_at DESC
        `).all() as Row[]
      : statement(this.database, `
          SELECT * FROM openwork_scheduled_tasks
          WHERE workspace_id = ? AND deleted_at IS NULL
          ORDER BY updated_at DESC
        `).all(workspaceId) as Row[];
    return rows.map((row) => {
      const task = taskFromRow(row);
      const revision = this.getRevision(task.draftRevisionId);
      if (!revision) throw new Error(`Scheduled task ${task.id} has no draft revision`);
      const latestRun = this.listRuns(task.id, 1)[0];
      return {
        task,
        revision,
        ...(task.activeGrantId && this.getGrant(task.activeGrantId)
          ? { grant: this.getGrant(task.activeGrantId) ?? undefined }
          : {}),
        ...(latestRun ? { latestRun } : {}),
      };
    });
  }

  listDueTasks(now: number, scope?: ScheduledTaskRepositoryFilter): ScheduledTask[] {
    const workspaceId = localWorkspaceIdForScheduledTaskScope(scope);
    if (workspaceId === null) return [];
    const rows = workspaceId === undefined
      ? statement(this.database, `
          SELECT * FROM openwork_scheduled_tasks
          WHERE enabled = 1 AND state = 'enabled' AND deleted_at IS NULL
            AND next_run_at IS NOT NULL AND next_run_at <= ?
          ORDER BY next_run_at ASC
        `).all(now) as Row[]
      : statement(this.database, `
          SELECT * FROM openwork_scheduled_tasks
          WHERE workspace_id = ? AND enabled = 1 AND state = 'enabled'
            AND deleted_at IS NULL AND next_run_at IS NOT NULL AND next_run_at <= ?
          ORDER BY next_run_at ASC
        `).all(workspaceId, now) as Row[];
    return rows.map(taskFromRow);
  }

  nextDueAt(scope?: ScheduledTaskRepositoryFilter): number | null {
    const workspaceId = localWorkspaceIdForScheduledTaskScope(scope);
    if (workspaceId === null) return null;
    const row = workspaceId === undefined
      ? statement(this.database, `
          SELECT MIN(next_run_at) AS next_due_at
          FROM openwork_scheduled_tasks
          WHERE enabled = 1 AND state = 'enabled' AND deleted_at IS NULL
            AND next_run_at IS NOT NULL
        `).get() as Row | undefined
      : statement(this.database, `
          SELECT MIN(next_run_at) AS next_due_at
          FROM openwork_scheduled_tasks
          WHERE workspace_id = ? AND enabled = 1 AND state = 'enabled'
            AND deleted_at IS NULL AND next_run_at IS NOT NULL
        `).get(workspaceId) as Row | undefined;
    return nullableNumber(row?.next_due_at);
  }

  claimOccurrence(
    occurrence: ScheduledTaskOccurrenceRecord,
    claimedRun: ScheduledTaskRun,
    overlapRun: ScheduledTaskRun,
    taskAfterClaim?: ScheduledTask,
  ): ScheduledTaskClaimResult {
    return runInImmediateTransaction(this.database, () => {
      const duplicateRow = statement(
        this.database,
        "SELECT * FROM openwork_scheduled_task_runs WHERE idempotency_key = ? OR occurrence_id = ? LIMIT 1",
      ).get(claimedRun.idempotencyKey, occurrence.id) as Row | undefined;
      if (duplicateRow) {
        if (taskAfterClaim) updateTask(this.database, scheduledTaskSchema.parse(taskAfterClaim));
        return { kind: "duplicate", run: runFromRow(duplicateRow) };
      }

      const activeRow = statement(this.database, `
        SELECT * FROM openwork_scheduled_task_runs
        WHERE task_id = ? AND status IN ('claimed', 'running', 'retrying')
        ORDER BY claimed_at ASC LIMIT 1
      `).get(occurrence.taskId) as Row | undefined;
      const run = activeRow ? overlapRun : claimedRun;
      const status = activeRow ? "skipped-overlap" : "claimed";

      statement(this.database, `
        INSERT INTO openwork_scheduled_task_occurrences(
          id, task_id, task_revision_id, scheduled_for, trigger, status, claimed_at, run_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        occurrence.id,
        occurrence.taskId,
        occurrence.taskRevisionId,
        occurrence.scheduledFor,
        occurrence.trigger,
        status,
        occurrence.claimedAt,
        run.id,
      );
      insertRun(this.database, run);
      if (taskAfterClaim) updateTask(this.database, scheduledTaskSchema.parse(taskAfterClaim));
      return activeRow
        ? { kind: "overlap", run }
        : { kind: "claimed", run };
    });
  }

  saveRun(run: ScheduledTaskRun): void {
    updateRun(this.database, scheduledTaskRunSchema.parse(run));
    statement(
      this.database,
      "UPDATE openwork_scheduled_task_occurrences SET status = ? WHERE id = ?",
    ).run(run.status, run.occurrenceId);
  }

  getRun(runId: string): ScheduledTaskRun | null {
    const row = statement(
      this.database,
      "SELECT * FROM openwork_scheduled_task_runs WHERE id = ?",
    ).get(runId) as Row | undefined;
    return row ? runFromRow(row) : null;
  }

  listRuns(taskId: string, limit = 100): ScheduledTaskRun[] {
    const boundedLimit = Math.max(1, Math.min(Math.floor(limit), 500));
    const rows = statement(this.database, `
      SELECT * FROM openwork_scheduled_task_runs
      WHERE task_id = ?
      ORDER BY created_at DESC
      LIMIT ?
    `).all(taskId, boundedLimit) as Row[];
    return rows.map(runFromRow);
  }

  listInterruptedRuns(): ScheduledTaskRun[] {
    const rows = statement(this.database, `
      SELECT * FROM openwork_scheduled_task_runs
      WHERE status IN ('claimed', 'running', 'retrying')
      ORDER BY claimed_at ASC
    `).all() as Row[];
    return rows.map(runFromRow);
  }

  createAttempt(attempt: ScheduledTaskAttempt): void {
    const parsed = scheduledTaskAttemptSchema.parse(attempt);
    statement(this.database, `
      INSERT INTO openwork_scheduled_task_attempts(
        id, run_id, attempt, status, session_id, started_at, completed_at, error_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      parsed.id,
      parsed.runId,
      parsed.attempt,
      parsed.status,
      parsed.sessionId,
      parsed.startedAt,
      parsed.completedAt,
      parsed.error === null ? null : stringifyJson(parsed.error),
    );
  }

  saveAttempt(attempt: ScheduledTaskAttempt): void {
    const parsed = scheduledTaskAttemptSchema.parse(attempt);
    statement(this.database, `
      UPDATE openwork_scheduled_task_attempts SET
        status = ?, session_id = ?, completed_at = ?, error_json = ?
      WHERE id = ?
    `).run(
      parsed.status,
      parsed.sessionId,
      parsed.completedAt,
      parsed.error === null ? null : stringifyJson(parsed.error),
      parsed.id,
    );
  }

  listAttempts(runId: string): ScheduledTaskAttempt[] {
    const rows = statement(this.database, `
      SELECT * FROM openwork_scheduled_task_attempts
      WHERE run_id = ?
      ORDER BY attempt ASC
    `).all(runId) as Row[];
    return rows.map(attemptFromRow);
  }

  close(): void {
    if (this.ownsDatabase) this.database.close();
  }
}

export interface CreateScheduledTaskStoreOptions {
  config?: ServerConfig;
  path?: string;
  database?: RuntimeSqliteDatabase;
}

export async function createScheduledTaskStore(
  options: CreateScheduledTaskStoreOptions,
): Promise<SynchronousScheduledTaskRepository> {
  if (!options.database && !options.path && !options.config) {
    throw new Error("createScheduledTaskStore requires config, path, or database");
  }
  const database = options.database
    ?? await openRuntimeSqliteDatabase(options.path ?? runtimeDbPath(options.config!));
  migrateScheduledTaskDatabase(database);
  return new SqliteScheduledTaskStore(database, !options.database);
}
