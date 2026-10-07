import { automationOccurrencesInRange } from "@openwork/types/automation-schedule"
import type { AutomationList, AutomationRun } from "@openwork/types/automations"

import { MINUTE_MS } from "./calendar-time"

type AutomationListItem = AutomationList["items"][number]

/**
 * What a block in the Automations layer means:
 * - succeeded / failed / cancelled / skipped / running: a real run receipt;
 * - upcoming: a slot of an active Automation that Den will run;
 * - blocked: a slot of an Automation that needs attention. Den cleared its
 *   next run, so the slot is nominal and must not read as a confirmed run.
 * Paused (inactive) Automations show past receipts only.
 */
export type AutomationCalendarStatus = "succeeded" | "failed" | "cancelled" | "skipped" | "running" | "upcoming" | "blocked"

export type AutomationCalendarItem = {
  key: string
  automationId: string
  name: string
  /** Where the block sits: the scheduled slot, else when the run started or was created. */
  at: number
  /** Visual end for layout; real duration for finished runs, a fixed slot otherwise. */
  end: number
  status: AutomationCalendarStatus
  run: AutomationRun | null
  executionTarget: "desktop" | "cloud"
  trigger: AutomationRun["trigger"] | "schedule"
}

/** Minimum block height in minutes so short runs stay clickable. */
export const AUTOMATION_BLOCK_MINUTES = 30
const ACTIVE = new Set<AutomationRun["status"]>(["queued", "claimed", "running"])

function runStatus(run: AutomationRun): AutomationCalendarStatus {
  if (ACTIVE.has(run.status)) return "running"
  if (run.status === "succeeded" || run.status === "failed" || run.status === "cancelled" || run.status === "skipped") return run.status
  return "running"
}

export function runPlacement(run: AutomationRun): number {
  return run.scheduledFor ?? run.startedAt ?? run.createdAt
}

function runEnd(run: AutomationRun, at: number): number {
  const duration = run.startedAt !== null && run.finishedAt !== null ? run.finishedAt - run.startedAt : 0
  return at + Math.max(duration, AUTOMATION_BLOCK_MINUTES * MINUTE_MS)
}

/**
 * Reconciles schedule slots with real run receipts for one visible range.
 *
 * Past time is never treated as evidence that something ran: a past slot
 * appears only when Den recorded a run for it. Future slots come from the
 * current revision's schedule using the scheduler's own resolver, and only
 * for active (upcoming) or needs-attention (blocked) Automations.
 */
export function buildAutomationCalendarItems(input: {
  automations: readonly AutomationListItem[]
  runs: readonly AutomationRun[]
  range: { start: number; end: number }
  now: number
}): AutomationCalendarItem[] {
  const items: AutomationCalendarItem[] = []
  const runsByAutomation = new Map<string, AutomationRun[]>()
  for (const run of input.runs) {
    const list = runsByAutomation.get(run.automationId) ?? []
    list.push(run)
    runsByAutomation.set(run.automationId, list)
  }
  for (const { automation, revision } of input.automations) {
    if (automation.state === "archived") continue
    const target = revision.executionTarget ?? "desktop"
    const runs = runsByAutomation.get(automation.id) ?? []
    const occupiedSlots = new Set<number>()
    for (const run of runs) {
      const at = runPlacement(run)
      if (at < input.range.start || at >= input.range.end) continue
      if (run.scheduledFor !== null) occupiedSlots.add(run.scheduledFor)
      items.push({
        key: `run:${run.id}`,
        automationId: automation.id,
        name: automation.name,
        at,
        end: runEnd(run, at),
        status: runStatus(run),
        run,
        executionTarget: run.executionTarget,
        trigger: run.trigger,
      })
    }
    if (automation.state !== "active" && automation.state !== "needs_attention") continue
    // Slots start at the later of now and the range start; the past is receipts only.
    const from = Math.max(input.range.start, input.now, automation.createdAt)
    if (from >= input.range.end) continue
    const { occurrences } = automationOccurrencesInRange(revision.schedule, { from, to: input.range.end, limit: 500 })
    for (const slot of occurrences) {
      if (occupiedSlots.has(slot)) continue
      items.push({
        key: `slot:${automation.id}:${slot}`,
        automationId: automation.id,
        name: automation.name,
        at: slot,
        end: slot + AUTOMATION_BLOCK_MINUTES * MINUTE_MS,
        status: automation.state === "active" ? "upcoming" : "blocked",
        run: null,
        executionTarget: target,
        trigger: "schedule",
      })
    }
  }
  return items.sort((left, right) => left.at - right.at || left.name.localeCompare(right.name))
}

export function formatRunDuration(run: Pick<AutomationRun, "startedAt" | "finishedAt">): string | null {
  if (run.startedAt === null || run.finishedAt === null || run.finishedAt < run.startedAt) return null
  const seconds = Math.round((run.finishedAt - run.startedAt) / 1_000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  const rest = seconds % 60
  if (minutes < 60) return rest ? `${minutes}m ${rest}s` : `${minutes}m`
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`
}

/** One-line outcome for a past run, e.g. "Completed in 1m 42s" or the error message. */
export function describeRunOutcome(run: AutomationRun): string {
  const duration = formatRunDuration(run)
  if (run.status === "succeeded") return duration ? `Completed in ${duration}` : "Completed"
  if (run.status === "queued" || run.status === "claimed") return "Waiting to start"
  if (run.status === "running") return "Running"
  if (run.status === "cancelled") return "Cancelled"
  if (run.status === "skipped") return run.error?.code === "runner_unavailable" ? "Missed: no computer was available" : run.error?.message ?? "Skipped"
  return run.error?.message ?? "Failed"
}
