import { useCallback, useEffect, useRef, useState } from "react"
import { CircleHelp, RotateCw, ShieldAlert, Square } from "lucide-react"

import { MarkdownBlock } from "@/components/markdown/markdown"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { Textarea } from "@/components/ui/textarea"
import { t } from "@/i18n"
import { latestUserMessageId, type RemoteTranscriptPage } from "@/lib/remote-session-thread"
import { cn } from "@/lib/utils"
import type { RemoteThreadPanelTab } from "../panel/panel-tab-store"
import { readRemoteThread, sendRemoteFollowUp, stopRemoteThread } from "./remote-thread-actions"
import { useFollowRemoteThread, useRemoteThread, useRemoteThreadsEnabled, useRemoteThreadViewEnabled, type RemoteThreadEntry } from "./remote-thread-store"
import { remoteThreadView } from "./remote-thread-view"

/**
 * A task on another computer, opened beside the chat: its conversation, what
 * it waits on, and a box to follow up on it.
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

function RemoteThreadConversation({ entry }: { entry: RemoteThreadEntry }) {
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

  const messages = page?.messages ?? []
  const shownPrompt = !page && entry.start.prompt ? entry.start.prompt : null
  const canFollowUp = view.started && !sending

  async function sendFollowUp() {
    const text = draft.trim()
    if (!text || !canFollowUp) return
    setSending(true)
    setActionError(null)
    const failure = await sendRemoteFollowUp(entry, text)
    setSending(false)
    if (failure) {
      setActionError(failure.message)
      return
    }
    setDraft("")
    setSent((current) => [...current, { id: `${Date.now()}`, text }])
  }

  async function stop() {
    setStopping(true)
    setActionError(null)
    const failure = await stopRemoteThread(entry, latestUserMessageId(messages))
    setStopping(false)
    if (failure) setActionError(failure.message)
    else setStoppedHere(true)
  }

  return (
    <div className="flex h-full min-h-0 flex-col" data-remote-thread-panel={entry.start.key} data-remote-thread-state={view.state}>
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-border px-3">
        <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">{view.title}</span>
        <span className="shrink-0 text-xs text-muted-foreground">{view.computer}</span>
        {view.active && view.started ? (
          <Button
            variant="ghost"
            size="icon-xs"
            disabled={stopping}
            aria-label={t(stopping ? "session.remote_task_stopping" : "session.remote_task_stop", { title: view.title })}
            onClick={() => void stop()}
          >
            <Square className="size-2.5 fill-current" />
          </Button>
        ) : null}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3" data-remote-thread-transcript="">
        <div className="flex flex-col gap-3">
          {page && messages.length >= limit && limit < PAGE_MAX ? (
            <Button variant="ghost" size="xs" className="self-center" onClick={() => setLimit((current) => Math.min(PAGE_MAX, current + PAGE_SIZE))}>
              {t("session.remote_task_earlier")}
            </Button>
          ) : null}
          {shownPrompt ? <UserTurn text={shownPrompt} /> : null}
          {view.started && !page && !readError ? (
            <div className="flex flex-col gap-2" aria-hidden="true">
              <Skeleton className="ms-auto h-9 w-2/3 rounded-3xl" />
              <Skeleton className="h-4 w-11/12" />
              <Skeleton className="h-4 w-3/4" />
            </div>
          ) : null}
          {messages.map((message) => message.role === "user"
            ? <UserTurn key={message.id} text={message.text} />
            : (
              <div key={message.id} className="flex flex-col gap-1" data-remote-thread-message="assistant">
                {message.text ? <MarkdownBlock className="text-sm text-foreground" text={message.text} /> : null}
                {message.steps > 0 ? (
                  <span className="text-xs text-muted-foreground/70">{t("session.remote_task_steps", { count: message.steps })}</span>
                ) : null}
                {message.error ? <span className="text-xs text-red-11">{message.error}</span> : null}
              </div>
            ))}
          {sent.map((followUp) => <UserTurn key={followUp.id} text={followUp.text} />)}
          {readError ? (
            <div className="flex items-center gap-2 text-xs text-muted-foreground" role="status">
              <span className="min-w-0 truncate">{t("session.remote_task_read_failed")}: {readError}</span>
              <Button variant="ghost" size="xs" onClick={() => void read()}>
                <RotateCw />
                {t("session.remote_task_retry")}
              </Button>
            </div>
          ) : null}
          <span
            className={cn("text-xs", view.waitingFor ? "font-medium text-amber-11" : "text-muted-foreground/70", view.state === "running" && "ow-text-shimmer")}
            role="status"
            data-remote-thread-status=""
          >
            {view.state === "idle" ? t("session.remote_task_completed") : view.status}
            {view.lastChecked ? ` · ${view.lastChecked}` : ""}
          </span>
        </div>
      </div>

      {view.waitingFor ? (
        <div className="flex shrink-0 items-start gap-2 border-t border-border px-3 py-2 text-xs text-foreground" data-remote-thread-waiting={view.waitingFor}>
          {view.waitingFor === "permission"
            ? <ShieldAlert aria-hidden="true" className="mt-0.5 size-3.5 shrink-0 text-amber-10" />
            : <CircleHelp aria-hidden="true" className="mt-0.5 size-3.5 shrink-0 text-amber-10" />}
          <span>{t("session.remote_task_answer_there", { computer: view.computer })}</span>
        </div>
      ) : null}

      <form
        className="flex shrink-0 flex-col gap-1 border-t border-border p-2"
        onSubmit={(event) => {
          event.preventDefault()
          void sendFollowUp()
        }}
      >
        <div className="flex items-end gap-2">
          <Textarea
            value={draft}
            rows={1}
            disabled={!view.started}
            aria-label={t("session.remote_task_follow_up")}
            placeholder={t("session.remote_task_follow_up")}
            className="min-h-9 py-2"
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return
              event.preventDefault()
              void sendFollowUp()
            }}
          />
          <Button type="submit" size="sm" disabled={!canFollowUp || !draft.trim()}>
            {t("session.remote_task_send")}
          </Button>
        </div>
        {actionError ? <span className="px-1 text-xs text-red-11" role="alert">{actionError}</span> : null}
      </form>
    </div>
  )
}

function UserTurn({ text }: { text: string }) {
  return (
    <div className="flex justify-end" data-remote-thread-message="user">
      <div className="max-w-[85%] whitespace-pre-wrap rounded-3xl bg-muted px-4 py-2 text-sm leading-6 text-foreground">{text}</div>
    </div>
  )
}
