import * as React from "react"
import type { UIMessage } from "ai"
import { SquareTerminal } from "lucide-react"

import {
  backgroundShellNoticeLabel,
  readBackgroundShellNotice,
  runningBackgroundTasksLabel,
  type BackgroundShellNotice,
} from "@/app/lib/background-shell-tasks"
import { formatElapsedSeconds } from "@/lib/tool-call-duration"
import { Message } from "@/components/ui/message"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"
import { formatRelativeTime } from "@/app/utils"
import { TaskRecovery } from "./task-recovery"
import { useBackgroundShellStore, type BackgroundShell } from "@/react-app/domains/session/status/background-shell-store"

const COMMAND_PREVIEW_LENGTH = 80

function commandPreview(command: string): string {
  const oneLine = command.replace(/\s+/g, " ").trim()
  return oneLine.length > COMMAND_PREVIEW_LENGTH ? `${oneLine.slice(0, COMMAND_PREVIEW_LENGTH - 1)}…` : oneLine
}

/** The completion notice a transcript message carries, if it is one. */
export function backgroundShellNoticeFromMessage(message: UIMessage): BackgroundShellNotice | null {
  if (message.role !== "system") return null
  for (const part of message.parts) {
    if (part.type !== "text") continue
    const notice = readBackgroundShellNotice(part.providerMetadata?.opencode?.backgroundShell)
    if (notice) return notice
  }
  return null
}

/**
 * Where a background command ended, in the transcript: one quiet row in the
 * step rail's shape (terminal glyph, sentence, command), never the engine's
 * raw `<shell>` hand-off text.
 */
export const BackgroundTaskNotice = React.memo(function BackgroundTaskNotice({ message, notice }: { message: UIMessage; notice: BackgroundShellNotice }) {
  // A row cached while the feature was on stays hidden after it is turned off.
  const enabled = useBackgroundShellStore((state) => state.enabled)
  const command = commandPreview(notice.command)
  if (!enabled) return null
  return (
    <Message
      className="mx-auto flex w-full max-w-3xl flex-col items-start gap-2 px-2 md:px-10"
      data-message-id={message.id}
      data-message-role={message.role}
    >
      <div
        data-background-task-notice={notice.outcome}
        className="flex w-full min-w-0 items-center gap-2 py-1 text-sm text-muted-foreground"
      >
        <SquareTerminal aria-hidden="true" className="size-4 shrink-0" />
        {notice.outcome === "failed" || notice.outcome === "timed-out" ? <TaskRecovery compact title={backgroundShellNoticeLabel(notice)}
          description="Ask to review the command's output before trying again."
          technicalDetails={[notice.command, notice.exit !== null ? `Exit code: ${notice.exit}` : null].filter(Boolean).join("\n")} />
          : <span className="shrink-0">{backgroundShellNoticeLabel(notice)}</span>}
        {command ? <code className="min-w-0 truncate font-mono text-xs opacity-80" title={notice.command}>{command}</code> : null}
      </div>
    </Message>
  )
})

type BackgroundTasksProps = {
  shells: BackgroundShell[]
  /** The connection cannot confirm the count right now: show it without the live shimmer. */
  stale?: boolean
}

type BackgroundTasksLabelProps = BackgroundTasksProps & {
  /** Off when the label sits inside a line whose one shimmer already covers it. */
  shimmer?: boolean
}

/**
 * "2 running background tasks": commands the agent left running. Same
 * shimmer as the turn's "Working" line. The list stays one hover (or focus)
 * away: each command and how long it has been running.
 */
export const BackgroundTasksLabel = React.memo(function BackgroundTasksLabel({ shells, stale = false, shimmer = true }: BackgroundTasksLabelProps) {
  const [open, setOpen] = React.useState(false)
  const uncertain = stale || shells.some((shell) => shell.stale)
  const checkedAt = Math.min(...shells.map((shell) => shell.checkedAt ?? shell.observedAt))
  const [now, setNow] = React.useState(() => Date.now())
  React.useEffect(() => {
    if (!open && !uncertain) return
    setNow(Date.now())
    const interval = window.setInterval(() => setNow(Date.now()), open ? 1_000 : 30_000)
    return () => window.clearInterval(interval)
  }, [open, uncertain])
  return (
    <span data-background-tasks={shells.length}>
      <Tooltip open={open} onOpenChange={setOpen}>
        <TooltipTrigger
          render={<span tabIndex={0} />}
          className={cn("cursor-default rounded-sm tabular-nums outline-none focus-visible:ring-2 focus-visible:ring-ring/50", uncertain && "text-muted-foreground", shimmer && !uncertain && "ow-text-shimmer")}
        >
          {uncertain ? `${shells.length} background ${shells.length === 1 ? "task" : "tasks"} last known running · ${Number.isFinite(checkedAt) ? `checked ${formatRelativeTime(checkedAt)}` : "last check unknown"} · couldn't verify` : runningBackgroundTasksLabel(shells.length)}
        </TooltipTrigger>
        <TooltipContent side="top" align="start" className="flex-col items-stretch gap-1">
          {uncertain ? <span>Last confirmed {Number.isFinite(checkedAt) ? formatRelativeTime(checkedAt) : "at an unknown time"}. Reopen the conversation to check again.</span> : null}
          {shells.map((shell) => (
            <span key={shell.id} className="flex min-w-0 items-center gap-3">
              <code className="min-w-0 flex-1 truncate font-mono">{commandPreview(shell.command) || "Command"}</code>
              {shell.startedAt > 0 ? (
                <span className="shrink-0 tabular-nums opacity-70">
                  {formatElapsedSeconds(Math.max(0, Math.floor((now - shell.startedAt) / 1_000)))}
                </span>
              ) : null}
            </span>
          ))}
        </TooltipContent>
      </Tooltip>
    </span>
  )
})

/**
 * The count on its own line, once the turn is over. It takes the Working
 * line's place with the same height, so the chat does not move when the
 * turn ends and the count stays.
 */
export const BackgroundTasksMessage = React.memo(function BackgroundTasksMessage(props: BackgroundTasksProps) {
  return (
    <Message className="mx-auto flex w-full max-w-3xl flex-col items-start gap-2 px-2 md:px-10">
      <div role="status" data-background-tasks-line="" className="py-1 text-sm text-muted-foreground">
        <BackgroundTasksLabel {...props} />
      </div>
    </Message>
  )
})
