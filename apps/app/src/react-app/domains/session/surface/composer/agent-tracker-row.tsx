"use client"

import type { HTMLAttributes } from "react"

import { Button } from "@/components/ui/button"
import { t } from "@/i18n"
import { cn } from "@/lib/utils"

export type AgentTrackerKind = "attention" | "working" | "error" | "done" | "stopped"

export type AgentTrackerWorkingNote = "retrying" | "reconnecting" | "starting"

export type AgentTrackerStatus = {
  kind: AgentTrackerKind
  elapsed: string | null
  workingNote?: AgentTrackerWorkingNote | null
  waitingFor?: "permission" | "question" | null
  stopping?: boolean
  shimmer?: boolean
}

export function agentTrackerStatusText(status: AgentTrackerStatus): { visible: string; spoken: string | null } {
  if (status.stopping) return { visible: t("session.subagent_tracker_stopping"), spoken: null }
  switch (status.kind) {
    case "attention":
      return { visible: status.waitingFor === "permission" ? t("session.subagent_permission_needed") : t("session.subagent_question_pending"), spoken: null }
    case "stopped":
      return { visible: t("session.subagent_tracker_stopped"), spoken: null }
    case "error":
      return { visible: t("session.subagent_tracker_error"), spoken: null }
    case "done":
      return { visible: t("session.subagent_tracker_done"), spoken: null }
    case "working":
      if (status.workingNote === "retrying") return { visible: t("session.subagent_tracker_retrying"), spoken: null }
      if (status.workingNote === "reconnecting") return { visible: t("session.subagent_tracker_reconnecting"), spoken: null }
      if (status.workingNote === "starting") return { visible: t("session.subagent_tracker_starting"), spoken: null }
      return status.elapsed
        ? { visible: status.elapsed, spoken: t("session.subagent_tracker_working_prefix") }
        : { visible: t("session.remote_task_status_working"), spoken: null }
  }
}

type AgentTrackerRowProps = {
  id: string
  name: string
  task: string
  status: AgentTrackerStatus
  onOpen?: () => void
  openLabel: string
  onStop?: () => void
  stopLabel: string
  onReview?: () => void
  rowAttributes?: HTMLAttributes<HTMLDivElement> & Record<`data-${string}`, string | undefined>
}

export function AgentTrackerRow(props: AgentTrackerRowProps) {
  const { status } = props
  const text = agentTrackerStatusText(status)
  const attention = status.kind === "attention"
  const settled = status.kind === "done" || status.kind === "stopped"
  const review = attention ? props.onReview ?? props.onOpen : undefined
  const nameClass = cn("shrink-0 font-medium", settled ? "text-gray-11" : "text-gray-12")
  const taskClass = cn("min-w-0 truncate @max-[480px]/composer:hidden", settled ? "text-gray-8" : "text-gray-9")

  return (
    <div
      {...props.rowAttributes}
      data-subagent-tracker-row={props.id}
      data-subagent-tracker-kind={status.kind}
      className="group/row mx-2 flex h-9 min-w-0 items-center gap-3 rounded-lg px-2 text-[13px] transition-colors hover:bg-gray-2 focus-within:bg-gray-2"
    >
      {props.onOpen ? (
        <button
          type="button"
          tabIndex={-1}
          aria-hidden="true"
          data-subagent-tracker-name-open=""
          onClick={props.onOpen}
          className="flex min-w-0 flex-1 cursor-pointer items-baseline gap-2 text-start"
        >
          <span className={nameClass} data-subagent-tracker-agent="">{props.name}</span>
          <span data-subagent-tracker-task className={taskClass}>{props.task}</span>
        </button>
      ) : (
        <span className="flex min-w-0 flex-1 items-baseline gap-2">
          <span className={nameClass} data-subagent-tracker-agent="">{props.name}</span>
          <span data-subagent-tracker-task className={taskClass}>{props.task}</span>
        </span>
      )}
      <span
        data-subagent-tracker-status
        className={cn(
          "shrink-0 text-xs tabular-nums",
          attention ? "font-medium text-amber-11"
            : status.kind === "error" ? "text-red-11"
            : "text-gray-9",
          status.shimmer && !status.stopping && "ow-text-shimmer",
        )}
      >
        {text.spoken ? <span className="sr-only">{text.spoken} </span> : null}
        {text.visible}
      </span>
      <span className="flex w-[92px] shrink-0 items-center justify-end gap-0.5 max-sm:w-auto">
        {review ? (
          <Button type="button" variant="outline" size="xs" className="bg-background text-gray-12" data-subagent-tracker-review="" data-testid="subagent-tracker-review" onClick={review}>
            {t("session.subagent_tracker_review")}
          </Button>
        ) : null}
        <span className={cn("flex items-center gap-0.5", review ? "hidden" : "opacity-0 transition-opacity group-hover/row:opacity-100 group-focus-within/row:opacity-100 [@media(hover:none)]:opacity-100")}>
          {props.onStop ? (
            <Button
              type="button"
              variant="ghost"
              size="xs"
              className="text-gray-11 hover:text-gray-12"
              data-subagent-tracker-stop=""
              disabled={status.stopping}
              aria-label={props.stopLabel}
              onClick={props.onStop}
            >
              {t("text_activity.stop")}
            </Button>
          ) : null}
          {props.onOpen ? (
            <Button
              type="button"
              variant="ghost"
              size="xs"
              className="text-gray-11 hover:text-gray-12"
              data-subagent-tracker-open=""
              aria-label={props.openLabel}
              onClick={props.onOpen}
            >
              {t("text_activity.open")}
            </Button>
          ) : null}
        </span>
      </span>
    </div>
  )
}
