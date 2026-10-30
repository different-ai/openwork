import { useState, type ReactNode } from "react"

import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { t } from "@/i18n"
import { cn } from "@/lib/utils"
import { useLocal } from "@/react-app/kernel/local-provider"
import type { RemoteThreadPanelTab } from "../panel/panel-tab-store"
import { answerRemoteThread } from "./remote-thread-actions"
import { RemoteThreadAnswerCard } from "./remote-thread-answer-card"
import { useFollowRemoteThread, useRemoteThread, useRemoteThreadAnswersEnabled, useRemoteThreadsEnabled, useRemoteThreadViewEnabled, type RemoteThreadEntry } from "./remote-thread-store"
import { REMOTE_THREAD_PAGE_MAX, REMOTE_THREAD_PAGE_SIZE, useRemoteThreadConversation } from "./use-remote-thread-conversation"
import { RemoteFollowUpComposer } from "./remote-follow-up-composer"
import { RemoteTranscriptView } from "./remote-transcript-view"

/**
 * A task on another computer, opened beside the chat: its conversation,
 * rendered step by step by the main chat renderer, what it waits on, and the
 * composer to follow up on it or stop it.
 *
 * The transcript is the heavy read (a desktop answers it from its own
 * session), so it is read when the panel opens and then only when the shared
 * status says the task changed, at most every few seconds and one at a time.
 * Nothing is read while the panel is closed.
 */

export function RemoteThreadPanel({ tab }: { tab: RemoteThreadPanelTab }) {
  const enabled = useRemoteThreadsEnabled()
  const threadView = useRemoteThreadViewEnabled()
  const entry = useRemoteThread(tab.threadKey)
  // The open panel keeps the task followed, like its row.
  useFollowRemoteThread(entry?.start ?? null, tab.owner, null)
  if (!threadView) {
    return (
      <div className="p-4 text-sm text-muted-foreground" data-remote-thread-disabled>
        {t(enabled ? "session.remote_task_thread_view_disabled" : "session.remote_task_disabled")}
      </div>
    )
  }
  if (!entry) {
    return <div className="p-4 text-sm text-muted-foreground">{t("session.remote_task_read_failed")}</div>
  }
  return <RemoteThreadConversation key={entry.start.key} entry={entry} />
}

function RemoteThreadConversation({ entry }: { entry: RemoteThreadEntry }) {
  const conversation = useRemoteThreadConversation(entry)
  const { view, stopping, page } = conversation
  const answers = useRemoteThreadAnswersEnabled()

  return (
    <div className="flex h-full min-h-0 flex-col" data-remote-thread-panel={entry.start.key} data-remote-thread-state={view.state}>
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-border px-3">
        <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">{view.title}</span>
        <span className="shrink-0 text-xs text-muted-foreground" data-remote-thread-computer="">{view.computer}</span>
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
      </div>

      <RemoteThreadTranscriptBody
        entry={entry}
        conversation={conversation}
        // The chat's rows are padded for a full-width pane; beside the chat they take the panel's width.
        className="[&_.md\:px-10]:md:px-3 [&_.md\:px-8]:md:px-2"
      />

      {view.waitingFor && answers && page?.pending?.kind === view.waitingFor ? (
        <RemoteThreadAnswerCard pending={page.pending} computer={view.computer} onAnswer={(answer) => answerRemoteThread(entry, answer)} />
      ) : view.waitingFor ? (
        <div className="shrink-0 border-t border-border px-4 py-2 text-xs text-amber-11" data-remote-thread-waiting={view.waitingFor}>
          {t("session.remote_task_answer_there", { computer: view.computer })}
        </div>
      ) : null}

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
  )
}

/** The scrolling transcript, its loading and error states and the state line, shared by the panel and the helper view. */
export function RemoteThreadTranscriptBody({ entry, conversation, className, children }: {
  entry: RemoteThreadEntry
  conversation: ReturnType<typeof useRemoteThreadConversation>
  className?: string
  /** Shown above the transcript, e.g. the task folded as one line. */
  children?: ReactNode
}) {
  const local = useLocal()
  // Same switch the chat reads; it only adds raw details to error cards.
  const [developerMode] = useState(() => typeof window !== "undefined" && window.localStorage.getItem("openwork.developerMode") === "1")
  const { view, page, transcript, limit, setLimit, readError, read, running, messages } = conversation
  // While it works, the transcript's own Working line says so.
  const showStatusLine = !running || view.lastChecked !== null
  return (
    <div
      ref={conversation.scroller}
      className={cn("min-h-0 flex-1 overflow-y-auto py-3", className)}
      data-remote-thread-transcript=""
      onScroll={(event) => conversation.onScroll(event.currentTarget)}
    >
      <div className="flex flex-col gap-3">
        {children}
        {page && transcript.length >= limit && limit < REMOTE_THREAD_PAGE_MAX ? (
          <Button variant="ghost" size="xs" className="self-center" onClick={() => setLimit((current) => Math.min(REMOTE_THREAD_PAGE_MAX, current + REMOTE_THREAD_PAGE_SIZE))}>
            {t("session.remote_task_earlier")}
          </Button>
        ) : null}
        <RemoteTranscriptView
          threadKey={entry.start.key}
          messages={messages}
          running={running && page !== null}
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
