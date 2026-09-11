"use client"

import { useEffect, useState } from "react"
import { ArrowUpRight, ShieldAlert } from "lucide-react"

import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible"
import { useMessageList } from "@/components/chat/message-list-provider"
import { taskChildSessionId, type TaskToolPart } from "@/lib/build-in-tools"
import { isToolPartInFlight } from "@/lib/tool-activity"
import { formatElapsedSeconds, getToolCallStartedAt, trackToolCallDuration } from "@/lib/tool-call-duration"
import { cn } from "@/lib/utils"
import { t } from "@/i18n"
import { useSessionActivityStore } from "@/react-app/domains/session/status/session-activity-store"
import { hasNoNewActivity } from "@/react-app/domains/session/status/session-progress"
import { statusKey } from "@/react-app/domains/session/sync/session-sync"
import { useQueryCacheState } from "@/react-app/infra/query-cache-state"
import type { SessionStatus } from "@opencode-ai/sdk/v2/client"

type SubagentRunLineProps = {
  part: TaskToolPart
  className?: string
  parentActive?: boolean
}

export function subagentRunActivity(input: {
  permissionPending: boolean
  questionPending?: boolean
  retrying?: boolean
  resultPending?: boolean
  childFailed?: boolean
  noNewActivity?: boolean
  timingUnknown?: boolean
  syncDegraded?: boolean
  inFlight: boolean
  failed: boolean
}): "waiting-permission" | "waiting-question" | "waiting-result" | "waiting-start" | "retrying" | "no-new-activity" | "reconnecting" | "shimmer" | "failed" | "completed" {
  // A pending ask is the actionable state and does not depend on the stream
  // ticking; a lost connection only downgrades the live "Working" treatment.
  if (input.permissionPending) return "waiting-permission"
  if (input.questionPending) return "waiting-question"
  if (input.inFlight && input.retrying) return "retrying"
  if (input.inFlight && input.syncDegraded) return "reconnecting"
  if (input.failed || input.childFailed) return "failed"
  if (input.inFlight && input.resultPending) return "waiting-result"
  if (input.inFlight && input.timingUnknown) return "waiting-start"
  if (input.inFlight && input.noNewActivity) return "no-new-activity"
  if (input.inFlight) return "shimmer"
  return "completed"
}

function agentName(slug: string): string {
  const words = slug.split(/[-_.\s]+/).filter(Boolean)
  if (words.length === 0) return "Agent"
  return words
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ")
}

/**
 * Running sub-agent task cards use a quiet text shimmer for activity.
 * Line 1 = task title + agent name; line 2 = live status verb or
 * "Completed". The card is the doorway into the sub-agent's own session:
 * when the engine reports the child session id, clicking it opens that
 * session in the main chat surface. Without that route, details stay limited
 * to safe task/output labels, never raw prompts or payloads.
 */
export function SubagentRunLine({ part, className, parentActive = true }: SubagentRunLineProps) {
  const [open, setOpen] = useState(false)
  const { onOpenSubagentSession, syncDegraded, workspaceId } = useMessageList()
  const childSessionId = taskChildSessionId(part)
  const child = useSessionActivityStore((state) => (
    childSessionId
      ? state.recordsByWorkspaceId[workspaceId]?.[childSessionId]
      : undefined
  ))
  const childStatus = useQueryCacheState<SessionStatus | null>(
    childSessionId ? statusKey(workspaceId, childSessionId) : null, null,
  )
  const permissionPending = (child?.waitingPermissionIds.length ?? 0) > 0
  const questionPending = (child?.waitingQuestionIds.length ?? 0) > 0
  const inFlight = isToolPartInFlight(part)
  const isFailed = part.state === "output-error"
  const duration = trackToolCallDuration(part)
  const [elapsedSeconds, setElapsedSeconds] = useState(0)
  // Native start time survives reload; optimistic timing survives remounts.
  const startedAt = getToolCallStartedAt(part)
  const lastProgressAt = child?.lastProgressAt || startedAt || 0
  const noNewActivity = hasNoNewActivity({
    active: inFlight, lastProgressAt, now: Date.now(),
  })
  const activity = subagentRunActivity({
    permissionPending, questionPending, retrying: childStatus?.type === "retry" || child?.retrying, noNewActivity,
    timingUnknown: startedAt === null,
    syncDegraded, inFlight, failed: isFailed,
    childFailed: inFlight && child?.errorActive,
    resultPending: Boolean(child && !child.runActive && child.runStatusAt > 0) || (!parentActive && !child?.runActive),
  })
  useEffect(() => {
    // While run liveness is unconfirmed the counter must not tick; the
    // module-scoped anchor resumes the true elapsed time on recovery.
    if (!inFlight || startedAt === null || syncDegraded) return
    const update = () => {
      setElapsedSeconds(Math.max(0, Math.floor((Date.now() - startedAt) / 1000)))
    }
    update()
    const interval = window.setInterval(update, 1000)
    return () => window.clearInterval(interval)
  }, [inFlight, startedAt, part.toolCallId, syncDegraded])
  const title = part.input?.description?.trim().slice(0, 160) || "Sub-agent task"
  const agent = agentName(part.input?.subagent_type ?? "")
  const status = permissionPending
    ? t("session.subagent_permission_needed")
    : questionPending ? t("session.subagent_question_pending")
    : activity === "retrying" ? "Retrying"
    : activity === "failed" ? "Task reported an error"
    : activity === "waiting-result" ? "Waiting for task result"
    : activity === "waiting-start" ? "Waiting for task update"
    : activity === "no-new-activity" ? "Still working — waiting for updates"
    : inFlight
    ? syncDegraded
      ? "Connection lost — reconnecting…"
      : `Working ${formatElapsedSeconds(elapsedSeconds)}`
    : isFailed
      ? "Task failed"
      : "Completed"

  const lines = (
    <>
      <span className="flex min-w-0 items-center gap-2">
        <span className={cn("min-w-0 truncate", activity === "shimmer" && "ow-text-shimmer")}>
          {title}
          <span className="text-muted-foreground/70"> · {agent} agent</span>
        </span>
        {permissionPending ? (
          <ShieldAlert
            data-subagent-permission-icon
            aria-label={t("session.subagent_permission_needed")}
            className="size-3.5 shrink-0 text-amber-10"
          />
        ) : null}
        {childSessionId && onOpenSubagentSession ? (
          <ArrowUpRight
            aria-hidden="true"
            className="size-3.5 shrink-0 text-muted-foreground/70 opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100"
          />
        ) : null}
      </span>
      <span className={cn("min-w-0 truncate text-xs", permissionPending ? "font-medium text-amber-11" : "text-muted-foreground/70")}>
        {status}
        {!inFlight && !isFailed && duration ? ` · ${duration}` : ""}
      </span>
      {inFlight && child?.latestActivity ? (
        <span className="text-xs text-muted-foreground/70">Last activity: {child.latestActivity}{child.lastProgressAt > 0 ? ` · ${formatElapsedSeconds(Math.max(0, Math.floor((Date.now() - child.lastProgressAt) / 1000)))} ago` : ""}</span>
      ) : null}
    </>
  )

  if (childSessionId && onOpenSubagentSession) {
    return (
      <div
        data-subagent-run={part.toolCallId}
        data-subagent-session-id={childSessionId}
        data-subagent-activity={activity}
        data-subagent-permission={permissionPending ? "pending" : undefined}
        className={cn("min-w-0 max-w-full", className)}
      >
        <button
          type="button"
          className="group flex min-w-0 max-w-full cursor-pointer flex-col gap-0.5 text-start text-sm text-muted-foreground transition-colors hover:text-foreground"
          aria-label={`${title}. Open sub-agent chat`}
          onClick={() => onOpenSubagentSession(childSessionId)}
        >
          {lines}
        </button>
      </div>
    )
  }

  return (
    <Collapsible
      data-subagent-run={part.toolCallId}
      data-subagent-activity={activity}
      data-subagent-permission={permissionPending ? "pending" : undefined}
      open={open}
      onOpenChange={setOpen}
      className={cn("min-w-0 max-w-full", className)}
    >
      <CollapsibleTrigger
        className="group flex min-w-0 max-w-full cursor-pointer flex-col gap-0.5 text-start text-sm text-muted-foreground transition-colors hover:text-foreground"
        aria-label={open ? `${title}. Hide details` : `${title}. Show details`}
      >
        {lines}
      </CollapsibleTrigger>
      <CollapsibleContent className="h-(--collapsible-panel-height) overflow-hidden transition-[height] duration-150 ease-out data-starting-style:h-0 data-ending-style:h-0 [&[hidden]:not([hidden='until-found'])]:hidden">
        <div className="mt-2 flex flex-col gap-2 rounded-lg bg-muted p-2 text-xs">
          <span>{childSessionId ? "Child chat navigation is unavailable." : "The child chat is not available yet."}</span>
          <span>{part.state === "output-available" ? "Task output received" : isFailed ? "Task reported an error" : "Waiting for task output"}</span>
        </div>
      </CollapsibleContent>
    </Collapsible>
  )
}
