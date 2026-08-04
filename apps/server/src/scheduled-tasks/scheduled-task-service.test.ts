import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type {
  ScheduledTaskDefinition,
  ScheduledTaskRun,
} from "@openwork/types/scheduled-tasks";
import { ApiError } from "../errors.js";
import type { ScheduledTaskExecutionAdapter } from "./execution.js";
import { createScheduledTaskService } from "./scheduled-task-service.js";
import {
  createScheduledTaskStore,
  type ScheduledTaskStore,
} from "./scheduled-task-store.js";

const cleanup: string[] = [];

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

const definition: ScheduledTaskDefinition = {
  name: "Daily brief",
  description: "",
  prompt: "Prepare the daily brief.",
  workspaceId: "ws_test",
  schedule: {
    kind: "daily",
    timezone: "UTC",
    hour: 9,
    minute: 0,
  },
  model: {
    providerId: null,
    modelId: null,
    agent: null,
  },
  maximumRuntimeMs: 60_000,
  overlapPolicy: "skip",
  retryPolicy: {
    maximumAttempts: 1,
    delayMs: 0,
  },
  missedRunPolicy: {
    kind: "skip",
    graceMs: 60_000,
    maximumRecoverableOccurrences: 1,
  },
};

const execution: ScheduledTaskExecutionAdapter = {
  async execute(request, options) {
    await options.onEvent?.({
      type: "session-created",
      at: Date.now(),
      sessionId: `ses_${request.runId}`,
    });
    return {
      status: "completed",
      sessionId: `ses_${request.runId}`,
      artifacts: [],
      boundedUsage: {
        inputTokens: 1,
        outputTokens: 1,
        costMicros: 1,
      },
    };
  },
  async cancel(request) {
    return { status: "cancelled", sessionId: request.sessionId };
  },
};

async function openStoreWithPath(): Promise<{ store: ScheduledTaskStore; path: string }> {
  const directory = await mkdtemp(join(tmpdir(), "openwork-scheduled-task-"));
  cleanup.push(directory);
  const path = join(directory, "runtime.sqlite");
  return { store: await createScheduledTaskStore({ path }), path };
}

async function openStore(): Promise<ScheduledTaskStore> {
  return (await openStoreWithPath()).store;
}

async function createReviewedTask(
  store: ScheduledTaskStore,
  clock: () => number,
  options: {
    execution?: ScheduledTaskExecutionAdapter;
    definition?: ScheduledTaskDefinition;
    validateAuthority?: Parameters<typeof createScheduledTaskService>[0]["validateAuthority"];
    scheduleExecutionTimeout?: Parameters<typeof createScheduledTaskService>[0]["scheduleExecutionTimeout"];
  } = {},
) {
  const taskDefinition = options.definition ?? definition;
  const service = createScheduledTaskService({
    store,
    execution: options.execution ?? execution,
    clock,
    validateAuthority: options.validateAuthority,
    scheduleExecutionTimeout: options.scheduleExecutionTimeout,
  });
  const created = service.createDraft(taskDefinition, "owner");
  const reviewed = await service.review("ws_test", created.task.id, {
    expectedRevisionId: created.revision.id,
    authorizedWorkspaceRoots: ["/tmp/workspace"],
    capabilityIds: ["workspace.files.read"],
    actionClasses: ["read"],
    filesystem: { read: true, write: false },
    maximumRuntimeMs: taskDefinition.maximumRuntimeMs,
    model: taskDefinition.model,
    expiresAt: null,
    grantor: "forged-grantor",
  }, "owner");
  return { service, reviewed };
}

async function waitForRunStatus(
  service: ReturnType<typeof createScheduledTaskService>,
  taskId: string,
  runId: string,
  statuses: ScheduledTaskRun["status"][],
): Promise<ScheduledTaskRun> {
  for (let index = 0; index < 100; index += 1) {
    const run = service.getRunReceipt("ws_test", taskId, runId).run;
    if (statuses.includes(run.status)) return run;
    await Bun.sleep(1);
  }
  return service.getRunReceipt("ws_test", taskId, runId).run;
}

describe("scheduled task service", () => {
  test("applies feature-local migrations idempotently on reopen", async () => {
    const opened = await openStoreWithPath();
    opened.store.close();

    const reopened = await createScheduledTaskStore({ path: opened.path });
    expect(reopened.listTasks("ws_test")).toEqual([]);
    reopened.close();
  });

  test("migrates an existing runtime database without disturbing other stores", async () => {
    const directory = await mkdtemp(join(tmpdir(), "openwork-scheduled-task-existing-"));
    cleanup.push(directory);
    const path = join(directory, "runtime.sqlite");
    const existing = new Database(path, { create: true });
    existing.exec(`
      CREATE TABLE existing_runtime_state (
        id TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      INSERT INTO existing_runtime_state(id, value) VALUES ('kept', 'unchanged');
    `);
    existing.close();

    const store = await createScheduledTaskStore({ path });
    store.close();

    const migrated = new Database(path, { readonly: true, create: false });
    expect(
      migrated.query("SELECT value FROM existing_runtime_state WHERE id = 'kept'").get(),
    ).toEqual({ value: "unchanged" });
    expect(
      migrated.query(
        "SELECT MAX(version) AS version FROM openwork_scheduled_task_migrations",
      ).get(),
    ).toEqual({ version: 3 });
    migrated.close();
  });

  test("persists revocation separately and blocks execution until re-reviewed", async () => {
    const opened = await openStoreWithPath();
    const { store } = opened;
    const clock = () => Date.UTC(2026, 6, 28, 8, 0);
    const { service, reviewed } = await createReviewedTask(store, clock);

    const revoked = await service.revokeGrant(
      "ws_test",
      reviewed.task.id,
      "Workspace access removed",
      "owner",
    );

    expect(revoked.grant.revokedAt).toBe(clock());
    expect(revoked.task.state).toBe("needs-attention");
    await expect(service.runOnce("ws_test", reviewed.task.id)).rejects.toThrow();
    const edited = service.updateDraft("ws_test", reviewed.task.id, {
      expectedRevisionId: reviewed.revision.id,
      definition: { ...definition, name: "Re-reviewed brief" },
    }, "owner");
    const replacement = await service.review("ws_test", reviewed.task.id, {
      expectedRevisionId: edited.revision.id,
      authorizedWorkspaceRoots: ["/tmp/workspace"],
      capabilityIds: ["workspace.files.read"],
      actionClasses: ["read"],
      filesystem: { read: true, write: false },
      maximumRuntimeMs: definition.maximumRuntimeMs,
      model: definition.model,
      expiresAt: null,
      grantor: "forged-again",
    }, "owner");
    expect(replacement.grant.revision).toBe(2);
    expect(replacement.grant.revokedAt).toBeNull();
    expect(replacement.task.state).toBe("paused");
    store.close();

    const reopened = await createScheduledTaskStore({ path: opened.path });
    expect(reopened.getGrant(reviewed.grant.id)?.revokedAt).toBe(clock());
    expect(reopened.getGrant(reviewed.grant.id)?.revocationReason).toBe("Workspace access removed");
    expect(reopened.getGrant(reviewed.grant.id)?.grantor).toBe("owner");
    expect(reopened.getGrant(replacement.grant.id)?.revision).toBe(2);
    expect(reopened.getGrant(replacement.grant.id)?.revokedAt).toBeNull();
    reopened.close();
  });

  test("rejects review of a stale draft revision", async () => {
    const store = await openStore();
    const service = createScheduledTaskService({
      store,
      execution,
      clock: () => Date.UTC(2026, 6, 28, 8, 0),
    });
    const created = service.createDraft(definition, "owner");
    service.updateDraft("ws_test", created.task.id, {
      expectedRevisionId: created.revision.id,
      definition: { ...definition, name: "Edited brief" },
    }, "owner");

    await expect(service.review("ws_test", created.task.id, {
      expectedRevisionId: created.revision.id,
      authorizedWorkspaceRoots: ["/tmp/workspace"],
      capabilityIds: ["workspace.files.read"],
      actionClasses: ["read"],
      filesystem: { read: true, write: false },
      maximumRuntimeMs: definition.maximumRuntimeMs,
      model: definition.model,
      expiresAt: null,
      grantor: "forged-label",
    }, "authenticated-owner")).rejects.toThrow("latest");
    store.close();
  });

  test("recovers persisted nonterminal runs as ambiguous after restart", async () => {
    const store = await openStore();
    const clock = () => Date.UTC(2026, 6, 28, 8, 0);
    const { reviewed } = await createReviewedTask(store, clock);
    const occurrenceId = "occ_restart";
    const run: ScheduledTaskRun = {
      id: "run_restart",
      taskId: reviewed.task.id,
      taskRevisionId: reviewed.revision.id,
      grantRevisionId: reviewed.grant.id,
      occurrenceId,
      trigger: "manual",
      status: "claimed",
      scheduledFor: null,
      claimedAt: clock() - 1_000,
      startedAt: null,
      completedAt: null,
      durationMs: null,
      idempotencyKey: "restart-key",
      sessionId: null,
      attemptCount: 0,
      boundedUsage: { inputTokens: null, outputTokens: null, costMicros: null },
      error: null,
      needsAttention: null,
      artifacts: [],
      cancelRequestedAt: null,
      createdAt: clock() - 1_000,
      updatedAt: clock() - 1_000,
    };
    store.claimOccurrence({
      id: occurrenceId,
      taskId: reviewed.task.id,
      taskRevisionId: reviewed.revision.id,
      scheduledFor: null,
      trigger: "manual",
      status: "claimed",
      claimedAt: run.claimedAt,
    }, run, { ...run, id: "run_overlap", status: "skipped-overlap", completedAt: clock(), durationMs: 0 });

    const restarted = createScheduledTaskService({ store, execution, clock });

    expect(restarted.getRunReceipt("ws_test", reviewed.task.id, run.id).run.status).toBe("ambiguous");
    expect(restarted.get("ws_test", reviewed.task.id).task.state).toBe("needs-attention");
    store.close();
  });

  test("atomically persists skipped overlap outcomes", async () => {
    const store = await openStore();
    const clock = () => Date.UTC(2026, 6, 28, 8, 0);
    const { reviewed } = await createReviewedTask(store, clock);
    const makeRun = (id: string, occurrenceId: string): ScheduledTaskRun => ({
      id,
      taskId: reviewed.task.id,
      taskRevisionId: reviewed.revision.id,
      grantRevisionId: reviewed.grant.id,
      occurrenceId,
      trigger: "scheduled",
      status: "claimed",
      scheduledFor: clock(),
      claimedAt: clock(),
      startedAt: null,
      completedAt: null,
      durationMs: null,
      idempotencyKey: `key_${id}`,
      sessionId: null,
      attemptCount: 0,
      boundedUsage: { inputTokens: null, outputTokens: null, costMicros: null },
      error: null,
      needsAttention: null,
      artifacts: [],
      cancelRequestedAt: null,
      createdAt: clock(),
      updatedAt: clock(),
    });
    const first = makeRun("run_first", "occ_first");
    store.claimOccurrence({
      id: first.occurrenceId,
      taskId: first.taskId,
      taskRevisionId: first.taskRevisionId,
      scheduledFor: first.scheduledFor,
      trigger: first.trigger,
      status: first.status,
      claimedAt: first.claimedAt,
    }, first, { ...first, id: "run_first_overlap", status: "skipped-overlap", completedAt: clock(), durationMs: 0 });
    const second = {
      ...makeRun("run_second", "occ_second"),
      scheduledFor: clock() + 60_000,
    };
    const result = store.claimOccurrence({
      id: second.occurrenceId,
      taskId: second.taskId,
      taskRevisionId: second.taskRevisionId,
      scheduledFor: clock() + 60_000,
      trigger: second.trigger,
      status: second.status,
      claimedAt: second.claimedAt,
    }, second, { ...second, id: "run_second_overlap", status: "skipped-overlap", completedAt: clock(), durationMs: 0 });

    expect(result.kind).toBe("overlap");
    expect(result.run.status).toBe("skipped-overlap");
    store.close();
  });

  test("returns the original run for a duplicate occurrence claim", async () => {
    const store = await openStore();
    const clock = () => Date.UTC(2026, 6, 28, 8, 0);
    const { reviewed } = await createReviewedTask(store, clock);
    const run: ScheduledTaskRun = {
      id: "run_idempotent",
      taskId: reviewed.task.id,
      taskRevisionId: reviewed.revision.id,
      grantRevisionId: reviewed.grant.id,
      occurrenceId: "occ_idempotent",
      trigger: "scheduled",
      status: "claimed",
      scheduledFor: clock(),
      claimedAt: clock(),
      startedAt: null,
      completedAt: null,
      durationMs: null,
      idempotencyKey: "scheduled:idempotent",
      sessionId: null,
      attemptCount: 0,
      boundedUsage: { inputTokens: null, outputTokens: null, costMicros: null },
      error: null,
      needsAttention: null,
      artifacts: [],
      cancelRequestedAt: null,
      createdAt: clock(),
      updatedAt: clock(),
    };
    const occurrence = {
      id: run.occurrenceId,
      taskId: run.taskId,
      taskRevisionId: run.taskRevisionId,
      scheduledFor: run.scheduledFor,
      trigger: run.trigger,
      status: run.status,
      claimedAt: run.claimedAt,
    } as const;
    store.claimOccurrence(
      occurrence,
      run,
      { ...run, id: "run_unused_overlap", status: "skipped-overlap", completedAt: clock(), durationMs: 0 },
    );
    const duplicate = store.claimOccurrence(
      occurrence,
      { ...run, id: "run_duplicate" },
      { ...run, id: "run_duplicate_overlap", status: "skipped-overlap", completedAt: clock(), durationMs: 0 },
      {
        ...reviewed.task,
        nextRunAt: clock() + 60_000,
        updatedAt: clock() + 1,
      },
    );

    expect(duplicate.kind).toBe("duplicate");
    expect(duplicate.run.id).toBe(run.id);
    expect(store.getTask(reviewed.task.id)?.nextRunAt).toBe(clock() + 60_000);
    store.close();
  });

  test("retries a retryable failure once and persists both attempts", async () => {
    const store = await openStore();
    let calls = 0;
    const retryingExecution: ScheduledTaskExecutionAdapter = {
      async execute(request) {
        calls += 1;
        if (calls === 1) {
          return {
            status: "failed",
            sessionId: `ses_${request.attemptId}`,
            error: {
              code: "execution-failed",
              message: "Transient engine failure",
              retryable: true,
              ambiguous: false,
            },
          };
        }
        return {
          status: "completed",
          sessionId: `ses_${request.attemptId}`,
          artifacts: [],
          boundedUsage: { inputTokens: 1, outputTokens: 1, costMicros: 1 },
        };
      },
      async cancel(request) {
        return { status: "cancelled", sessionId: request.sessionId };
      },
    };
    const { service, reviewed } = await createReviewedTask(
      store,
      () => Date.UTC(2026, 6, 28, 8, 0),
      {
        execution: retryingExecution,
        definition: {
          ...definition,
          retryPolicy: { maximumAttempts: 2, delayMs: 0 },
        },
      },
    );

    const claimed = await service.runOnce("ws_test", reviewed.task.id);
    const completed = await waitForRunStatus(
      service,
      reviewed.task.id,
      claimed.id,
      ["completed", "failed"],
    );

    expect(completed.status).toBe("completed");
    expect(calls).toBe(2);
    expect(service.getRunReceipt("ws_test", reviewed.task.id, claimed.id).attempts).toHaveLength(2);
    store.close();
  });

  test("cancels the exact live session and persists cancellation", async () => {
    const store = await openStore();
    const cancelledSessionIds: string[] = [];
    let releaseExecution: (() => void) | null = null;
    const blockingExecution: ScheduledTaskExecutionAdapter = {
      async execute(request, options) {
        const sessionId = `ses_${request.runId}`;
        await options.onEvent?.({
          type: "session-created",
          at: Date.UTC(2026, 6, 28, 8, 0),
          sessionId,
        });
        await new Promise<void>((resolve) => {
          releaseExecution = resolve;
        });
        return {
          status: "cancelled",
          sessionId,
          error: {
            code: "execution-failed",
            message: "Cancelled by owner",
            retryable: false,
            ambiguous: false,
          },
        };
      },
      async cancel(request) {
        cancelledSessionIds.push(request.sessionId);
        releaseExecution?.();
        return { status: "cancelled", sessionId: request.sessionId };
      },
    };
    const { service, reviewed } = await createReviewedTask(
      store,
      () => Date.UTC(2026, 6, 28, 8, 0),
      { execution: blockingExecution },
    );
    const run = await service.runOnce("ws_test", reviewed.task.id);
    await waitForRunStatus(service, reviewed.task.id, run.id, ["running"]);

    const cancelled = await service.cancelRun("ws_test", reviewed.task.id, run.id);

    expect(cancelled.status).toBe("cancelled");
    expect(cancelledSessionIds).toEqual([`ses_${run.id}`]);
    await service.stop();
    store.close();
  });

  test("enforces maximum runtime with a persisted timed-out attempt", async () => {
    const store = await openStore();
    const timedExecution: ScheduledTaskExecutionAdapter = {
      async execute(_request, options) {
        await new Promise<void>((resolve) => {
          if (options.signal.aborted) resolve();
          else options.signal.addEventListener("abort", () => resolve(), { once: true });
        });
        return {
          status: "cancelled",
          sessionId: null,
          error: {
            code: "execution-failed",
            message: "Caller aborted execution",
            retryable: false,
            ambiguous: false,
          },
        };
      },
      async cancel(request) {
        return { status: "cancelled", sessionId: request.sessionId };
      },
    };
    const { service, reviewed } = await createReviewedTask(
      store,
      () => Date.UTC(2026, 6, 28, 8, 0),
      {
        execution: timedExecution,
        scheduleExecutionTimeout(onTimeout) {
          queueMicrotask(onTimeout);
          return () => undefined;
        },
      },
    );

    const claimed = await service.runOnce("ws_test", reviewed.task.id);
    const failed = await waitForRunStatus(
      service,
      reviewed.task.id,
      claimed.id,
      ["failed"],
    );
    const receipt = service.getRunReceipt("ws_test", reviewed.task.id, claimed.id);

    expect(failed.error?.code).toBe("execution-timed-out");
    expect(receipt.attempts).toHaveLength(1);
    expect(receipt.attempts[0]?.status).toBe("timed-out");
    store.close();
  });

  test("marks removed-workspace tasks immediately and cancels their live sessions", async () => {
    const store = await openStore();
    const cancellationReasons: string[] = [];
    let releaseExecution: (() => void) | null = null;
    const blockingExecution: ScheduledTaskExecutionAdapter = {
      async execute(request, options) {
        const sessionId = `ses_${request.runId}`;
        await options.onEvent?.({
          type: "session-created",
          at: Date.UTC(2026, 6, 28, 8, 0),
          sessionId,
        });
        await new Promise<void>((resolve) => {
          releaseExecution = resolve;
        });
        return {
          status: "cancelled",
          sessionId,
          error: {
            code: "workspace-removed",
            message: "Workspace removed",
            retryable: false,
            ambiguous: false,
          },
        };
      },
      async cancel(request) {
        cancellationReasons.push(request.reason);
        releaseExecution?.();
        return { status: "cancelled", sessionId: request.sessionId };
      },
    };
    const { service, reviewed } = await createReviewedTask(
      store,
      () => Date.UTC(2026, 6, 28, 8, 0),
      { execution: blockingExecution },
    );
    const run = await service.runOnce("ws_test", reviewed.task.id);
    await waitForRunStatus(service, reviewed.task.id, run.id, ["running"]);

    const result = await service.markWorkspaceUnavailable("ws_test");

    expect(result.taskIds).toEqual([reviewed.task.id]);
    expect(result.runIds).toEqual([run.id]);
    expect(cancellationReasons).toEqual(["workspace-removed"]);
    expect(service.get("ws_test", reviewed.task.id).task.needsAttention?.code).toBe("workspace-removed");
    await service.stop();
    store.close();
  });

  test("fault-isolates a revoked due task and still claims another task", async () => {
    const store = await openStore();
    let current = Date.UTC(2026, 6, 28, 8, 0);
    const first = await createReviewedTask(store, () => current);
    const secondCreated = first.service.createDraft(
      { ...definition, name: "Second daily brief" },
      "owner",
    );
    const second = await first.service.review("ws_test", secondCreated.task.id, {
      expectedRevisionId: secondCreated.revision.id,
      authorizedWorkspaceRoots: ["/tmp/workspace"],
      capabilityIds: ["workspace.files.read"],
      actionClasses: ["read"],
      filesystem: { read: true, write: false },
      maximumRuntimeMs: definition.maximumRuntimeMs,
      model: definition.model,
      expiresAt: null,
      grantor: "owner",
    }, "owner");
    await first.service.enable("ws_test", first.reviewed.task.id);
    await first.service.enable("ws_test", second.task.id);
    store.revokeGrant(first.reviewed.grant.id, current, "Capability removed", "owner");

    current = Date.UTC(2026, 6, 28, 9, 0);
    const tick = await first.service.tick({
      now: current,
      source: "manual",
      workspaceId: "ws_test",
    });

    expect(tick.claimedRunIds).toHaveLength(1);
    expect(first.service.get("ws_test", first.reviewed.task.id).task.needsAttention?.code).toBe("grant-revoked");
    expect(first.service.getRunReceipt("ws_test", second.task.id, tick.claimedRunIds[0]!).run.taskId).toBe(second.task.id);
    await first.service.stop();
    store.close();
  });

  test("turns live workspace authority loss into repairable attention", async () => {
    const store = await openStore();
    let current = Date.UTC(2026, 6, 28, 8, 0);
    const { service, reviewed } = await createReviewedTask(store, () => current, {
      validateAuthority(input) {
        if (input.phase === "execute") {
          throw new ApiError(
            409,
            "scheduled_task_workspace_inaccessible",
            "Workspace root is no longer authorized",
          );
        }
      },
    });
    await service.enable("ws_test", reviewed.task.id);
    current = Date.UTC(2026, 6, 28, 9, 0);

    const tick = await service.tick({
      now: current,
      source: "manual",
      workspaceId: "ws_test",
    });
    const run = await waitForRunStatus(
      service,
      reviewed.task.id,
      tick.claimedRunIds[0]!,
      ["needs-attention"],
    );

    expect(run.status).toBe("needs-attention");
    expect(service.get("ws_test", reviewed.task.id).task.needsAttention?.code).toBe("workspace-inaccessible");
    store.close();
  });

  test("keeps manual tasks run-once only", async () => {
    const store = await openStore();
    const manualDefinition: ScheduledTaskDefinition = {
      ...definition,
      schedule: {
        kind: "manual",
        timezone: "UTC",
      },
    };
    const { service, reviewed } = await createReviewedTask(
      store,
      () => Date.UTC(2026, 6, 28, 8, 0),
      { definition: manualDefinition },
    );

    await expect(service.enable("ws_test", reviewed.task.id)).rejects.toMatchObject({
      code: "scheduled_task_manual_only",
    });
    await expect(service.resume("ws_test", reviewed.task.id)).rejects.toMatchObject({
      code: "scheduled_task_manual_only",
    });

    const run = await service.runOnce("ws_test", reviewed.task.id);
    const completed = await waitForRunStatus(
      service,
      reviewed.task.id,
      run.id,
      ["completed"],
    );
    const task = service.get("ws_test", reviewed.task.id).task;

    expect(completed.trigger).toBe("manual");
    expect(task.state).toBe("ready");
    expect(task.enabled).toBe(false);
    expect(task.nextRunAt).toBeNull();
    store.close();
  });

  test("uses run once as a single missed-occurrence recovery and stays paused", async () => {
    const store = await openStore();
    let current = Date.UTC(2026, 6, 28, 8, 0);
    const { service, reviewed } = await createReviewedTask(store, () => current);
    await service.enable("ws_test", reviewed.task.id);

    current = Date.UTC(2026, 6, 28, 10, 1, 1);
    await service.tick({
      now: current,
      source: "manual",
      workspaceId: "ws_test",
    });
    expect(service.get("ws_test", reviewed.task.id).task.needsAttention?.code).toBe("missed-occurrence");

    const recovery = await service.runOnce("ws_test", reviewed.task.id);
    for (let index = 0; index < 20; index += 1) {
      if (service.getRunReceipt("ws_test", reviewed.task.id, recovery.id).run.status === "completed") break;
      await Bun.sleep(1);
    }

    const receipt = service.getRunReceipt("ws_test", reviewed.task.id, recovery.id);
    const repaired = service.get("ws_test", reviewed.task.id).task;
    expect(receipt.run.trigger).toBe("recovery");
    expect(receipt.run.status).toBe("completed");
    expect(repaired.state).toBe("paused");
    expect(repaired.enabled).toBe(false);
    expect(repaired.needsAttention).toBeNull();
    store.close();
  });
});
