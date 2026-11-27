import { useState } from "react"
import { Maximize2, X } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { t } from "@/i18n"
import { cn } from "@/lib/utils"
import { useLocal } from "@/react-app/kernel/local-provider"
import { WorkbenchPaneStatus } from "../chat/workbench-pane-status"
import type { RemoteThreadPanelTab } from "../panel/panel-tab-store"
import { RemoteThreadAnswerSlot } from "./remote-thread-answer-card"
import { useFollowRemoteThread, useRemoteThread, type RemoteThreadEntry } from "./remote-thread-store"
import { REMOTE_THREAD_PAGE_MAX, REMOTE_THREAD_PAGE_SIZE, useRemoteThreadConversation } from "./use-remote-thread-conversation"
import { RemoteFollowUpComposer } from "./remote-follow-up-composer"
import { RemoteTranscriptView } from "./remote-transcript-view"

export function RemoteThreadPanel({ tab, focused = false, onFocus, onClose, onExpand }: {
  tab: RemoteThreadPanelTab
  focused?: boolean
  onFocus?: () => void
  onClose?: () => void
  onExpand?: () => void
}) {
  const entry = useRemoteThread(tab.threadKey)
  useFollowRemoteThread(entry?.start ?? null, tab.owner, null)
  if (!entry) {
    return (
      <div className="flex h-full flex-col bg-dls-surface">
        <div className={cn("flex h-10 shrink-0 items-center justify-between gap-2 border-b border-border px-3", focused && "bg-muted/40")}>
          <span className="min-w-0 flex-1 truncate text-xs font-medium text-dls-text">{tab.label}</span>
          {onClose ? (
            <Button variant="ghost" size="icon-xs" aria-label={t("session_management.close_split_view")} title={t("session_management.close_split_view")} onClick={onClose}>
              <X />
            </Button>
          ) : null}
        </div>
        <div className="p-4 text-sm text-muted-foreground">{t("session.remote_task_read_failed")}</div>
      </div>
    )
  }
  return <RemoteThreadConversation key={entry.start.key} entry={entry} focused={focused} onFocus={onFocus} onClose={onClose} onExpand={onExpand} />
}

function RemoteThreadConversation({ entry, focused = false, onFocus, onClose, onExpand }: {
  entry: RemoteThreadEntry
  focused?: boolean
  onFocus?: () => void
  onClose?: () => void
  onExpand?: () => void
}) {
  const conversation = useRemoteThreadConversation(entry)
  const { view, stopping } = conversation
  const paneStatus = view.waitingFor ? "waiting" : view.state === "running" || view.state === "starting" ? "thinking" : view.state === "error" ? "error" : undefined

  return (
    <div className="flex h-full min-h-0 flex-col bg-dls-surface" data-remote-thread-panel={entry.start.key} data-remote-thread-state={view.state}>
      <div className={cn("flex h-10 shrink-0 items-center gap-1 border-b border-border px-3", focused && "bg-muted/40")} data-workbench-pane-header="secondary">
        <button type="button" className="flex min-w-0 flex-1 items-center gap-2 text-left text-xs" onClick={onFocus}>
          <WorkbenchPaneStatus status={paneStatus} attentionLabel={view.waitingFor ? view.status : undefined} />
          <span className="truncate font-medium text-dls-text" title={view.title}>{view.title}</span>
          <span className="shrink-0 truncate text-muted-foreground" data-remote-thread-computer="">{view.computer}</span>
        </button>
        {view.active && view.started ? (
          <Button
            variant="ghost"
            size="xs"
            disabled={stopping}
            aria-label={t(stopping ? "session.remote_task_stopping" : "session.remote_task_stop", { title: view.title })}
            onClick={() => void conversation.stop()}
          >
            {t(stopping ? "session.remote_task_stopping_short" : "session.remote_task_stop_short")}
          </Button>
        ) : null}
        {onExpand ? (
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label={t("session_management.expand_side_chat")}
            title={t("session_management.expand_side_chat")}
            onClick={onExpand}
          >
            <Maximize2 />
          </Button>
        ) : null}
        {onClose ? (
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label={t("session_management.close_split_view")}
            title={t("session_management.close_split_view")}
            onClick={onClose}
          >
            <X />
          </Button>
        ) : null}
      </div>

      <RemoteThreadTranscriptBody
        entry={entry}
        conversation={conversation}
        className="py-4 [&_.md\:px-10]:md:px-6 [&_.md\:px-8]:md:px-4"
      />

      <RemoteThreadAnswerSlot entry={entry} conversation={conversation} />

      <div className="mx-auto w-full max-w-3xl">
        <RemoteFollowUpComposer
          draft={conversation.draft}
          onDraftChange={conversation.setDraft}
          onSend={() => void conversation.sendFollowUp()}
          onStop={() => void conversation.stop()}
          computer={view.computer}
          running={view.active && view.started}
          disabled={!view.started}
          sending={conversation.sending}
          stopping={stopping}
          error={conversation.actionError}
        />
      </div>
    </div>
  )
}

export function RemoteThreadTranscriptBody({ entry, conversation, className }: {
  entry: RemoteThreadEntry
  conversation: ReturnType<typeof useRemoteThreadConversation>
  className?: string
}) {
  const local = useLocal()
  const [developerMode] = useState(() => typeof window !== "undefined" && window.localStorage.getItem("openwork.developerMode") === "1")
  const { view, page, transcript, limit, setLimit, readError, read, running, messages } = conversation
  const showStatusLine = !running || view.lastChecked !== null
  return (
    <div
      ref={conversation.scroller}
      className={cn("min-h-0 flex-1 overflow-y-auto py-3", className)}
      data-remote-thread-transcript=""
      onScroll={(event) => conversation.onScroll(event.currentTarget)}
    >
      <div className="flex flex-col gap-3">
        {page && transcript.length >= limit && limit < REMOTE_THREAD_PAGE_MAX ? (
          <Button variant="ghost" size="xs" className="self-center" onClick={() => setLimit((current) => Math.min(REMOTE_THREAD_PAGE_MAX, current + REMOTE_THREAD_PAGE_SIZE))}>
            {t("session.remote_task_earlier")}
          </Button>
        ) : null}
        <RemoteTranscriptView
          threadKey={entry.start.key}
          messages={messages}
          running={running && page !== null}
          waiting={Boolean(view.waitingFor)}
          runStartedAt={entry.activeSince}
          showThinking={local.prefs.showThinking}
          developerMode={developerMode}
        />
        {view.started && !page && !readError ? (
          <div className="mx-auto flex w-full max-w-3xl flex-col gap-2 px-2 md:px-10" aria-hidden="true" data-remote-thread-loading="">
            <Skeleton className="h-4 w-1/2" />
            <Skeleton className="h-4 w-11/12" />
            <Skeleton className="h-4 w-3/4" />
          </div>
        ) : null}
        {readError ? (
          <div className="mx-auto flex w-full max-w-3xl items-center gap-2 px-2 text-xs text-muted-foreground md:px-10" role="status">
            <span className="min-w-0 truncate">{t("session.remote_task_read_failed")}: {readError}</span>
            <Button variant="ghost" size="xs" onClick={() => void read()}>
              {t("session.remote_task_retry")}
            </Button>
          </div>
        ) : null}
        {showStatusLine ? (
          <span
            className={cn("mx-auto w-full max-w-3xl px-2 text-xs md:px-10", view.waitingFor ? "font-medium text-amber-11" : "text-muted-foreground/70", running && "ow-text-shimmer")}
            role="status"
            data-remote-thread-status=""
          >
            {view.state === "idle" ? t("session.remote_task_completed") : view.status}
            {view.lastChecked ? ` · ${view.lastChecked}` : ""}
          </span>
        ) : null}
      </div>
    </div>
  )
}
