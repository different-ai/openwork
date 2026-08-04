import type {
  ScheduledTaskRunStatus,
  ScheduledTaskState,
} from "@openwork/types/scheduled-tasks"

const transitions: Readonly<Record<ScheduledTaskState, readonly ScheduledTaskState[]>> = {
  draft: ["ready", "deleted"],
  ready: ["enabled", "paused", "deleted"],
  enabled: ["paused", "needs-attention", "deleted"],
  paused: ["ready", "enabled", "needs-attention", "deleted"],
  "needs-attention": ["paused", "ready", "deleted"],
  deleted: [],
}

const terminalRunStatuses = new Set<ScheduledTaskRunStatus>([
  "completed",
  "failed",
  "cancelled",
  "needs-attention",
  "missed",
  "skipped-overlap",
  "ambiguous",
])

export function canTransitionScheduledTask(
  from: ScheduledTaskState,
  to: ScheduledTaskState,
): boolean {
  return from === to || transitions[from].includes(to)
}

export function assertScheduledTaskTransition(
  from: ScheduledTaskState,
  to: ScheduledTaskState,
): void {
  if (!canTransitionScheduledTask(from, to)) {
    throw new Error(`Invalid scheduled-task transition: ${from} -> ${to}`)
  }
}

export function isTerminalScheduledTaskRunStatus(
  status: ScheduledTaskRunStatus,
): boolean {
  return terminalRunStatuses.has(status)
}
