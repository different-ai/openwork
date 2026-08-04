export type {
  ScheduledTaskCancellationReason,
  ScheduledTaskCancellationRequest,
  ScheduledTaskCancellationResult,
  ScheduledTaskExecutionAdapter,
  ScheduledTaskExecutionOptions,
} from "@openwork/scheduled-tasks";

export const SCHEDULED_TASK_WORKSPACE_READ_CAPABILITY_ID =
  "workspace.files.read" as const;
export const SCHEDULED_TASK_WORKSPACE_WRITE_CAPABILITY_ID =
  "workspace.files.write" as const;
export const SCHEDULED_TASK_SAFE_WRITE_TOOL_ID =
  "openwork_workspace_write_file" as const;

export const SCHEDULED_TASK_SAFE_LOCAL_CAPABILITY_IDS = [
  SCHEDULED_TASK_WORKSPACE_READ_CAPABILITY_ID,
  SCHEDULED_TASK_WORKSPACE_WRITE_CAPABILITY_ID,
] as const;

const scheduledTaskSafeLocalCapabilityIds = new Set<string>(
  SCHEDULED_TASK_SAFE_LOCAL_CAPABILITY_IDS,
);

export type ScheduledTaskCapabilityGrantValidation =
  | { ok: true }
  | { ok: false; unsupportedCapabilityIds: string[] };

export function validateScheduledTaskCapabilityGrant(
  capabilityIds: readonly string[],
): ScheduledTaskCapabilityGrantValidation {
  const unsupportedCapabilityIds = [
    ...new Set(
      capabilityIds.filter(
        (capabilityId) => !scheduledTaskSafeLocalCapabilityIds.has(capabilityId),
      ),
    ),
  ].sort();
  return unsupportedCapabilityIds.length === 0
    ? { ok: true }
    : { ok: false, unsupportedCapabilityIds };
}
