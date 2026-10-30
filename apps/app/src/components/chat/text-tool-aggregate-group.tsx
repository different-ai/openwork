"use client"

import { Fragment } from "react"

import { markFeatureUsed } from "@/app/lib/den"
import { RAIL_LINE, RAIL_ROW, RailMeta, TextSentenceLine, TrailingChevron } from "@/components/chat/activity-rail"
import { useCurrentToolLifecycleResolver } from "@/components/chat/current-tool-lifecycle-context"
import { ReasoningBlock } from "@/components/chat/reasoning-block"
import { TextCommandCard, TextDiffCard, TextDiffStats, TextTechnicalDetails } from "@/components/chat/text-activity-details"
import { t } from "@/i18n"
import { isBashToolPart, isEditToolPart, isWriteToolPart } from "@/lib/build-in-tools"
import { textDiffStats, textGroupDiffStats, textGroupSummary, textStepSentence, type TextStepStatus } from "@/lib/text-activity"
import { getAggregateNowPart, getToolAggregateLifecycle, type AggregateThought, type AnyToolPart } from "@/lib/tool-aggregate"
import { isToolPartInFlight } from "@/lib/tool-activity"
import { cn } from "@/lib/utils"
import { useWorkbenchDisclosure } from "@/react-app/domains/session/chat/workbench-ui-state"

const ROW_CAP = 8

type TextAggregateRow = { part: AnyToolPart; index: number; repeat: number }

function settledStatus(part: AnyToolPart): "running" | "failed" | "done" {
  if (isToolPartInFlight(part)) return "running"
  if (part.state === "output-error" || part.state === "output-denied") return "failed"
  return "done"
}

/** Identical settled reads of one file fold into one row; a thought between them keeps them apart. */
function buildRows(parts: AnyToolPart[], thoughts: AggregateThought[]): TextAggregateRow[] {
  const rows: TextAggregateRow[] = []
  parts.forEach((part, index) => {
    const previous = rows.at(-1)
    const same = previous !== undefined
      && part.type === "dynamic-tool" && previous.part.type === "dynamic-tool"
      && part.toolName === "read" && previous.part.toolName === "read"
      && JSON.stringify(part.input) === JSON.stringify(previous.part.input)
      && settledStatus(part) === "done" && settledStatus(previous.part) === "done"
      && !thoughts.some((thought) => thought.afterIndex === index)
    if (same) {
      previous.part = part
      previous.repeat += 1
      return
    }
    rows.push({ part, index, repeat: 1 })
  })
  return rows
}

function commandOf(part: AnyToolPart): string {
  return isBashToolPart(part) ? part.input?.command?.trim() ?? "" : ""
}

function outputOf(part: AnyToolPart): string | null {
  if (part.state === "output-error") return part.errorText?.trim() || null
  if (part.state !== "output-available") return null
  const output = part.output
  if (typeof output === "string") return output.trim() || null
  if (output && typeof output === "object" && "output" in output && typeof output.output === "string") return output.output.trim() || null
  return null
}

function editTexts(part: AnyToolPart): { removed: string | null; added: string | null } | null {
  if (isEditToolPart(part)) return { removed: part.input?.oldString ?? null, added: part.input?.newString ?? null }
  if (isWriteToolPart(part)) return { removed: null, added: part.input?.content ?? null }
  return null
}

/**
 * One local step, text-first: "Ran List the workspace files", "Read
 * brief.md", "Edited composer.tsx +11 −3". Opening a command shows the
 * command card; an edit shows its change; a failure shows Technical details.
 */
function TextStepRow({ row, status, disclosureKey }: {
  row: TextAggregateRow
  status: TextStepStatus
  disclosureKey: string | undefined
}) {
  const part = row.part
  const [open, setOpen] = useWorkbenchDisclosure(disclosureKey)
  const sentence = textStepSentence(part, status)
  const command = commandOf(part)
  const output = outputOf(part)
  const edit = status === "failed" ? null : editTexts(part)
  const stats = textDiffStats(part)
  const failure = status === "failed" && !command ? output : null
  const expandable = Boolean(command || (edit && (edit.added || edit.removed)) || failure)
  const tone = status === "failed" ? "failed" : status === "waiting" ? "waiting" : status === "running" ? "running" : "normal"
  const line = (
    <>
      <TextSentenceLine verb={sentence.verb} object={sentence.object} title={sentence.title} tone={tone} />
      {row.repeat > 1 ? <RailMeta><span data-tool-aggregate-repeat>×{row.repeat}</span></RailMeta> : null}
      {stats ? <TextDiffStats added={stats.added} removed={stats.removed} /> : null}
      {expandable ? <TrailingChevron open={open} /> : null}
    </>
  )
  return (
    <div data-tool-aggregate-row="" data-text-step-row={status} className="flex min-w-0 flex-col gap-1.5">
      {expandable ? (
        <button
          type="button"
          aria-expanded={open}
          aria-label={open ? t("text_activity.hide_details", { label: `${sentence.verb} ${sentence.object}` }) : t("text_activity.show_details", { label: `${sentence.verb} ${sentence.object}` })}
          onClick={() => {
            if (!open) markFeatureUsed("textActivityRail")
            setOpen(!open)
          }}
          className={cn(RAIL_ROW, RAIL_LINE, "w-full cursor-pointer text-start hover:text-foreground")}
        >
          {line}
        </button>
      ) : (
        <div className={cn(RAIL_ROW, RAIL_LINE)}>{line}</div>
      )}
      {open && command ? <TextCommandCard command={command} output={output} failed={status === "failed"} /> : null}
      {open && edit ? <TextDiffCard removed={edit.removed} added={edit.added} /> : null}
      {open && failure ? <TextTechnicalDetails><pre className="whitespace-pre-wrap break-words font-mono">{failure}</pre></TextTechnicalDetails> : null}
    </div>
  )
}

/**
 * Consecutive local steps, text-first: one summary line ("Explored 2 files,
 * 1 search, ran 4 commands +11 −3 ›") that opens into one sentence per step.
 * While running, the step happening now shimmers after the summary.
 */
export function TextToolAggregateGroup({ parts, messageId, thoughts = [], className }: {
  parts: AnyToolPart[]
  messageId?: string
  thoughts?: AggregateThought[]
  className?: string
}) {
  const groupKey = parts[0]?.toolCallId ?? "aggregate"
  const latestToolCallId = parts.at(-1)?.toolCallId ?? groupKey
  const keyFor = (id: string, detail: string) => messageId ? JSON.stringify(["tool", messageId, id, detail]) : undefined
  const [expanded, setExpanded] = useWorkbenchDisclosure(keyFor(groupKey, "expanded"))
  const [showAll, setShowAll] = useWorkbenchDisclosure(keyFor(groupKey, "show-all"))
  const resolveLifecycle = useCurrentToolLifecycleResolver()

  const inFlightPart = parts.find((part) => isToolPartInFlight(part))
  const currentLifecycle = resolveLifecycle(inFlightPart?.toolCallId ?? "", Boolean(inFlightPart))
  const lifecycle = getToolAggregateLifecycle(parts, currentLifecycle)
  const running = lifecycle === "running"
  const rowStatus = (part: AnyToolPart): TextStepStatus => {
    if (!isToolPartInFlight(part)) return settledStatus(part)
    const own = resolveLifecycle(part.toolCallId, true)
    return own === "running" || own === "waiting" ? own : "unknown"
  }

  const rows = buildRows(parts, thoughts)
  const thoughtsAt = (index: number) => thoughts.filter((thought) => thought.afterIndex === index)
  const thoughtRow = (thought: AggregateThought, slot: string) => (
    <div key={`thought-${slot}-${thought.afterIndex}`} data-tool-aggregate-thought="">
      <ReasoningBlock disclosureKey={keyFor(groupKey, `thought-${thought.afterIndex}`)} text={thought.text} isStreaming={thought.isStreaming} durationMs={thought.durationMs} />
    </div>
  )

  // One step and no thoughts is the step itself: nothing to summarise.
  const solo = rows.length === 1 && thoughts.length === 0 ? rows[0] : undefined
  if (solo) {
    return (
      <div className={className} data-tool-aggregate={latestToolCallId} data-tool-lifecycle={lifecycle}>
        <TextStepRow row={solo} status={rowStatus(solo.part)} disclosureKey={keyFor(solo.part.toolCallId, "details")} />
      </div>
    )
  }

  const segments = textGroupSummary(parts, running ? "present" : "past")
  const stats = textGroupDiffStats(parts)
  const failedCount = parts.filter((part) => part.state === "output-error").length
  const nowPart = running ? getAggregateNowPart(parts) : null
  const now = nowPart ? textStepSentence(nowPart, "running") : null
  const thinkingNow = !now && Boolean(thoughts.at(-1)?.isStreaming)
  const visibleRows = showAll ? rows : rows.slice(0, ROW_CAP)
  const hiddenCount = rows.length - visibleRows.length
  const trailingThoughts = hiddenCount > 0 ? [] : thoughts.filter((thought) => thought.afterIndex >= parts.length)

  return (
    <div className={className} data-tool-aggregate={latestToolCallId} data-tool-lifecycle={lifecycle}>
      <button
        type="button"
        aria-expanded={expanded}
        onClick={() => {
          if (!expanded) markFeatureUsed("textActivityRail")
          setExpanded(!expanded)
        }}
        className={cn(RAIL_ROW, RAIL_LINE, "w-full cursor-pointer text-start hover:text-foreground")}
      >
        {lifecycle === "waiting" ? <TextSentenceLine verb={t("text_activity.waiting_for_you")} tone="waiting" className="shrink-0" /> : null}
        <span data-text-group-summary="" className="min-w-0 shrink truncate">
          {segments.map((segment, index) => (
            <Fragment key={segment.verb}>
              {index > 0 ? <span className="text-slate-9">, </span> : null}
              <span className="text-muted-foreground">{segment.verb}</span>
              <span className="text-slate-9" title={segment.title}>{` ${segment.object}`}</span>
            </Fragment>
          ))}
        </span>
        {now ? <TextSentenceLine verb={now.verb} object={now.object} tone="running" className="flex-1" /> : null}
        {thinkingNow ? <TextSentenceLine verb={t("text_activity.thinking")} tone="running" className="flex-1" /> : null}
        {stats ? <TextDiffStats added={stats.added} removed={stats.removed} /> : null}
        {failedCount > 0 ? <RailMeta className="text-red-11">{t("text_activity.failed_count", { count: failedCount })}</RailMeta> : null}
        <TrailingChevron open={expanded} />
      </button>

      {expanded ? (
        <div className="mt-2 flex flex-col gap-2">
          {visibleRows.map((row) => (
            <Fragment key={row.part.toolCallId}>
              {thoughtsAt(row.index).map((thought) => thoughtRow(thought, String(row.index)))}
              <TextStepRow row={row} status={rowStatus(row.part)} disclosureKey={keyFor(row.part.toolCallId, "details")} />
            </Fragment>
          ))}
          {trailingThoughts.map((thought) => thoughtRow(thought, "trailing"))}
          {hiddenCount > 0 ? (
            <button type="button" onClick={() => setShowAll(true)} className="w-fit text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline">
              {t("text_activity.show_more_steps", { count: hiddenCount })}
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
