/**
 * Apply report helpers (one report per apply attempt, stored on
 * `config_apply_run`). Pure.
 */
import type { ConfigApplyReport, ConfigApplyReportItem } from "@openwork/types/den/config-blobs"
import { countApplyItems } from "./execute.js"

export const CONFIG_APPLY_INTERRUPTED_CODE = "interrupted"

/** The report with `counts` and the top-level `failure` (first failed item) recomputed from its items. */
export function summarizeReport(report: ConfigApplyReport): ConfigApplyReport {
  const failed = report.items.find((item) => item.status === "failed")
  return {
    ...report,
    counts: countApplyItems(report.items),
    failure: failed?.failure ? { area: failed.area, ref: failed.ref, name: failed.name, failure: failed.failure } : null,
  }
}

/** An item that started and never finished: the worker died or lost its lease mid-write. */
export function isInFlight(item: Pick<ConfigApplyReportItem, "status" | "startedAt">): boolean {
  return item.status === "not_reached" && item.startedAt !== null
}

/** A run whose worker stopped: in-flight items failed with code "interrupted", the run `interrupted`. */
export function interruptReport(report: ConfigApplyReport, at: Date, message: string): ConfigApplyReport {
  const items = report.items.map((item): ConfigApplyReportItem => (isInFlight(item)
    ? { ...item, status: "failed", failure: { code: CONFIG_APPLY_INTERRUPTED_CODE, message } }
    : item))
  return summarizeReport({ ...report, items, status: "interrupted", finishedAt: report.finishedAt ?? at.toISOString() })
}
