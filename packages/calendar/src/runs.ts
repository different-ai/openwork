import type { AutomationList, AutomationRun } from "@openwork/types/automations"

import { runPlacement } from "./automation-items"

type AutomationListItem = AutomationList["items"][number]
type RunPage = { items: AutomationRun[]; nextCursor: string | null }

/**
 * Where an app reads Automation runs: Den directly (desktop) or through a host
 * that forwards to Den (Workbot). Both speak Den's run routes.
 */
export type AutomationRunsSource = {
  listRunsInRange(input: { from: number; to: number; cursor?: string; limit?: number }): Promise<RunPage>
  listRuns(automationId: string, input: { limit: number }): Promise<RunPage>
}

export type RunsInRange = {
  runs: AutomationRun[]
  complete: boolean
  source: "range" | "per_automation"
}

const RANGE_PAGE_LIMIT = 200
const RANGE_MAX_PAGES = 10
const FALLBACK_MAX_AUTOMATIONS = 30
const FALLBACK_CONCURRENCY = 4

function isNotFound(error: unknown): boolean {
  return error instanceof Error && "status" in error && error.status === 404
}

/** Every run placed in [start, end): the range route, else newest 100 runs per Automation (bounded N+1). */
export async function readRunsInRange(
  source: AutomationRunsSource,
  range: { start: number; end: number },
  automations: readonly AutomationListItem[],
): Promise<RunsInRange> {
  try {
    const runs: AutomationRun[] = []
    let cursor: string | undefined
    for (let page = 0; page < RANGE_MAX_PAGES; page += 1) {
      const result = await source.listRunsInRange({ from: range.start, to: range.end, cursor, limit: RANGE_PAGE_LIMIT })
      runs.push(...result.items)
      if (!result.nextCursor) return { runs, complete: true, source: "range" }
      cursor = result.nextCursor
    }
    return { runs, complete: false, source: "range" }
  } catch (error) {
    if (!isNotFound(error)) throw error
  }
  const live = automations.filter((item) => item.automation.state !== "archived")
  const selected = live.slice(0, FALLBACK_MAX_AUTOMATIONS)
  const runs: AutomationRun[] = []
  let complete = selected.length === live.length
  for (let index = 0; index < selected.length; index += FALLBACK_CONCURRENCY) {
    const batch = await Promise.all(selected.slice(index, index + FALLBACK_CONCURRENCY).map((item) => source.listRuns(item.automation.id, { limit: 100 })))
    for (const page of batch) {
      runs.push(...page.items.filter((run) => {
        const at = runPlacement(run)
        return at >= range.start && at < range.end
      }))
      const oldest = page.items.at(-1)
      if (page.nextCursor && oldest && runPlacement(oldest) >= range.start) complete = false
    }
  }
  return { runs, complete, source: "per_automation" }
}
