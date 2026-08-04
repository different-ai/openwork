import { describe, expect, test } from "bun:test"
import {
  scheduledTaskFilesystemScopeSchema,
  scheduledTaskGrantSchema,
  scheduledTaskPlacementSchema,
  scheduledTaskSchema,
} from "@openwork/types/scheduled-tasks"
import {
  scheduledTaskPlacementIdentity,
  scheduledTaskPlacementNeedsReview,
} from "./contracts.js"
import { nextScheduledTaskOccurrence } from "./schedule.js"
import {
  assertScheduledTaskTransition,
  canTransitionScheduledTask,
  isTerminalScheduledTaskRunStatus,
} from "./state.js"
import {
  scheduledTaskOccurrenceIdentity,
  selectScheduledTasksForTick,
} from "./tick.js"

const localPlacement = scheduledTaskPlacementSchema.parse({
  target: { kind: "local-workspace", workspaceId: "ws_local" },
  schedulerOwner: "local-server",
  executionAvailability: "app-open",
  executionPrincipal: { kind: "local-user", identityId: "user_local" },
  capabilityReferences: [
    {
      id: "workspace.files.read",
      source: "openwork",
      actionClass: "read",
      reviewedVersion: "1",
      reviewedDigest: null,
    },
  ],
})

describe("portable Scheduled Tasks core", () => {
  test("keeps placement identity stable and requires review when placement changes", () => {
    expect(scheduledTaskPlacementIdentity(localPlacement)).toBe(
      scheduledTaskPlacementIdentity({
        ...localPlacement,
        capabilityReferences: [...localPlacement.capabilityReferences].reverse(),
      }),
    )
    expect(
      scheduledTaskPlacementNeedsReview(localPlacement, {
        ...localPlacement,
        executionAvailability: "background-device",
      }),
    ).toBe(true)
  })

  test("rejects a local target owned by Den", () => {
    expect(
      scheduledTaskPlacementSchema.safeParse({
        ...localPlacement,
        schedulerOwner: "den",
      }).success,
    ).toBe(false)
  })

  test("keeps local and Den filesystem authority target-relative", () => {
    expect(
      scheduledTaskFilesystemScopeSchema.safeParse({
        kind: "den-worker-relative-roots",
        roots: ["reports", "artifacts/daily"],
      }).success,
    ).toBe(true)
    expect(
      scheduledTaskFilesystemScopeSchema.safeParse({
        kind: "den-worker-relative-roots",
        roots: ["../outside"],
      }).success,
    ).toBe(false)
    expect(
      scheduledTaskGrantSchema.safeParse({
        id: "grant_remote",
        taskId: "task_remote",
        revision: 1,
        taskRevisionId: "rev_remote",
        workspaceId: "workspace_remote",
        placement: {
          target: {
            kind: "den-worker",
            organizationId: "org_remote",
            workerId: "worker_remote",
            workspaceId: "workspace_remote",
          },
          schedulerOwner: "den",
          executionAvailability: "cloud",
          executionPrincipal: {
            kind: "den-membership",
            organizationId: "org_remote",
            membershipId: "membership_remote",
          },
          capabilityReferences: [],
        },
        filesystemScope: {
          kind: "local-workspace-roots",
          roots: ["/must-not-cross-to-den"],
        },
        capabilityIds: [],
        actionClasses: ["read"],
        filesystem: { read: true, write: false },
        maximumRuntimeMs: 60_000,
        model: { providerId: null, modelId: null, agent: null },
        communicationPolicy: "deny",
        destructiveActionPolicy: "deny",
        selfModificationPolicy: "deny",
        grantor: "member_remote",
        reviewedAt: 1,
        expiresAt: null,
        revokedAt: null,
        revocationReason: null,
        createdAt: 1,
      }).success,
    ).toBe(false)
  })

  test("calculates daylight-saving occurrences without process timezone state", () => {
    const after = Date.UTC(2026, 9, 31, 12, 0)
    const next = nextScheduledTaskOccurrence(
      {
        kind: "daily",
        timezone: "America/New_York",
        hour: 1,
        minute: 30,
      },
      after,
    )
    expect(new Date(next ?? 0).toISOString()).toBe("2026-11-01T05:30:00.000Z")
  })

  test("defines explicit state transitions and terminal run states", () => {
    expect(canTransitionScheduledTask("draft", "ready")).toBe(true)
    expect(canTransitionScheduledTask("deleted", "ready")).toBe(false)
    expect(() => assertScheduledTaskTransition("deleted", "ready")).toThrow()
    expect(isTerminalScheduledTaskRunStatus("completed")).toBe(true)
    expect(isTerminalScheduledTaskRunStatus("running")).toBe(false)
  })

  test("selects due work and occurrence identities deterministically", () => {
    const first = scheduledTaskSchema.parse({
      id: "task_a",
      workspaceId: "ws_local",
      state: "enabled",
      enabled: true,
      draftRevisionId: "rev_1",
      activeRevisionId: "rev_1",
      activeGrantId: "grant_1",
      needsAttention: null,
      createdAt: 1,
      updatedAt: 1,
      deletedAt: null,
      nextRunAt: 10,
    })
    const later = scheduledTaskSchema.parse({
      ...first,
      id: "task_b",
      nextRunAt: 20,
    })
    expect(
      selectScheduledTasksForTick([later, first], {
        now: 20,
        source: "app",
        batchSize: 1,
      }).map((task) => task.id),
    ).toEqual(["task_a"])

    expect(
      scheduledTaskOccurrenceIdentity({
        taskId: "task_a",
        taskRevisionId: "rev_1",
        trigger: "scheduled",
        scheduledFor: 10,
      }),
    ).toEqual({
      occurrenceId: "occ_task_a_rev_1_scheduled_10",
      idempotencyKey: "scheduled:task_a:rev_1:10",
    })
  })
})
