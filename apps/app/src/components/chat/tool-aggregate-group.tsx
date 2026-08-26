"use client"

import { useState } from "react"
import { AlertTriangle, CirclePause, MoreHorizontal } from "lucide-react"

import { FileChip } from "@/components/chat/file-chip"
import { useCurrentToolLifecycleResolver } from "@/components/chat/current-tool-lifecycle-context"
import {
  getAggregateNowLabel,
  getAggregateCountSummary,
  getAggregateRowFile,
  getAggregateRowLabel,
  getAggregateSummary,
  type AnyToolPart,
} from "@/lib/tool-aggregate"
import { isToolPartInFlight } from "@/lib/tool-activity"
import { isBashToolPart } from "@/lib/build-in-tools"
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

function persistedRowStatus(part: AnyToolPart): "running" | "failed" | "done" {
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
  const latestToolCallId = parts.at(-1)?.toolCallId ?? groupKey
  const [expanded, setExpandedState] = useState(() => expandedByGroupKey.get(groupKey) ?? false)
  const [showAll, setShowAllState] = useState(() => showAllByGroupKey.get(groupKey) ?? false)
  const resolveLifecycle = useCurrentToolLifecycleResolver()

  const setExpanded = (value: boolean) => {
    expandedByGroupKey.set(groupKey, value)
    setExpandedState(value)
  }
  const setShowAll = (value: boolean) => {
    showAllByGroupKey.set(groupKey, value)
    setShowAllState(value)
  }

  const inFlightPart = parts.find((part) => isToolPartInFlight(part))
  const currentLifecycle = resolveLifecycle(
    inFlightPart?.toolCallId ?? "",
    Boolean(inFlightPart),
  )
  const anyRunning = parts.some((part) => isToolPartInFlight(part))
  const visiblyRunning = anyRunning
    && currentLifecycle !== "waiting"
    && currentLifecycle !== "interrupted"
  const failedCount = parts.filter((part) => part.state === "output-error").length
  const countSummary = getAggregateCountSummary(parts)
  const summary = currentLifecycle === "waiting"
    ? `Waiting for your action · ${countSummary}`
    : currentLifecycle === "interrupted"
      ? `Task interrupted · ${countSummary}`
      : getAggregateSummary(parts, visiblyRunning ? "present" : "past")
  const nowLabel = visiblyRunning ? getAggregateNowLabel(parts) : null

  // Track durations for every part so each is frozen the moment it completes.
  const durations = parts.map((part) => trackToolCallDuration(part))
  const singleCommand = parts.length === 1 && Boolean(parts[0] && isBashToolPart(parts[0]))
  const singleCommandDuration = singleCommand ? durations[0] : null
  const visibleParts = showAll ? parts : parts.slice(0, ROW_CAP)
  const hiddenCount = parts.length - visibleParts.length

  return (
    <div
      className={className}
      data-tool-aggregate={latestToolCallId}
      data-tool-lifecycle={currentLifecycle ?? (visiblyRunning ? "running" : "settled")}
    >
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        aria-expanded={expanded}
        className="group flex min-w-0 max-w-full cursor-pointer items-center gap-1.5 text-start text-sm text-muted-foreground transition-colors hover:text-foreground"
      >
        <span className="min-w-0 truncate">{summary}</span>
        {singleCommandDuration ? (
          <span className="shrink-0 tabular-nums text-xs text-muted-foreground/70">
            {singleCommandDuration}
          </span>
        ) : null}
        {failedCount > 0 ? (
          <span className="shrink-0 text-xs text-muted-foreground">
            {failedCount} failed
          </span>
        ) : null}
      </button>

      {currentLifecycle === "waiting" ? (
        <div className="mt-1 flex items-center gap-1.5 text-xs text-amber-11" role="status">
          <CirclePause aria-hidden="true" className="size-3.5 shrink-0" />
          <span>Choose an option or approve the request to continue.</span>
        </div>
      ) : null}

      {currentLifecycle === "interrupted" ? (
        <div className="mt-1 flex items-center gap-1.5 text-xs text-destructive" role="alert">
          <AlertTriangle aria-hidden="true" className="size-3.5 shrink-0" />
          <span>This step stopped before it finished. Retry to continue.</span>
        </div>
      ) : null}

      {nowLabel ? (
        <div data-tool-aggregate-now className="mt-1 min-w-0 text-sm text-muted-foreground">
          <span className="block min-w-0 truncate">
            <span className="ow-text-shimmer">Now: </span>
            {nowLabel}
          </span>
        </div>
      ) : null}

      {expanded ? (
        <div className="mt-1.5 flex flex-col gap-1">
          {visibleParts.map((part, index) => {
            const lifecycle = resolveLifecycle(part.toolCallId, isToolPartInFlight(part))
            const status = lifecycle ?? persistedRowStatus(part)
            const reason = failureReason(part)
            const bash = isBashToolPart(part)
            const command = bash ? part.input?.command?.trim() ?? "" : ""
            const commandDescription = bash
              ? part.input?.description?.trim() || "command"
              : ""
            return (
              <div key={part.toolCallId} className="flex min-w-0 flex-col gap-1.5 py-1">
                {!singleCommand ? (
                  <div className="flex min-w-0 items-center gap-2 text-sm text-muted-foreground">
                  {status === "waiting" ? (
                    <CirclePause aria-label="Waiting" className="size-3.5 shrink-0 text-amber-11" />
                  ) : null}
                  {status === "interrupted" ? (
                    <AlertTriangle aria-label="Interrupted" className="size-3.5 shrink-0 text-destructive" />
                  ) : null}
                  {bash ? (
                    <span className="min-w-0 truncate">
                      <span className={cn("text-foreground", status === "running" && "ow-text-shimmer")}>
                        {status === "running" ? "Running" : "Ran"}
                      </span>{" "}
                      <span>{commandDescription}</span>
                    </span>
                  ) : (() => {
                    const file = getAggregateRowFile(part)
                    if (!file) {
                      return (
                        <span className="min-w-0 truncate">
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
                ) : null}
                {bash && command ? (
                  <div
                    data-tool-aggregate-command
                    className="flex min-w-0 items-center gap-2 rounded-xl border border-border/70 bg-background px-3 py-2 font-mono text-sm shadow-xs"
                  >
                    <span className="shrink-0 text-muted-foreground/60">$</span>
                    <code className="min-w-0 flex-1 truncate text-blue-11">{command}</code>
                    <MoreHorizontal aria-hidden="true" className="size-4 shrink-0 text-muted-foreground/70" />
                  </div>
                ) : null}
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
