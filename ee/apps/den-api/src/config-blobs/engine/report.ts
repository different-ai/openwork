import type { ConfigApplyReport, ConfigApplyReportItem } from "@openwork/types/den/config-blobs"
import { countApplyItems } from "./execute.js"

export const CONFIG_APPLY_INTERRUPTED_CODE = "interrupted"

export function summarizeReport(report: ConfigApplyReport): ConfigApplyReport {
  const failed = report.items.find((item) => item.status === "failed")
  return {
    ...report,
    counts: countApplyItems(report.items),
    failure: failed?.failure ? { area: failed.area, ref: failed.ref, name: failed.name, failure: failed.failure } : null,
  }
}

export function isInFlight(item: Pick<ConfigApplyReportItem, "status" | "startedAt">): boolean {
  return item.status === "not_reached" && item.startedAt !== null
}

export function interruptReport(report: ConfigApplyReport, at: Date, message: string): ConfigApplyReport {
  const items = report.items.map((item): ConfigApplyReportItem => (isInFlight(item)
    ? { ...item, status: "failed", failure: { code: CONFIG_APPLY_INTERRUPTED_CODE, message } }
    : item))
  return summarizeReport({ ...report, items, status: "interrupted", finishedAt: report.finishedAt ?? at.toISOString() })
}
