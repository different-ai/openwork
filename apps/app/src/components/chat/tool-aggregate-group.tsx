"use client"

import { useState } from "react"
import { ChevronRight } from "lucide-react"

import { FileChip } from "@/components/chat/file-chip"
import { DotMatrixLoader } from "@/components/ui/dot-matrix-loader"
import {
  getAggregateNowLabel,
  getAggregateRowFile,
  getAggregateRowLabel,
  getAggregateSummary,
  type AnyToolPart,
} from "@/lib/tool-aggregate"
import { isToolPartInFlight } from "@/lib/tool-activity"
import { trackToolCallDuration } from "@/lib/tool-call-duration"
import { cn } from "@/lib/utils"

const ROW_CAP = 8

/** Expansion persists per group while the session stays mounted (Paper rule). */
const expandedByGroupKey = new Map<string, boolean>()
const showAllByGroupKey = new Map<string, boolean>()

type ToolAggregateGroupProps = {
  parts: AnyToolPart[]
  className?: string
}

function rowStatus(part: AnyToolPart): "running" | "failed" | "done" {
  if (isToolPartInFlight(part)) return "running"
  if (part.state === "output-error") return "failed"
  return "done"
}

function failureReason(part: AnyToolPart): string | null {
  if (part.state !== "output-error" || !part.errorText) return null
  const firstLine = part.errorText.split("\n")[0]?.trim()
  return firstLine ? (firstLine.length > 120 ? `${firstLine.slice(0, 119)}…` : firstLine) : null
}

/**
 * Paper "Recurring actions · aggregate + latest": one line with live
 * totals while running plus a self-replacing "Now:" line; past-tense
 * summary when done. Chevron expands the chronological list — status
 * dot, monospace action, per-item duration — capped with "Show N more".
 */
export function ToolAggregateGroup({ parts, className }: ToolAggregateGroupProps) {
  const groupKey = parts[0]?.toolCallId ?? "aggregate"
  const [expanded, setExpandedState] = useState(() => expandedByGroupKey.get(groupKey) ?? false)
  const [showAll, setShowAllState] = useState(() => showAllByGroupKey.get(groupKey) ?? false)

  const setExpanded = (value: boolean) => {
    expandedByGroupKey.set(groupKey, value)
    setExpandedState(value)
  }
  const setShowAll = (value: boolean) => {
    showAllByGroupKey.set(groupKey, value)
    setShowAllState(value)
  }

  const anyRunning = parts.some((part) => isToolPartInFlight(part))
  const failedCount = parts.filter((part) => part.state === "output-error").length
  const summary = getAggregateSummary(parts, anyRunning ? "present" : "past")
  const nowLabel = anyRunning ? getAggregateNowLabel(parts) : null

  // Track durations for every part so each is frozen the moment it completes.
  const durations = parts.map((part) => trackToolCallDuration(part))
  const visibleParts = showAll ? parts : parts.slice(0, ROW_CAP)
  const hiddenCount = parts.length - visibleParts.length

  return (
    <div className={className} data-tool-aggregate={groupKey}>
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        aria-expanded={expanded}
        className="group flex min-w-0 max-w-full cursor-pointer items-center gap-1.5 text-start text-sm text-muted-foreground transition-colors hover:text-foreground"
      >
        <ChevronRight
          aria-hidden="true"
          className={cn(
            "size-3.5 shrink-0 text-muted-foreground/70 transition-transform duration-150",
            expanded && "rotate-90",
          )}
        />
        <span className="min-w-0 truncate">{summary}</span>
        {failedCount > 0 ? (
          <span className="shrink-0 text-xs text-muted-foreground">
            {failedCount} failed
          </span>
        ) : null}
      </button>

      {nowLabel ? (
        <div className="mt-1 flex min-w-0 items-center gap-2 ps-5 text-sm text-muted-foreground">
          <DotMatrixLoader label={nowLabel} className="text-muted-foreground" />
          <span className="min-w-0 truncate">
            <span className="text-muted-foreground/70">Now: </span>
            {nowLabel}
          </span>
        </div>
      ) : null}

      {expanded ? (
        <div className="mt-1.5 flex flex-col gap-1 ps-5">
          {visibleParts.map((part, index) => {
            const status = rowStatus(part)
            const reason = failureReason(part)
            return (
              <div key={part.toolCallId} className="flex min-w-0 flex-col gap-0.5">
                <div className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
                  {status === "running" ? (
                    <span className="flex size-3.5 shrink-0 items-center justify-center">
                      <DotMatrixLoader label="Running" className="size-3 text-muted-foreground" />
                    </span>
                  ) : null}
                  {(() => {
                    const file = getAggregateRowFile(part)
                    if (!file) {
                      return (
                        <span className="min-w-0 truncate font-mono text-[11px]">
                          {getAggregateRowLabel(part)}
                        </span>
                      )
                    }
                    return (
                      <span className="flex min-w-0 items-center gap-1.5">
                        <span className="shrink-0">{file.verb}</span>
                        <FileChip path={file.path} className="min-w-0" />
                      </span>
                    )
                  })()}
                  {durations[index] ? (
                    <span className="shrink-0 tabular-nums text-muted-foreground/70">
                      {durations[index]}
                    </span>
                  ) : null}
                </div>
                {reason ? (
                  <div className="text-[11px] text-muted-foreground">failed — {reason}</div>
                ) : null}
              </div>
            )
          })}
          {hiddenCount > 0 ? (
            <button
              type="button"
              onClick={() => setShowAll(true)}
              className="w-fit text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
            >
              Show {hiddenCount} more
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
