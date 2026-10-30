import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react"
import type { UIMessage } from "ai"

import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { t } from "@/i18n"
import { latestUserMessageId, type RemoteTranscriptPage } from "@/lib/remote-session-thread"
import { remoteTranscriptToUIMessages } from "@/lib/remote-transcript-messages"
import { cn } from "@/lib/utils"
import { useLocal } from "@/react-app/kernel/local-provider"
import type { RemoteThreadPanelTab } from "../panel/panel-tab-store"
import { readRemoteThread, sendRemoteFollowUp, stopRemoteThread } from "./remote-thread-actions"
import { useFollowRemoteThread, useRemoteThread, useRemoteThreadsEnabled, useRemoteThreadViewEnabled, type RemoteThreadEntry } from "./remote-thread-store"
import { remoteThreadView } from "./remote-thread-view"
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

const PAGE_SIZE = 30
const PAGE_MAX = 100
const READ_GAP_MS = 4_000

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

type FollowUp = { id: string; text: string }

/** How close to the end counts as following along, so new steps keep the view at the bottom. */
const FOLLOW_SLACK_PX = 48

function userTurn(id: string, text: string): UIMessage {
  return { id, role: "user", parts: [{ type: "text", text }] }
}

function RemoteThreadConversation({ entry }: { entry: RemoteThreadEntry }) {
  const local = useLocal()
  // Same switch the chat reads; it only adds raw details to error cards.
  const [developerMode] = useState(() => typeof window !== "undefined" && window.localStorage.getItem("openwork.developerMode") === "1")
  const [now, setNow] = useState(() => Date.now())
  const [stoppedHere, setStoppedHere] = useState(false)
  const view = remoteThreadView(entry.start, entry, now, stoppedHere)
  const [page, setPage] = useState<RemoteTranscriptPage | null>(null)
  const [readError, setReadError] = useState<string | null>(null)
  const [limit, setLimit] = useState(PAGE_SIZE)
  const [sent, setSent] = useState<FollowUp[]>([])
  const [draft, setDraft] = useState("")
  const [sending, setSending] = useState(false)
  const [stopping, setStopping] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)
  const latest = useRef({ entry, limit })
  latest.current = { entry, limit }
  const reads = useRef({ inflight: false, again: false, lastAt: 0, mounted: true })
  const scroller = useRef<HTMLDivElement>(null)
  const following = useRef(true)

  useEffect(() => {
    reads.current.mounted = true
    return () => { reads.current.mounted = false }
  }, [])

  useEffect(() => {
    if (view.state !== "running") return
    const interval = window.setInterval(() => setNow(Date.now()), 1_000)
    return () => window.clearInterval(interval)
  }, [view.state])

  const read = useCallback(async function read(): Promise<void> {
    const state = reads.current
    if (state.inflight) {
      state.again = true
      return
    }
    state.inflight = true
    state.lastAt = Date.now()
    try {
      const outcome = await readRemoteThread(latest.current.entry, { limit: latest.current.limit })
      if (!state.mounted) return
      if (outcome.kind === "page") {
        setPage(outcome.page)
        setReadError(null)
        // A follow-up stays shown as sent until the transcript has it.
        setSent((current) => current.filter((followUp) => !outcome.page.messages.some((message) => message.role === "user" && message.text.trim() === followUp.text)))
      } else if (outcome.kind === "error") {
        setReadError(outcome.message)
      }
    } finally {
      state.inflight = false
      if (state.again && state.mounted) {
        state.again = false
        window.setTimeout(() => void read(), READ_GAP_MS)
      }
    }
  }, [])

  // On open, then once per status change (a step, an answer, a new state).
  useEffect(() => {
    if (!view.started) return
    const wait = Math.max(0, reads.current.lastAt + READ_GAP_MS - Date.now())
    const timer = window.setTimeout(() => void read(), wait)
    return () => window.clearTimeout(timer)
  }, [entry.version, view.started, limit, read])

  const transcript = page?.messages ?? []
  const running = view.state === "running"
  const messages = useMemo(() => [
    // The task as the agent sent it, until its computer's transcript arrives.
    ...(page ? remoteTranscriptToUIMessages(page.messages, { running }) : entry.start.prompt ? [userTurn(`${entry.start.key}:prompt`, entry.start.prompt)] : []),
    ...sent.map((followUp) => userTurn(followUp.id, followUp.text)),
  ], [page, running, entry.start.key, entry.start.prompt, sent])

  // Keep following the newest step while the person is at the end.
  useLayoutEffect(() => {
    const element = scroller.current
    if (element && following.current) element.scrollTop = element.scrollHeight
  }, [messages])

  async function sendFollowUp() {
    const text = draft.trim()
    if (!text || !view.started || sending) return
    setSending(true)
    setActionError(null)
    const failure = await sendRemoteFollowUp(entry, text)
    setSending(false)
    if (failure) {
      setActionError(failure.message)
      return
    }
    setDraft("")
    following.current = true
    setSent((current) => [...current, { id: `follow-up:${Date.now()}`, text }])
  }

  async function stop() {
    setStopping(true)
    setActionError(null)
    const failure = await stopRemoteThread(entry, latestUserMessageId(transcript))
    setStopping(false)
    if (failure) setActionError(failure.message)
    else setStoppedHere(true)
  }

  // While it works, the transcript's own Working line says so.
  const showStatusLine = !running || view.lastChecked !== null

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
            onClick={() => void stop()}
          >
            {t(stopping ? "session.remote_task_stopping_short" : "session.remote_task_stop_short")}
          </Button>
        ) : null}
      </div>

      <div
        ref={scroller}
        // The chat's rows are padded for a full-width pane; beside the chat they take the panel's width.
        className="min-h-0 flex-1 overflow-y-auto py-3 [&_.md\:px-10]:md:px-3 [&_.md\:px-8]:md:px-2"
        data-remote-thread-transcript=""
        onScroll={(event) => {
          const element = event.currentTarget
          following.current = element.scrollHeight - element.scrollTop - element.clientHeight <= FOLLOW_SLACK_PX
        }}
      >
        <div className="flex flex-col gap-3">
          {page && transcript.length >= limit && limit < PAGE_MAX ? (
            <Button variant="ghost" size="xs" className="self-center" onClick={() => setLimit((current) => Math.min(PAGE_MAX, current + PAGE_SIZE))}>
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

      {view.waitingFor ? (
        <div className="shrink-0 border-t border-border px-4 py-2 text-xs text-amber-11" data-remote-thread-waiting={view.waitingFor}>
          {t("session.remote_task_answer_there", { computer: view.computer })}
        </div>
      ) : null}

      <RemoteFollowUpComposer
        draft={draft}
        onDraftChange={setDraft}
        onSend={() => void sendFollowUp()}
        onStop={() => void stop()}
        computer={view.computer}
        running={view.active && view.started}
        disabled={!view.started}
        sending={sending}
        stopping={stopping}
        error={actionError}
      />
    </div>
  )
}
