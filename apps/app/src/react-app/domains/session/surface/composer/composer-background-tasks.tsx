"use client"

import { useEffect, useState } from "react"
import { ChevronRight } from "lucide-react"

import { commandPreview } from "@/components/chat/background-tasks"
import { t } from "@/i18n"
import { formatElapsedSeconds } from "@/lib/tool-call-duration"
import { cn } from "@/lib/utils"
import type { BackgroundShell } from "@/react-app/domains/session/status/background-shell-store"

type ComposerBackgroundTasksProps = {
  shells: readonly BackgroundShell[]
  /** The connection cannot confirm the commands are still running: no shimmer, no ticking time. */
  syncDegraded: boolean
  /** The Agents list sits above in the same panel; skip the top padding it already gives. */
  belowAgents?: boolean
}

/**
 * Commands the agent left running, attached to the top of the composer like
 * the Agents list: the same header (label, count, chevron) and row geometry,
 * so the two read as one panel. Set apart as commands: the command itself in
 * monospace where an agent shows its name and task, and an empty action lane
 * kept only so the times line up with the agent rows above.
 */
export function ComposerBackgroundTasks(props: ComposerBackgroundTasksProps) {
  const count = props.shells.length
  const [manualExpanded, setManualExpanded] = useState<boolean | null>(null)
  const expanded = manualExpanded ?? count <= 3
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (count === 0 || props.syncDegraded) return
    setNow(Date.now())
    const interval = window.setInterval(() => setNow(Date.now()), 1_000)
    return () => window.clearInterval(interval)
  }, [count, props.syncDegraded])

  if (count === 0) return null

  return (
    <div
      data-background-tasks={count}
      data-background-tasks-expanded={expanded ? "true" : "false"}
      className="overflow-hidden bg-transparent"
    >
      <button
        type="button"
        data-testid="background-tasks-toggle"
        aria-expanded={expanded}
        className={cn("group/toggle flex w-full cursor-pointer items-center gap-1.5 px-4 pb-1.5 text-start text-xs", props.belowAgents ? "pt-2" : "pt-3")}
        onClick={() => setManualExpanded(!expanded)}
      >
        <span className="shrink-0 font-medium text-gray-12">{t("session.background_tasks_label")}</span>
        <span data-background-tasks-summary className="min-w-0 truncate text-gray-9 transition-colors group-hover/toggle:text-gray-11">
          {t("session.background_tasks_summary_running", { count })}
        </span>
        <ChevronRight
          aria-hidden="true"
          size={14}
          className={cn("shrink-0 text-gray-9 transition-transform duration-150 ease-out group-hover/toggle:text-gray-11 motion-reduce:transition-none", expanded && "rotate-90")}
        />
      </button>
      <div hidden={!expanded} className="max-h-44 overflow-y-auto pt-0.5 pb-2">
        {props.shells.map((shell) => (
          <BackgroundTaskRow key={shell.id} shell={shell} now={now} syncDegraded={props.syncDegraded} />
        ))}
      </div>
      {/* Inset hairline between the list and the message, on the composer text's edges. */}
      <div aria-hidden="true" className={cn("mx-4 h-px bg-dls-border", !expanded && "mt-1.5")} />
    </div>
  )
}

function BackgroundTaskRow(props: { shell: BackgroundShell; now: number; syncDegraded: boolean }) {
  const { shell } = props
  const command = commandPreview(shell.command) || t("session.background_tasks_label")
  const elapsed = shell.startedAt > 0 ? formatElapsedSeconds(Math.max(0, Math.floor((props.now - shell.startedAt) / 1_000))) : null
  return (
    <div
      data-background-task={shell.id}
      className="mx-2 flex h-9 min-w-0 items-center gap-3 rounded-lg px-2 text-[13px] transition-colors hover:bg-gray-2"
    >
      <code
        data-background-task-command=""
        title={shell.command}
        className="min-w-0 flex-1 truncate font-mono text-xs text-gray-11"
      >
        {command}
      </code>
      <span
        data-background-task-status=""
        className={cn("shrink-0 text-xs tabular-nums text-gray-9", !props.syncDegraded && "ow-text-shimmer")}
      >
        {props.syncDegraded ? t("session.subagent_tracker_reconnecting") : elapsed ? (
          <>
            <span className="sr-only">{t("session.background_task_running_prefix")} </span>
            {elapsed}
          </>
        ) : t("session.background_task_running_prefix")}
      </span>
      {/* Same width as an agent row's action lane, so the times line up. */}
      <span aria-hidden="true" className="w-[92px] shrink-0 max-sm:hidden" />
    </div>
  )
}
