export {
  SCHEDULED_TASK_DAY_MS,
  assertScheduledTaskTimezone,
  nextScheduledTaskOccurrence,
  previewScheduledTaskSchedule,
  scheduledTaskOccurrences,
  type ScheduledTaskOccurrenceSearchOptions,
} from "@openwork/scheduled-tasks";

import {
  scheduledTaskOccurrenceIdentity,
  type ScheduledTaskOccurrenceIdentityInput,
} from "@openwork/scheduled-tasks";

/** @deprecated Use scheduledTaskOccurrenceIdentity from the shared package. */
export function scheduledTaskOccurrenceId(
  input: ScheduledTaskOccurrenceIdentityInput,
): string {
  return scheduledTaskOccurrenceIdentity(input).occurrenceId;
}
