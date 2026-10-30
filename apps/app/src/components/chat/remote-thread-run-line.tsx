"use client"

import { useEffect, useState, type ReactNode } from "react"
import type { DynamicToolUIPart } from "ai"
import { ArrowUpRight, ChevronRight, ShieldAlert, Square } from "lucide-react"

import { useMessageList } from "@/components/chat/message-list-provider"
import { t } from "@/i18n"
import { remoteToolCallStartedAt, type RemoteThreadStart } from "@/lib/remote-session-thread"
import { cn } from "@/lib/utils"
import { usePanelTabStore } from "@/react-app/domains/session/panel/panel-tab-store"
import { RemoteThreadRowAnswers } from "@/react-app/domains/session/remote-threads/remote-thread-row-answers"
import { stopRemoteThread } from "@/react-app/domains/session/remote-threads/remote-thread-actions"
import {
  useFollowRemoteThread, useRemoteThread, useRemoteThreadAnswersEnabled, useRemoteThreadHelperViewEnabled, useRemoteThreadViewEnabled,
} from "@/react-app/domains/session/remote-threads/remote-thread-store"
import { rowQuestionOptions } from "@/lib/remote-session-answers"
import { remoteThreadSentence, remoteThreadView, type RemoteThreadView } from "@/react-app/domains/session/remote-threads/remote-thread-view"
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
 * names the task and where it runs, line 2 says what it is doing now. With
 * `remoteSessionThreadView` the row opens its conversation in the side panel,
 * where the person follows up; its own Stop ends just that task. Its state
 * comes from the chat's one shared follower (remote-thread-store), never a
 * poll of its own.
 */
export function RemoteThreadRunLine({ start, part, className }: { start: RemoteThreadStart; part: DynamicToolUIPart; className?: string }) {
  const { workspaceId, sessionId, readOnly, onOpenRemoteTask } = useMessageList()
  useFollowRemoteThread(start, { workspaceId, sessionId }, remoteToolCallStartedAt(part))
  const entry = useRemoteThread(start.key)
  const threadView = useRemoteThreadViewEnabled()
  const helperView = useRemoteThreadHelperViewEnabled()
  const answers = useRemoteThreadAnswersEnabled()
  const [stopping, setStopping] = useState(false)
  const [stoppedHere, setStoppedHere] = useState(false)
  const [now, setNow] = useState(() => Date.now())
  const view = remoteThreadView(start, entry, now, stoppedHere)
  const ticking = view.state === "running" && !view.lastChecked
  useEffect(() => {
    if (!ticking) return
    const interval = window.setInterval(() => setNow(Date.now()), 1_000)
    return () => window.clearInterval(interval)
  }, [ticking])
  const stop = view.active && view.started && entry && !readOnly ? () => {
    setStopping(true)
    void stopRemoteThread(entry).then((failure) => {
      if (!failure) setStoppedHere(true)
    }).finally(() => setStopping(false))
  } : null

  // `remoteSessionAnswers`: a single-choice question's options sit under the
  // row, whichever row style shows. Flag off, read-only, or nothing a row can
  // answer: exactly the row as before.
  const choices = answers && entry && !readOnly && view.waitingFor === "question" ? rowQuestionOptions(entry.status?.pending) : null
  const withAnswers = (row: ReactNode, openTask: (() => void) | null) => {
    if (!entry || !choices) return row
    return (
      <div className="flex min-w-0 max-w-full flex-col gap-1.5">
        {row}
        <RemoteThreadRowAnswers entry={entry} choices={choices} openPanel={openTask} />
      </div>
    )
  }

  if (helperView) {
    // Opens like a local helper: in the main pane where it can be steered,
    // or beside the chat where this chat can't navigate (a split pane).
    const open = onOpenRemoteTask
      ? () => onOpenRemoteTask(start)
      : () => openRemoteThreadPanel(sessionId, workspaceId, start, view.title)
    return withAnswers(<RemoteThreadSentenceRow start={start} view={view} className={className} open={open} stop={stop} stopping={stopping} />, open)
  }

  return withAnswers((
    <div
      data-remote-thread={start.key}
      data-remote-thread-state={view.state}
      data-remote-thread-waiting={view.waitingFor ?? undefined}
      // The open button stays a direct child of the row, like a sub-agent row.
      className={cn("flex min-w-0 max-w-full items-start gap-2", className)}
    >
      <RemoteThreadSummary
        open={threadView ? () => openRemoteThreadPanel(sessionId, workspaceId, start, view.title) : null}
        label={t("session.remote_task_open", { title: view.title, computer: view.computer })}
      >
        <span className="flex min-w-0 items-center gap-2">
          <span className={cn("min-w-0 truncate", ticking && "ow-text-shimmer")}>
            {view.title}
            <span className="text-muted-foreground/70"> · {view.computer}</span>
          </span>
          {view.waitingFor === "permission" ? (
            <ShieldAlert aria-hidden="true" className="size-3.5 shrink-0 text-amber-10" />
          ) : null}
          {threadView ? (
            <ArrowUpRight
              aria-hidden="true"
              className="size-3.5 shrink-0 text-muted-foreground/70 opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100"
            />
          ) : null}
        </span>
        <span className={cn("min-w-0 truncate text-xs", view.waitingFor ? "font-medium text-amber-11" : "text-muted-foreground/70")}>
          {view.status}
          {view.lastChecked ? ` · ${view.lastChecked}` : ""}
        </span>
      </RemoteThreadSummary>
      {/* Stop just this task; the turn's own Stop stays in the composer. */}
      {stop ? <RemoteThreadStopButton title={view.title} stopping={stopping} onStop={stop} /> : null}
    </div>
  ), threadView ? () => openRemoteThreadPanel(sessionId, workspaceId, start, view.title) : null)
}

function RemoteThreadStopButton({ title, stopping, onStop }: { title: string; stopping: boolean; onStop: () => void }) {
  return (
    <button
      type="button"
      data-remote-thread-stop=""
      disabled={stopping}
      aria-label={t(stopping ? "session.remote_task_stopping" : "session.remote_task_stop", { title })}
      className="mt-0.5 flex size-5 shrink-0 cursor-pointer items-center justify-center rounded-md text-muted-foreground/70 transition-colors hover:bg-muted hover:text-foreground disabled:cursor-default disabled:opacity-50"
      onClick={onStop}
    >
      <Square className="size-2.5 fill-current" aria-hidden="true" />
    </button>
  )
}

/**
 * `remoteSessionHelperView`: the row reads as one sentence, like a local
 * helper's (DESIGN.md C4): "Working on Studio computer · Check the release
 * notes ›" with the text shimmering while it runs (V6), then
 * "12m 4s, last ran: Read v1.1.md". Waiting is amber, everything else neutral.
 */
export function RemoteThreadSentenceRow({ start, view, className, open, stop, stopping }: {
  start: RemoteThreadStart
  view: RemoteThreadView
  className?: string
  open: () => void
  stop: (() => void) | null
  stopping: boolean
}) {
  const sentence = remoteThreadSentence(start, view)
  const running = sentence.tone === "running"
  const waiting = sentence.tone === "waiting"
  return (
    <div
      data-remote-thread={start.key}
      data-remote-thread-state={view.state}
      data-remote-thread-waiting={view.waitingFor ?? undefined}
      data-remote-thread-sentence={sentence.tone}
      className={cn("flex min-w-0 max-w-full items-start gap-2", className)}
    >
      <button
        type="button"
        className="group flex min-w-0 max-w-full cursor-pointer flex-col gap-0.5 text-start text-sm transition-colors"
        aria-label={t("session.remote_task_open", { title: view.title, computer: view.computer })}
        onClick={open}
      >
        <span className="flex min-w-0 max-w-full items-center gap-1">
          <span className={cn("min-w-0 truncate", running && !view.lastChecked && "ow-text-shimmer")}>
            <span className={cn(waiting ? "font-medium text-amber-11" : "text-muted-foreground group-hover:text-foreground")} data-remote-thread-lead="">
              {sentence.lead}
            </span>
            <span className="text-muted-foreground/70"> · </span>
            <span className="text-muted-foreground/70 group-hover:text-muted-foreground" data-remote-thread-title="">{sentence.title}</span>
          </span>
          <ChevronRight aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground/70" />
        </span>
        {sentence.detail ? (
          <span className={cn("min-w-0 truncate text-xs", waiting ? "text-amber-11" : sentence.tone === "failed" ? "text-red-11" : "text-muted-foreground/70")} data-remote-thread-detail="">
            {sentence.detail}
          </span>
        ) : null}
      </button>
      {stop ? <RemoteThreadStopButton title={view.title} stopping={stopping} onStop={stop} /> : null}
    </div>
  )
}

/** The row's two lines: a button that opens the conversation, or just progress. */
function RemoteThreadSummary({ open, label, children }: { open: (() => void) | null; label: string; children: ReactNode }) {
  if (!open) return <div className="flex min-w-0 max-w-full flex-col gap-0.5 text-sm text-muted-foreground">{children}</div>
  return (
    <button
      type="button"
      className="group flex min-w-0 max-w-full cursor-pointer flex-col gap-0.5 text-start text-sm text-muted-foreground transition-colors hover:text-foreground"
      aria-label={label}
      onClick={open}
    >
      {children}
    </button>
  )
}
