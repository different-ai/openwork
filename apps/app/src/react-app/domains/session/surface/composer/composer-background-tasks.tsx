"use client"

import { useEffect, useState } from "react"
import { ChevronRight } from "lucide-react"

import { commandPreview } from "@/components/chat/background-tasks"
import { Button } from "@/components/ui/button"
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
  /** V2 only. Terminating a command also removes the engine's retained output. */
  onStop?: (shellID: string) => Promise<void>
}

/**
 * Commands the agent left running, attached to the top of the composer like
 * the Agents list: the same header (label, count, chevron) and row geometry,
 * so the two read as one panel. Set apart as commands: the command itself in
 * monospace where an agent shows its name and task, with Stop in the same
 * fixed action lane as the agent rows above.
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
          <BackgroundTaskRow key={shell.id} shell={shell} now={now} syncDegraded={props.syncDegraded} onStop={props.onStop} />
        ))}
      </div>
      {/* Inset hairline between the list and the message, on the composer text's edges. */}
      <div aria-hidden="true" className={cn("mx-4 h-px bg-dls-border", !expanded && "mt-1.5")} />
    </div>
  )
}

function BackgroundTaskRow(props: { shell: BackgroundShell; now: number; syncDegraded: boolean; onStop?: (shellID: string) => Promise<void> }) {
  const { shell, onStop } = props
  const [stopping, setStopping] = useState(false)
  const [stopFailed, setStopFailed] = useState(false)
  const stop = async () => {
    if (!onStop || stopping || props.syncDegraded) return
    setStopFailed(false)
    setStopping(true)
    try {
      await onStop(shell.id)
    } catch {
      setStopFailed(true)
    } finally {
      setStopping(false)
    }
  }
  const command = commandPreview(shell.command) || t("session.background_tasks_label")
  const elapsed = shell.startedAt > 0 ? formatElapsedSeconds(Math.max(0, Math.floor((props.now - shell.startedAt) / 1_000))) : null
  return (
    <div
      data-background-task={shell.id}
      className="group/row mx-2 flex h-9 min-w-0 items-center gap-3 rounded-lg px-2 text-[13px] transition-colors hover:bg-gray-2 focus-within:bg-gray-2"
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
        role={stopFailed ? "alert" : undefined}
        className={cn("shrink-0 text-xs tabular-nums", stopFailed ? "text-red-11" : "text-gray-9", !props.syncDegraded && !stopping && !stopFailed && "ow-text-shimmer")}
      >
        {stopping ? t("session.subagent_tracker_stopping") : stopFailed ? t("session.background_task_stop_failed") : props.syncDegraded ? t("session.subagent_tracker_reconnecting") : elapsed ? (
          <>
            <span className="sr-only">{t("session.background_task_running_prefix")} </span>
            {elapsed}
          </>
        ) : t("session.background_task_running_prefix")}
      </span>
      {/* Same action lane as an agent row; keep Stop visible on focus, touch, or failure. */}
      <span className={cn("flex w-[92px] shrink-0 justify-end max-sm:w-auto", !onStop && "max-sm:hidden")}>
        {onStop ? (
          <Button
            type="button"
            variant="ghost"
            size="xs"
            data-background-task-stop=""
            aria-label={t("session.background_task_stop", { command })}
            title={props.syncDegraded ? t("session.subagent_tracker_reconnecting") : t("session.background_task_stop_hint")}
            disabled={stopping || props.syncDegraded}
            className={cn("text-gray-11 hover:text-gray-12", !stopFailed && !stopping && "opacity-0 transition-opacity group-hover/row:opacity-100 group-focus-within/row:opacity-100 [@media(hover:none)]:opacity-100")}
            onClick={() => void stop()}
          >
            {stopFailed ? t("session.background_task_stop_retry") : t("text_activity.stop")}
          </Button>
        ) : null}
      </span>
    </div>
  )
}
