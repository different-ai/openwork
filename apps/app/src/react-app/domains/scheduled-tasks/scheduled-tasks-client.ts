import type { OpenworkServerClient } from "@/app/lib/openwork-server";
import type {
  ScheduledTask,
  ScheduledTaskGrant,
  ScheduledTaskRevision,
  ScheduledTaskRun,
} from "@openwork/types/scheduled-tasks";

export type ScheduledTaskListItem = {
  task: ScheduledTask;
  revision: ScheduledTaskRevision;
  grant?: ScheduledTaskGrant | null;
  latestRun?: ScheduledTaskRun | null;
};

export type ScheduledTaskDetail = {
  task: ScheduledTask;
  draftRevision: ScheduledTaskRevision;
  activeRevision: ScheduledTaskRevision | null;
  grant: ScheduledTaskGrant | null;
  runs: ScheduledTaskRun[];
};

export type ScheduledTasksClient = Pick<
  OpenworkServerClient,
  | "baseUrl"
  | "capabilities"
  | "cancelScheduledTaskRun"
  | "createScheduledTaskDraft"
  | "deleteScheduledTask"
  | "downloadScheduledTaskArtifact"
  | "duplicateScheduledTask"
  | "enableScheduledTask"
  | "getScheduledTask"
  | "getScheduledTaskRunReceipt"
  | "listScheduledTasks"
  | "pauseScheduledTask"
  | "previewScheduledTaskSchedule"
  | "resumeScheduledTask"
  | "reviewScheduledTaskGrant"
  | "revokeScheduledTaskGrant"
  | "runScheduledTaskOnce"
  | "tickScheduledTaskScheduler"
  | "updateScheduledTaskDraft"
>;
