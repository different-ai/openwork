"use client"

import { Fragment, useState } from "react"
import { Check, ChevronUp, CircleHelp, CirclePause, Copy, FilePen, FileText, MoreHorizontal, Search, SquareTerminal } from "lucide-react"

import { FileChip } from "@/components/chat/file-chip"
import { LaneChevron, LeadingLane, RAIL_LINE, RAIL_ROW, RailDuration, RailMeta } from "@/components/chat/activity-rail"
import { DetailsToggle } from "@/components/chat/capability-call-line"
import { ShellCommandText } from "@/components/chat/shell-command-text"
import { useTextActivityRail } from "@/components/chat/text-activity-rail-store"
import { TextToolAggregateGroup } from "@/components/chat/text-tool-aggregate-group"
import { ReasoningBlock } from "@/components/chat/reasoning-block"
import { useWorkbenchDisclosure } from "@/react-app/domains/session/chat/workbench-ui-state"
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
  getWorkspacePathResolutions,
  type AggregateThought,
  type AnyToolPart,
} from "@/lib/tool-aggregate"
import { isToolPartInFlight } from "@/lib/tool-activity"
import { isBashToolPart } from "@/lib/build-in-tools"
import { trackToolCallDuration } from "@/lib/tool-call-duration"
import { cn } from "@/lib/utils"

const ROW_CAP = 8

/** The leading-lane glyph for a local step: terminal, file read, file change or search (T1). */
function FamilyGlyph({ part, status }: { part: AnyToolPart; status: string }) {
  if (status === "waiting") return <CirclePause aria-label="Waiting" className="size-3.5 text-amber-11" />
  if (status === "unknown") return <CircleHelp aria-label="Status unknown" className="size-3.5" />
  const family = getToolFamily(part)
  const Glyph = family === "command" ? SquareTerminal : family === "edit" ? FilePen : family === "search" ? Search : FileText
  return <Glyph aria-hidden="true" className="size-3.5 text-muted-foreground/80" strokeWidth={1.5} />
}

function WorkspacePathNotice({ part }: { part: AnyToolPart }) {
  return getWorkspacePathResolutions(part).map(path => (
    <div key={`${path.requested}:${path.resolved}`} data-workspace-file-resolution className="break-all text-xs text-muted-foreground">
      Workspace destination: {path.resolved} (from {path.requested})
    </div>
  ))
}

type ToolAggregateGroupProps = {
  parts: AnyToolPart[]
  messageId?: string
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

function RetainedDetailBox({ disclosureKey, ...props }: Pick<DetailBoxProps, "kind" | "text"> & { disclosureKey?: string }) {
  const [expanded, setExpanded] = useWorkbenchDisclosure(disclosureKey)
  return <DetailBox {...props} expanded={expanded} onToggle={() => setExpanded(!expanded)} />
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
export function ToolAggregateGroup(props: ToolAggregateGroupProps) {
  // Text-first rail (flag `textActivityRail`); off keeps this rail exactly as it was.
  return useTextActivityRail() ? <TextToolAggregateGroup {...props} /> : <RailToolAggregateGroup {...props} />
}

function RailToolAggregateGroup({ parts, messageId, thoughts = [], className }: ToolAggregateGroupProps) {
  const groupKey = parts[0]?.toolCallId ?? "aggregate"
  const latestToolCallId = parts.at(-1)?.toolCallId ?? groupKey
  const keyFor = (id: string, detail: string) => messageId ? JSON.stringify(["tool", messageId, id, detail]) : undefined
  const [expanded, setExpanded] = useWorkbenchDisclosure(keyFor(groupKey, "expanded"))
  const [showAll, setShowAll] = useWorkbenchDisclosure(keyFor(groupKey, "show-all"))
  const resolveLifecycle = useCurrentToolLifecycleResolver()

  const detailBox = (kind: DetailBoxProps["kind"], toolCallId: string, text: string) => {
    return (
      <RetainedDetailBox
        disclosureKey={keyFor(toolCallId, kind)}
        kind={kind}
        text={text}
      />
    )
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
  const [fullNowCommand, setFullNowCommand] = useWorkbenchDisclosure(keyFor(nowPart?.toolCallId ?? "", "command"))
  const nowCommandShown = Boolean(nowPart && nowCommand && fullNowCommand)
  // The model is thinking mid-run: no tool is in flight but the run's
  // latest thought is still streaming. Show that instead of dead air.
  const lastThought = thoughts.at(-1)
  const thinkingNow = !nowLabel && Boolean(lastThought?.isStreaming)
  const liveText = nowCommandShown ? null : nowLabel ?? (thinkingNow ? "Thinking…" : null)

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

  const rowStatus = (part: AnyToolPart) => {
    const lifecycle = resolveLifecycle(part.toolCallId, isToolPartInFlight(part))
    return isToolPartInFlight(part)
      ? lifecycle === "running" || lifecycle === "waiting" ? lifecycle : "unknown"
      : persistedRowStatus(part)
  }

  // "Edited 1 file" above "Edited file-chip.tsx" says nothing twice.
  // A group that is exactly one file action (and no thoughts) renders
  // as the row itself — verb, chip, duration — with nothing to expand.
  const soloRow = rows.length === 1 && thoughts.length === 0 ? rows[0] : undefined
  const soloFile = soloRow ? getAggregateRowFile(soloRow.part) : null
  if (soloRow && soloFile) {
    const status = isToolPartInFlight(soloRow.part)
      ? currentLifecycle === "running" || currentLifecycle === "waiting" ? currentLifecycle : "unknown"
      : persistedRowStatus(soloRow.part)
    const failure = failureText(soloRow.part)
    return (
      <div
        className={className}
        data-tool-aggregate={latestToolCallId}
        data-tool-lifecycle={status}
      >
        <div className={cn(RAIL_ROW, RAIL_LINE)}>
          <LeadingLane><FamilyGlyph part={soloRow.part} status={status} /></LeadingLane>
          <span className={cn("shrink-0", status === "running" && "text-foreground ow-text-shimmer motion-reduce:animate-none", status === "failed" && "text-destructive")}>
            {status === "unknown" ? "Status unknown for" : soloFile.verb}
          </span>
          <FileChip path={soloFile.path} className="min-w-0" />
          {soloRow.repeat > 1 ? <RailMeta><span data-tool-aggregate-repeat>×{soloRow.repeat}</span></RailMeta> : null}
          <RailDuration value={durations[soloRow.lastIndex]} />
        </div>
        {status === "waiting" ? (
          <div className="mt-1 flex items-center gap-1.5 ps-7 text-xs text-amber-11" role="status">
            <CirclePause aria-hidden="true" className="size-3.5 shrink-0" />
            <span>Choose an option or approve the request to continue.</span>
          </div>
        ) : null}
        <WorkspacePathNotice part={soloRow.part} />
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
        className={cn(RAIL_ROW, RAIL_LINE, "group w-full cursor-pointer text-start transition-colors hover:text-foreground")}
      >
        <LaneChevron open={expanded} />
        <span className="min-w-0 shrink-0 truncate">{summary}</span>
        {/* What is happening now lives on the same line, so starting or
            finishing a step never adds or removes a line below it. */}
        {liveText ? (
          <span data-tool-aggregate-now className="ow-text-shimmer min-w-0 flex-1 truncate motion-reduce:animate-none"
            title={nowCommand ? "Double-click to show the full command" : undefined}
            onDoubleClick={nowPart && nowCommand ? (event) => { event.stopPropagation(); setFullNowCommand(true) } : undefined}>
            {liveText}
          </span>
        ) : null}
        {thoughts.length > 0 ? (
          <RailMeta><span data-tool-aggregate-thought-count>{thoughts.length === 1 ? "1 thought" : `${thoughts.length} thoughts`}</span></RailMeta>
        ) : null}
        {failedCount > 0 ? <RailMeta className="text-destructive">{failedCount} failed</RailMeta> : null}
        <RailDuration value={singleCommandDuration} />
      </button>

      {aggregateLifecycle === "waiting" ? (
        <div className="mt-1 flex items-center gap-1.5 ps-7 text-xs text-amber-11" role="status">
          <CirclePause aria-hidden="true" className="size-3.5 shrink-0" />
          <span>Choose an option or approve the request to continue.</span>
        </div>
      ) : null}

      {aggregateLifecycle === "unknown" ? (
        <div className="mt-1 flex items-center gap-1.5 ps-7 text-xs text-muted-foreground" role="status">
          <CircleHelp aria-hidden="true" className="size-3.5 shrink-0" />
          <span>No terminal result was observed. This step may still be running; check the session before retrying.</span>
        </div>
      ) : null}

      {nowPart && nowCommandShown ? (
        <div className="mt-1.5 min-w-0 ps-7">
          <DetailBox kind="command" text={nowCommand} expanded={fullNowCommand} onToggle={() => setFullNowCommand(false)} />
        </div>
      ) : null}

      {expanded ? (
        // Flat, not boxed (S1): steps indent under the summary's label.
        <div className="mt-2 flex flex-col gap-2 ps-7">
          {visibleRows.map((row) => (
            <Fragment key={row.part.toolCallId}>
              {thoughtsAt(row.index).map((thought) => (
                <div key={`thought-${row.index}-${thought.afterIndex}`} data-tool-aggregate-thought className="py-1">
                  <ReasoningBlock disclosureKey={keyFor(groupKey, `thought-${thought.afterIndex}`)} text={thought.text} isStreaming={thought.isStreaming} />
                </div>
              ))}
              <AggregateRowView
                row={row}
                duration={durations[row.lastIndex] ?? null}
                showLine={!singleCommand}
                status={rowStatus(row.part)}
                detailKey={(detail) => keyFor(row.part.toolCallId, detail)}
              />
            </Fragment>
          ))}
          {trailingThoughts.map((thought) => (
            <div key={`thought-trailing-${thought.afterIndex}`} data-tool-aggregate-thought className="py-1">
              <ReasoningBlock disclosureKey={keyFor(groupKey, `thought-${thought.afterIndex}`)} text={thought.text} isStreaming={thought.isStreaming} />
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

/**
 * One local step on the rail: a glyph in the leading lane, the sentence,
 * the duration, and the full command or search pattern behind the details
 * icon (P3). A failure keeps its error visible, since that is when it is needed.
 */
function AggregateRowView({ row, duration, showLine, status, detailKey }: {
  row: AggregateRow
  duration: string | null
  showLine: boolean
  status: "running" | "waiting" | "unknown" | "failed" | "done"
  detailKey: (detail: string) => string | undefined
}) {
  const part = row.part
  const [detailsOpen, setDetailsOpen] = useWorkbenchDisclosure(detailKey("details"))
  const failure = failureText(part)
  const bash = isBashToolPart(part)
  const command = bash ? part.input?.command?.trim() ?? "" : ""
  const commandDescription = bash ? part.input?.description?.trim() || "command" : ""
  const search = bash ? null : getAggregateRowSearch(part)
  const raw = command ? { kind: "command" as const, text: command } : search ? { kind: "pattern" as const, text: search.pattern } : null
  const shimmer = status === "running" && "text-foreground ow-text-shimmer motion-reduce:animate-none"
  const file = bash || search ? null : getAggregateRowFile(part)
  const label = bash
    ? `${status === "running" ? "Running" : status === "waiting" ? "Waiting to run" : status === "unknown" ? "Status unknown for" : "Ran"} ${commandDescription}`
    : search ? `${search.verb}${search.scope ? ` in ${search.scope}` : ""}` : getAggregateRowLabel(part)
  return (
    <div data-tool-aggregate-row className="flex min-w-0 flex-col gap-1.5">
      {showLine ? (
        <div className={cn(RAIL_ROW, RAIL_LINE)}>
          <LeadingLane><FamilyGlyph part={part} status={status} /></LeadingLane>
          {file ? (
            <span className="flex min-w-0 flex-1 items-center gap-1.5">
              <span className={cn("shrink-0", shimmer, status === "failed" && "text-destructive")}>{file.verb}</span>
              <FileChip path={file.path} className="min-w-0" />
              {row.repeat > 1 ? <RailMeta><span data-tool-aggregate-repeat>×{row.repeat}</span></RailMeta> : null}
            </span>
          ) : (
            <span className={cn("min-w-0 flex-1 truncate", shimmer, status === "failed" && "text-destructive")}>{label}</span>
          )}
          <RailDuration value={duration} />
          {raw ? (
            <DetailsToggle open={detailsOpen} onToggle={() => setDetailsOpen(!detailsOpen)} label={label} alwaysVisible={status === "failed"} />
          ) : null}
        </div>
      ) : null}
      <WorkspacePathNotice part={part} />
      {raw && (detailsOpen || !showLine) ? <RetainedDetailBox disclosureKey={detailKey(raw.kind)} kind={raw.kind} text={raw.text} /> : null}
      {failure ? <RetainedDetailBox disclosureKey={detailKey("error")} kind="error" text={failure} /> : null}
    </div>
  )
}
