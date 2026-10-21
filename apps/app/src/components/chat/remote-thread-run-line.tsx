"use client"

import { useEffect, useState } from "react"
import type { DynamicToolUIPart } from "ai"
import { ArrowUpRight, ShieldAlert, Square } from "lucide-react"

import { useMessageList } from "@/components/chat/message-list-provider"
import { t } from "@/i18n"
import { remoteToolCallStartedAt, type RemoteThreadStart } from "@/lib/remote-session-thread"
import { cn } from "@/lib/utils"
import { usePanelTabStore } from "@/react-app/domains/session/panel/panel-tab-store"
import { stopRemoteThread } from "@/react-app/domains/session/remote-threads/remote-thread-actions"
import { useFollowRemoteThread, useRemoteThread } from "@/react-app/domains/session/remote-threads/remote-thread-store"
import { remoteThreadView } from "@/react-app/domains/session/remote-threads/remote-thread-view"
import { RemoteThreadActionRecovery } from "@/react-app/domains/session/remote-threads/remote-thread-action-recovery"
import { useUiStateStore } from "@/react-app/shell/ui-state-store"

/** Opens a task's conversation beside the chat; it never opens by itself (DESIGN.md S5). */
export function openRemoteThreadPanel(sessionId: string, workspaceId: string, start: RemoteThreadStart, label: string) {
  usePanelTabStore.getState().openTab(sessionId, {
    type: "remote-thread",
    id: `remote-thread:${start.key}`,
    label,
    threadKey: start.key,
    owner: { workspaceId, sessionId },
  })
  useUiStateStore.getState().setSidePanelState(sessionId, "panel")
}

/**
 * A task the agent started on another computer, shown like a sub-agent: line 1
 * names the task and where it runs, line 2 says what it is doing now. The row
 * opens its conversation in the side panel, where the person follows up; its
 * own Stop ends just that task. Its state comes from the chat's one shared
 * follower (remote-thread-store), never a poll of its own.
 */
export function RemoteThreadRunLine({ start, part, className }: { start: RemoteThreadStart; part: DynamicToolUIPart; className?: string }) {
  const { workspaceId, sessionId, readOnly } = useMessageList()
  useFollowRemoteThread(start, { workspaceId, sessionId }, remoteToolCallStartedAt(part))
  const entry = useRemoteThread(start.key)
  const stopping = entry?.stop?.phase === "requesting"
  const stopPending = Boolean(entry?.stop && entry.stop.phase !== "failed")
  const [now, setNow] = useState(() => Date.now())
  const view = remoteThreadView(start, entry, now)
  const ticking = view.state === "running" && !view.lastChecked && !stopPending
  const clockIntervalMs = ticking ? 1_000 : view.active || view.lastChecked ? 30_000 : null
  useEffect(() => {
    if (clockIntervalMs === null) return
    setNow(Date.now())
    const interval = window.setInterval(() => setNow(Date.now()), clockIntervalMs)
    return () => window.clearInterval(interval)
  }, [clockIntervalMs])

  return (
    <div
      data-remote-thread={start.key}
      data-remote-thread-state={view.state}
      data-remote-thread-waiting={view.waitingFor ?? undefined}
      // The open button stays a direct child of the row, like a sub-agent row.
      className={cn("flex min-w-0 max-w-full items-start gap-2", className)}
    >
      <div className="min-w-0">
      <button
        type="button"
        className="group flex min-w-0 max-w-full cursor-pointer flex-col gap-0.5 text-start text-sm text-muted-foreground transition-colors hover:text-foreground"
        aria-label={t("session.remote_task_open", { title: view.title, computer: view.computer })}
        onClick={() => openRemoteThreadPanel(sessionId, workspaceId, start, view.title)}
      >
        <span className="flex min-w-0 items-center gap-2">
          <span className={cn("min-w-0 truncate", ticking && "ow-text-shimmer")}>
            {view.title}
            <span className="text-muted-foreground/70"> · {view.computer}</span>
          </span>
          {view.waitingFor === "permission" ? (
            <ShieldAlert aria-hidden="true" className="size-3.5 shrink-0 text-amber-10" />
          ) : null}
          <ArrowUpRight
            aria-hidden="true"
            className="size-3.5 shrink-0 text-muted-foreground/70 opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100"
          />
        </span>
        <span className={cn("min-w-0 truncate text-xs", view.waitingFor ? "font-medium text-amber-11" : "text-muted-foreground/70")}>
          {view.status}
          {view.lastChecked ? ` · ${view.lastChecked}` : ""}
        </span>
      </button>
      {entry && !readOnly ? <RemoteThreadActionRecovery entry={entry} action={entry.stop} /> : null}
      </div>
      {/* Stop just this task; the turn's own Stop stays in the composer. */}
      {view.active && view.started && entry && !readOnly ? (
        <button
          type="button"
          data-remote-thread-stop=""
          disabled={stopPending}
          aria-label={t(stopping ? "session.remote_task_stopping" : "session.remote_task_stop", { title: view.title })}
          className="mt-0.5 flex size-5 shrink-0 cursor-pointer items-center justify-center rounded-md text-muted-foreground/70 transition-colors hover:bg-muted hover:text-foreground disabled:cursor-default disabled:opacity-50"
          onClick={() => void stopRemoteThread(entry)}
        >
          <Square className="size-2.5 fill-current" aria-hidden="true" />
        </button>
      ) : null}
    </div>
  )
}
