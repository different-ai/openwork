import type { ScheduledTask, ScheduledTaskRun } from "@openwork/types/scheduled-tasks"
import {
  localWorkspaceIdForScheduledTaskScope,
  type ScheduledTaskRepositoryFilter,
} from "./contracts.js"

export type ScheduledTaskTickSource =
  | "app"
  | "os-wake"
  | "vercel-cron"
  | "den-loop"
  | "manual"

export const scheduledTaskTickSourceValues: readonly ScheduledTaskTickSource[] = [
  "app",
  "os-wake",
  "vercel-cron",
  "den-loop",
  "manual",
]

export interface ScheduledTaskTickInput {
  now: number
  source: ScheduledTaskTickSource
  workspaceId?: string
  scope?: ScheduledTaskRepositoryFilter
  batchSize?: number
}

export interface ScheduledTaskTickResult {
  processedAt: number
  source: ScheduledTaskTickSource
  selectedTaskIds: string[]
  claimedRunIds: string[]
  nextDueAt: number | null
}

export interface ScheduledTaskTickPort {
  tick(input: ScheduledTaskTickInput): Promise<ScheduledTaskTickResult>
}

export function selectScheduledTasksForTick(
  tasks: readonly ScheduledTask[],
  input: ScheduledTaskTickInput,
): ScheduledTask[] {
  const batchSize = Math.max(1, Math.min(Math.floor(input.batchSize ?? 100), 500))
  const scopedWorkspaceId = localWorkspaceIdForScheduledTaskScope(
    input.scope ?? input.workspaceId,
  )
  if (scopedWorkspaceId === null) return []
  return tasks
    .filter(
      (task) =>
        task.deletedAt === null &&
        task.enabled &&
        task.state === "enabled" &&
        task.nextRunAt !== null &&
        task.nextRunAt <= input.now &&
        (scopedWorkspaceId === undefined || task.workspaceId === scopedWorkspaceId),
    )
    .sort(
      (left, right) =>
        (left.nextRunAt ?? 0) - (right.nextRunAt ?? 0) ||
        left.id.localeCompare(right.id),
    )
    .slice(0, batchSize)
}

export interface ScheduledTaskOccurrenceIdentityInput {
  taskId: string
  taskRevisionId: string
  trigger: ScheduledTaskRun["trigger"]
  scheduledFor: number | null
  nonce?: string
}

export interface ScheduledTaskOccurrenceIdentity {
  occurrenceId: string
  idempotencyKey: string
}

export function scheduledTaskOccurrenceIdentity(
  input: ScheduledTaskOccurrenceIdentityInput,
): ScheduledTaskOccurrenceIdentity {
  if (input.scheduledFor === null && !input.nonce) {
    throw new Error("A manual or recovery occurrence without a scheduled time needs a nonce")
  }
  const occurrence = input.scheduledFor === null
    ? input.nonce
    : String(input.scheduledFor)
  const occurrenceId = `occ_${input.taskId}_${input.taskRevisionId}_${input.trigger}_${occurrence}`
  const idempotencyKey = input.scheduledFor === null
    ? `manual:${input.taskId}:${input.taskRevisionId}:${occurrence}`
    : `${input.trigger}:${input.taskId}:${input.taskRevisionId}:${input.scheduledFor}`
  return { occurrenceId, idempotencyKey }
}
