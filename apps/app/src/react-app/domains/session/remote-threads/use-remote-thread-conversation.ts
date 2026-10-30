import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react"
import type { UIMessage } from "ai"

import { latestUserMessageId, type RemoteTranscriptPage } from "@/lib/remote-session-thread"
import { remoteTranscriptToUIMessages } from "@/lib/remote-transcript-messages"
import { readRemoteThread, sendRemoteFollowUp, stopRemoteThread } from "./remote-thread-actions"
import type { RemoteThreadEntry } from "./remote-thread-store"
import { remoteThreadView } from "./remote-thread-view"

/**
 * One task's conversation as the side panel and the main-pane helper view
 * both show it: the transcript, read when it opens and then only when the
 * shared status says the task changed (at most every few seconds, one at a
 * time), follow-ups shown as sent until the transcript has them, and Stop.
 * Nothing is read while neither shows it.
 */

export const REMOTE_THREAD_PAGE_SIZE = 30
export const REMOTE_THREAD_PAGE_MAX = 100
const READ_GAP_MS = 4_000
/** How close to the end counts as following along, so new steps keep the view at the bottom. */
const FOLLOW_SLACK_PX = 48

type FollowUp = { id: string; text: string }

function userTurn(id: string, text: string): UIMessage {
  return { id, role: "user", parts: [{ type: "text", text }] }
}

export function useRemoteThreadConversation(entry: RemoteThreadEntry, options: {
  initialDraft?: string
  /** Leave out the task's first message when the view shows it folded on its own. */
  foldTask?: boolean
} = {}) {
  const [now, setNow] = useState(() => Date.now())
  const [stoppedHere, setStoppedHere] = useState(false)
  const view = remoteThreadView(entry.start, entry, now, stoppedHere)
  const [page, setPage] = useState<RemoteTranscriptPage | null>(null)
  const [readError, setReadError] = useState<string | null>(null)
  const [limit, setLimit] = useState(REMOTE_THREAD_PAGE_SIZE)
  const [sent, setSent] = useState<FollowUp[]>([])
  const [draft, setDraft] = useState(options.initialDraft ?? "")
  const [sending, setSending] = useState(false)
  const [stopping, setStopping] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)
  const latest = useRef({ entry, limit })
  latest.current = { entry, limit }
  const reads = useRef({ inflight: false, again: false, lastAt: 0, mounted: true })
  const scroller = useRef<HTMLDivElement>(null)
  const following = useRef(true)
  const draftRef = useRef(draft)
  draftRef.current = draft

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
  const prompt = entry.start.prompt?.trim() ?? ""
  const foldTask = options.foldTask === true
  const messages = useMemo(() => {
    const shown = page ? remoteTranscriptToUIMessages(page.messages, { running }) : []
    const first = shown[0]
    const firstText = first?.role === "user" ? first.parts.map((part) => part.type === "text" ? part.text : "").join("").trim() : null
    return [
      // The task as the agent sent it, until its computer's transcript arrives (unless shown folded).
      ...(page
        ? foldTask && prompt && firstText === prompt ? shown.slice(1) : shown
        : prompt && !foldTask ? [userTurn(`${entry.start.key}:prompt`, prompt)] : []),
      ...sent.map((followUp) => userTurn(followUp.id, followUp.text)),
    ]
  }, [page, running, entry.start.key, prompt, foldTask, sent])

  // Keep following the newest step while the person is at the end.
  useLayoutEffect(() => {
    const element = scroller.current
    if (element && following.current) element.scrollTop = element.scrollHeight
  }, [messages])

  const onScroll = useCallback((element: HTMLElement) => {
    following.current = element.scrollHeight - element.scrollTop - element.clientHeight <= FOLLOW_SLACK_PX
  }, [])

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

  return {
    view, page, transcript, messages, running, readError, read, limit, setLimit,
    draft, setDraft, draftRef, sending, stopping, actionError, sendFollowUp, stop, scroller, onScroll,
  }
}
