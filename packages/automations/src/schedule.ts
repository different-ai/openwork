/**
 * Schedule resolution lives in @openwork/types so the scheduler, previews and
 * client calendar views share one implementation.
 */
// Named re-exports keep these symbols in tsup's production ESM export table.
// A nested export * from an external package becomes only a runtime namespace.
export {
  AUTOMATION_DAY_MS,
  AUTOMATION_OCCURRENCE_RANGE_DEFAULT_LIMIT,
  AUTOMATION_OCCURRENCE_RANGE_MAX_DAYS,
  assertAutomationTimezone,
  automationOccurrences,
  automationOccurrencesInRange,
  nextAutomationOccurrence,
  previewAutomationSchedule,
  recoverableAutomationOccurrence,
  type AutomationOccurrenceRangeOptions,
  type AutomationOccurrenceSearchOptions,
} from "@openwork/types/automation-schedule"
