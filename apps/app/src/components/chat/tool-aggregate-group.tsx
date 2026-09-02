"use client"

import { Fragment, useState } from "react"
import { AlertTriangle, Check, ChevronUp, CircleHelp, CirclePause, Copy, MoreHorizontal } from "lucide-react"

import { FileChip } from "@/components/chat/file-chip"
import { ShellCommandText } from "@/components/chat/shell-command-text"
import { ReasoningBlock } from "@/components/chat/reasoning-block"
import { useCurrentToolLifecycleResolver } from "@/components/chat/current-tool-lifecycle-context"
import { Button } from "@/components/ui/button"
import {
  getAggregateNowPart,
  getAggregateCountSummary,
  getToolAggregateLifecycle,
  getAggregateRowFile,
  getAggregateRowLabel,
  getAggregateRowSearch,
  getAggregateSummary,
  getToolFamily,
  type AggregateThought,
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
  /** Thoughts that happened inside the run, anchored by afterIndex. */
  thoughts?: AggregateThought[]
  className?: string
}

function persistedRowStatus(part: AnyToolPart): "running" | "failed" | "done" {
  if (isToolPartInFlight(part)) return "running"
  if (part.state === "output-error") return "failed"
  return "done"
}

function failureText(part: AnyToolPart): string | null {
  if (part.state !== "output-error" || !part.errorText) return null
  const text = part.errorText.trim()
  return text || null
}

type DetailBoxProps = {
  kind: "command" | "pattern" | "error"
  text: string
  expanded: boolean
  onToggle: () => void
}

function CopyCommandButton({ command }: { command: string }) {
  const [copied, setCopied] = useState(false)
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(command)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 2000)
    } catch {
      // Clipboard access can be unavailable outside a secure browser context.
    }
  }
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-xs"
      className="mr-1.5 mt-1.5 shrink-0 text-muted-foreground/70"
      data-tool-aggregate-copy=""
      title={copied ? "Copied" : "Copy command"}
      aria-label={copied ? "Command copied" : "Copy command"}
      onClick={() => void copy()}
    >
      {copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
    </Button>
  )
}

/**
 * Monospace detail (a command, a search pattern, an error) shown as one
 * clipped line; clicking reveals the whole text, wrapped inside a bounded
 * scroll box, so nothing in an expanded tool group is ever unreadable and
 * a long script never swallows the thread. A full command can be copied.
 */
export function DetailBox({ kind, text, expanded, onToggle }: DetailBoxProps) {
  const noun = kind === "command" ? "command" : kind === "pattern" ? "search pattern" : "error"
  const textClassName = cn(
    "min-w-0 flex-1 break-all",
    expanded ? "max-h-60 overflow-y-auto whitespace-pre-wrap" : "line-clamp-1",
  )
  return (
    <div
      className={cn(
        "flex min-w-0 max-w-full rounded-xl border font-mono transition-colors",
        expanded ? "items-start" : "items-center",
        kind === "error"
          ? "border-destructive/30 bg-destructive/5 text-xs text-destructive hover:border-destructive/50"
          : "border-border/70 bg-gray-2/60 text-sm hover:border-border hover:bg-gray-3/60",
      )}
    >
      <button
        type="button"
        data-tool-aggregate-detail={kind}
        data-tool-aggregate-command={kind === "command" ? "" : undefined}
        data-command-expanded={expanded ? "true" : "false"}
        aria-expanded={expanded}
        aria-label={expanded ? `Collapse ${noun}` : `Show full ${noun}`}
        onClick={onToggle}
        className={cn(
          "flex min-w-0 flex-1 cursor-pointer gap-2 rounded-xl px-3 py-2 text-start",
          expanded ? "items-start [&>svg]:mt-0.5" : "items-center",
        )}
      >
        {kind === "command" ? (
          <>
            <span className="shrink-0 text-muted-foreground/60">$</span>
            <ShellCommandText command={text} className={textClassName} />
          </>
        ) : (
          <code className={textClassName}>{text}</code>
        )}
        {expanded ? (
          <ChevronUp aria-hidden="true" className="size-4 shrink-0 text-muted-foreground/70" />
        ) : (
          <MoreHorizontal aria-hidden="true" className="size-4 shrink-0 text-muted-foreground/70" />
        )}
      </button>
      {expanded && kind === "command" ? <CopyCommandButton command={text} /> : null}
    </div>
  )
}

type AggregateRow = {
  /** The most recent call in the row (drives status, label, key). */
  part: AnyToolPart
  /** Original index of the row's first call — anchors interleaved thoughts. */
  index: number
  /** Original index of the row's latest call — picks its frozen duration. */
  lastIndex: number
  /** How many identical calls this row represents. */
  repeat: number
}

/**
 * The header summary counts unique files ("Read 1 file"), so repeated
 * settled reads of the same file collapse into one row with a ×N badge
 * instead of rendering as confusing duplicates. A thought anchored
 * between two reads keeps them apart to preserve chronology.
 */
export function buildAggregateRows(parts: AnyToolPart[], thoughts: AggregateThought[]): AggregateRow[] {
  const hasThoughtAt = (index: number) => thoughts.some((thought) => thought.afterIndex === index)
  const rows: AggregateRow[] = []
  parts.forEach((part, index) => {
    const previous = rows.at(-1)
    const file = getAggregateRowFile(part)
    const previousFile = previous ? getAggregateRowFile(previous.part) : null
    const mergeable =
      previous !== undefined &&
      file !== null &&
      previousFile !== null &&
      getToolFamily(part) === "read" &&
      getToolFamily(previous.part) === "read" &&
      file.path === previousFile.path &&
      persistedRowStatus(part) === "done" &&
      persistedRowStatus(previous.part) === "done" &&
      !hasThoughtAt(index)
    if (mergeable) {
      previous.part = part
      previous.lastIndex = index
      previous.repeat += 1
      return
    }
    rows.push({ part, index, lastIndex: index, repeat: 1 })
  })
  return rows
}

/**
 * Paper "Recurring actions · aggregate + latest": one line with live
 * totals while running plus a self-replacing shimmer line naming the
 * current action; past-tense summary when done. Chevron expands the chronological list — status
 * dot, monospace action, per-item duration — capped with "Show N more".
 */
export function ToolAggregateGroup({ parts, thoughts = [], className }: ToolAggregateGroupProps) {
  const groupKey = parts[0]?.toolCallId ?? "aggregate"
  const latestToolCallId = parts.at(-1)?.toolCallId ?? groupKey
  const [expanded, setExpandedState] = useState(() => expandedByGroupKey.get(groupKey) ?? false)
  const [showAll, setShowAllState] = useState(() => showAllByGroupKey.get(groupKey) ?? false)
  // Which detail boxes (command / pattern / error, per call) show full text.
  const [fullDetailKeys, setFullDetailKeys] = useState<ReadonlySet<string>>(() => new Set())
  const resolveLifecycle = useCurrentToolLifecycleResolver()

  const detailKey = (toolCallId: string, kind: DetailBoxProps["kind"]) => `${toolCallId}:${kind}`
  const detailBox = (kind: DetailBoxProps["kind"], toolCallId: string, text: string) => {
    const key = detailKey(toolCallId, kind)
    return (
      <DetailBox
        kind={kind}
        text={text}
        expanded={fullDetailKeys.has(key)}
        onToggle={() =>
          setFullDetailKeys((current) => {
            const next = new Set(current)
            if (next.has(key)) next.delete(key)
            else next.add(key)
            return next
          })
        }
      />
    )
  }

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
  const aggregateLifecycle = getToolAggregateLifecycle(parts, currentLifecycle)
  const visiblyRunning = aggregateLifecycle === "running"
  const failedCount = parts.filter((part) => part.state === "output-error").length
  const countSummary = getAggregateCountSummary(parts)
  const summary = aggregateLifecycle === "waiting"
    ? `Waiting for your action · ${countSummary}`
    : aggregateLifecycle === "unknown"
      ? `Status unknown · ${countSummary}`
      : getAggregateSummary(parts, visiblyRunning ? "present" : "past")
  const nowPart = visiblyRunning ? getAggregateNowPart(parts) : null
  const nowLabel = nowPart ? getAggregateRowLabel(nowPart) : null
  // A running command is clipped to one line; double-clicking swaps that
  // line for the same scrollable, copyable box the history uses, so the
  // whole command is readable while it is still running.
  const nowCommand = nowPart && isBashToolPart(nowPart) ? nowPart.input?.command?.trim() ?? "" : ""
  const nowCommandShown = Boolean(nowPart && nowCommand && fullDetailKeys.has(detailKey(nowPart.toolCallId, "command")))
  // The model is thinking mid-run: no tool is in flight but the run's
  // latest thought is still streaming. Show that instead of dead air.
  const lastThought = thoughts.at(-1)
  const thinkingNow = !nowLabel && Boolean(lastThought?.isStreaming)

  // Track durations for every part so each is frozen the moment it completes.
  const durations = parts.map((part) => trackToolCallDuration(part))
  const singleCommand = parts.length === 1 && Boolean(parts[0] && isBashToolPart(parts[0]))
  const singleCommandDuration = singleCommand ? durations[0] : null
  const rows = buildAggregateRows(parts, thoughts)
  const visibleRows = showAll ? rows : rows.slice(0, ROW_CAP)
  const hiddenCount = rows.length - visibleRows.length
  // Expanded rows interleave the run's thoughts at their chronological
  // slots; thoughts belonging to capped rows stay behind "Show N more".
  const thoughtsAt = (index: number) => thoughts.filter((thought) => thought.afterIndex === index)
  const trailingThoughts = hiddenCount > 0 ? [] : thoughts.filter((thought) => thought.afterIndex >= parts.length)

  // "Edited 1 file" above "Edited file-chip.tsx" says nothing twice.
  // A group that is exactly one file action (and no thoughts) renders
  // as the row itself — verb, chip, duration — with nothing to expand.
  const soloRow = rows.length === 1 && thoughts.length === 0 ? rows[0] : undefined
  const soloFile = soloRow ? getAggregateRowFile(soloRow.part) : null
  if (soloRow && soloFile) {
    const status = currentLifecycle ?? persistedRowStatus(soloRow.part)
    const failure = failureText(soloRow.part)
    return (
      <div
        className={className}
        data-tool-aggregate={latestToolCallId}
        data-tool-lifecycle={currentLifecycle ?? (visiblyRunning ? "running" : "settled")}
      >
        <div className="flex min-w-0 items-center gap-2 text-sm text-muted-foreground">
          <span className={cn("shrink-0", status === "running" && "text-foreground ow-text-shimmer")}>
            {soloFile.verb}
          </span>
          <FileChip path={soloFile.path} className="min-w-0" />
          {soloRow.repeat > 1 ? (
            <span data-tool-aggregate-repeat className="shrink-0 text-xs text-muted-foreground/70">
              ×{soloRow.repeat}
            </span>
          ) : null}
          {durations[soloRow.lastIndex] ? (
            <span className="shrink-0 tabular-nums text-xs text-muted-foreground/70">
              {durations[soloRow.lastIndex]}
            </span>
          ) : null}
        </div>
        {status === "waiting" ? (
          <div className="mt-1 flex items-center gap-1.5 text-xs text-amber-11" role="status">
            <CirclePause aria-hidden="true" className="size-3.5 shrink-0" />
            <span>Choose an option or approve the request to continue.</span>
          </div>
        ) : null}
        {status === "interrupted" ? (
          <div className="mt-1 flex items-center gap-1.5 text-xs text-destructive" role="alert">
            <AlertTriangle aria-hidden="true" className="size-3.5 shrink-0" />
            <span>This step stopped before it finished. Retry to continue.</span>
          </div>
        ) : null}
        {failure ? (
          <div className="mt-1.5">{detailBox("error", soloRow.part.toolCallId, failure)}</div>
        ) : null}
      </div>
    )
  }

  return (
    <div
      className={className}
      data-tool-aggregate={latestToolCallId}
      data-tool-lifecycle={aggregateLifecycle}
    >
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        aria-expanded={expanded}
        className="group flex min-w-0 max-w-full cursor-pointer items-center gap-1.5 text-start text-sm text-muted-foreground transition-colors hover:text-foreground"
      >
        <span className="min-w-0 truncate">{summary}</span>
        {thoughts.length > 0 ? (
          <span data-tool-aggregate-thought-count className="shrink-0 text-xs text-muted-foreground/70">
            · {thoughts.length === 1 ? "1 thought" : `${thoughts.length} thoughts`}
          </span>
        ) : null}
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

      {aggregateLifecycle === "waiting" ? (
        <div className="mt-1 flex items-center gap-1.5 text-xs text-amber-11" role="status">
          <CirclePause aria-hidden="true" className="size-3.5 shrink-0" />
          <span>Choose an option or approve the request to continue.</span>
        </div>
      ) : null}

      {aggregateLifecycle === "unknown" ? (
        <div className="mt-1 flex items-center gap-1.5 text-xs text-muted-foreground" role="status">
          <CircleHelp aria-hidden="true" className="size-3.5 shrink-0" />
          <span>No terminal result was observed. This step may still be running; check the session before retrying.</span>
        </div>
      ) : null}

      {nowPart && nowCommandShown ? (
        <div data-tool-aggregate-now className="mt-1.5 min-w-0">
          {detailBox("command", nowPart.toolCallId, nowCommand)}
        </div>
      ) : nowLabel ? (
        <div
          data-tool-aggregate-now
          className="mt-1 min-w-0 text-sm text-muted-foreground"
          title={nowCommand ? "Double-click to show the full command" : undefined}
          onDoubleClick={
            nowPart && nowCommand
              ? () =>
                  setFullDetailKeys((current) =>
                    new Set(current).add(detailKey(nowPart.toolCallId, "command")),
                  )
              : undefined
          }
        >
          <span className="ow-text-shimmer block min-w-0 truncate">
            {nowLabel}
          </span>
        </div>
      ) : null}

      {thinkingNow ? (
        <div data-tool-aggregate-thinking className="mt-1 min-w-0 text-sm text-muted-foreground">
          <span className="ow-text-shimmer">Thinking…</span>
        </div>
      ) : null}

      {expanded ? (
        <div className="mt-1.5 flex flex-col gap-1">
          {visibleRows.map((row) => {
            const part = row.part
            const lifecycle = resolveLifecycle(part.toolCallId, isToolPartInFlight(part))
            const status = isToolPartInFlight(part)
              ? lifecycle === "running" || lifecycle === "waiting"
                ? lifecycle
                : "unknown"
              : persistedRowStatus(part)
            const failure = failureText(part)
            const bash = isBashToolPart(part)
            const command = bash ? part.input?.command?.trim() ?? "" : ""
            const commandDescription = bash
              ? part.input?.description?.trim() || "command"
              : ""
            const search = bash ? null : getAggregateRowSearch(part)
            return (
              <Fragment key={part.toolCallId}>
              {thoughtsAt(row.index).map((thought) => (
                <div key={`thought-${row.index}-${thought.afterIndex}`} data-tool-aggregate-thought className="py-1">
                  <ReasoningBlock text={thought.text} isStreaming={thought.isStreaming} />
                </div>
              ))}
              <div data-tool-aggregate-row className="flex min-w-0 flex-col gap-1.5 py-1">
                {!singleCommand ? (
                  <div className="flex min-w-0 items-center gap-2 text-sm text-muted-foreground">
                  {status === "waiting" ? (
                    <CirclePause aria-label="Waiting" className="size-3.5 shrink-0 text-amber-11" />
                  ) : null}
                  {status === "unknown" ? (
                    <CircleHelp aria-label="Status unknown" className="size-3.5 shrink-0" />
                  ) : null}
                  {bash ? (
                    <span className="min-w-0 break-words">
                      <span className={cn("text-foreground", status === "running" && "ow-text-shimmer")}>
                        {status === "running"
                          ? "Running"
                          : status === "waiting"
                            ? "Waiting to run"
                            : status === "unknown"
                              ? "Status unknown for"
                              : "Ran"}
                      </span>{" "}
                      <span>{commandDescription}</span>
                    </span>
                  ) : search ? (
                    <span className="min-w-0 break-words">
                      <span className={cn(status === "running" && "text-foreground ow-text-shimmer")}>
                        {search.verb}
                      </span>
                      {search.scope ? <span> in {search.scope}</span> : null}
                    </span>
                  ) : (() => {
                    const file = getAggregateRowFile(part)
                    if (!file) {
                      return (
                        <span className={cn("min-w-0 truncate", status === "running" && "ow-text-shimmer")}>
                          {getAggregateRowLabel(part)}
                        </span>
                      )
                    }
                    return (
                      <span className="flex min-w-0 items-center gap-1.5">
                        <span className={cn("shrink-0", status === "running" && "text-foreground ow-text-shimmer")}>
                          {file.verb}
                        </span>
                        <FileChip path={file.path} className="min-w-0" />
                        {row.repeat > 1 ? (
                          <span
                            data-tool-aggregate-repeat
                            className="shrink-0 text-xs text-muted-foreground/70"
                          >
                            ×{row.repeat}
                          </span>
                        ) : null}
                      </span>
                    )
                  })()}
                  {durations[row.lastIndex] ? (
                    <span className="shrink-0 tabular-nums text-muted-foreground/70">
                      {durations[row.lastIndex]}
                    </span>
                  ) : null}
                  </div>
                ) : null}
                {bash && command ? detailBox("command", part.toolCallId, command) : null}
                {search ? detailBox("pattern", part.toolCallId, search.pattern) : null}
                {failure ? detailBox("error", part.toolCallId, failure) : null}
              </div>
              </Fragment>
            )
          })}
          {trailingThoughts.map((thought) => (
            <div key={`thought-trailing-${thought.afterIndex}`} data-tool-aggregate-thought className="py-1">
              <ReasoningBlock text={thought.text} isStreaming={thought.isStreaming} />
            </div>
          ))}
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
