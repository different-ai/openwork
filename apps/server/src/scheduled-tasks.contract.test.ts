import { describe, expect, test } from "bun:test";
import {
  scheduledTaskDefinitionSchema,
  scheduledTaskExecutionResultSchema,
  scheduledTaskGrantSchema,
  scheduledTaskRunReceiptSchema,
} from "@openwork/types/scheduled-tasks";

const definition = {
  name: "Daily project summary",
  description: "Summarize the current workspace once per day.",
  prompt: "Review the workspace and write reports/daily-summary.md.",
  workspaceId: "ws_example",
  schedule: {
    kind: "daily" as const,
    timezone: "Europe/Berlin",
    hour: 9,
    minute: 30,
  },
  model: {
    providerId: "openai",
    modelId: "gpt-5",
    agent: "build",
  },
  maximumRuntimeMs: 300_000,
  overlapPolicy: "skip" as const,
  retryPolicy: {
    maximumAttempts: 2,
    delayMs: 1_000,
  },
  missedRunPolicy: {
    kind: "skip" as const,
    graceMs: 60_000,
    maximumRecoverableOccurrences: 1 as const,
  },
};

describe("scheduled task contracts", () => {
  test("accepts bounded daily and weekly definitions", () => {
    expect(scheduledTaskDefinitionSchema.parse(definition).schedule.kind).toBe("daily");
    expect(scheduledTaskDefinitionSchema.parse({
      ...definition,
      schedule: {
        kind: "weekly",
        timezone: "America/New_York",
        daysOfWeek: [1, 3, 5],
        hour: 8,
        minute: 15,
      },
    }).schedule.kind).toBe("weekly");
  });

  test("rejects invalid timezones and partial model selections", () => {
    expect(scheduledTaskDefinitionSchema.safeParse({
      ...definition,
      schedule: { ...definition.schedule, timezone: "Mars/Olympus" },
    }).success).toBe(false);
    expect(scheduledTaskDefinitionSchema.safeParse({
      ...definition,
      model: { providerId: "openai", modelId: null, agent: null },
    }).success).toBe(false);
  });

  test("keeps communication, destructive actions, and self-modification denied", () => {
    const grant = {
      id: "grant_1",
      taskId: "task_1",
      revision: 1,
      taskRevisionId: "revision_1",
      workspaceId: definition.workspaceId,
      authorizedWorkspaceRoots: ["/tmp/workspace"],
      capabilityIds: ["workspace.files.read", "workspace.files.write"],
      actionClasses: ["read", "write"],
      filesystem: { read: true, write: true },
      maximumRuntimeMs: definition.maximumRuntimeMs,
      model: definition.model,
      communicationPolicy: "deny",
      destructiveActionPolicy: "deny",
      selfModificationPolicy: "deny",
      grantor: "user",
      reviewedAt: 1,
      expiresAt: null,
      revokedAt: null,
      revocationReason: null,
      createdAt: 1,
    };

    expect(scheduledTaskGrantSchema.parse(grant).communicationPolicy).toBe("deny");
    expect(scheduledTaskGrantSchema.safeParse({
      ...grant,
      communicationPolicy: "allow",
    }).success).toBe(false);
  });

  test("requires typed attention and complete immutable receipt links", () => {
    const attention = {
      code: "approval-required" as const,
      message: "The run is waiting for a permission decision.",
      repairable: true,
      runId: "run_1",
      sessionId: "session_1",
      createdAt: 5,
    };
    expect(scheduledTaskExecutionResultSchema.parse({
      status: "needs-attention",
      sessionId: "session_1",
      attention,
    }).status).toBe("needs-attention");

    expect(scheduledTaskRunReceiptSchema.safeParse({
      run: {},
      taskRevision: {},
      grantRevision: {},
      attempts: [],
      sessionRoute: null,
      artifacts: [],
    }).success).toBe(false);
  });
});
