import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react"
import type { UIMessage } from "ai"
import { t } from "@/i18n"

import { latestUserMessageId, type RemoteTranscriptPage } from "@/lib/remote-session-thread"
import { remoteTranscriptToUIMessages } from "@/lib/remote-transcript-messages"
import { readRemoteThread, sendRemoteFollowUp, stopRemoteThread } from "./remote-thread-actions"
import {
  fetchRemoteSessionTail,
  useRemoteThreadTail,
  type RemoteThreadEntry,
} from "./remote-thread-store"
import { remoteThreadView } from "./remote-thread-view"
import { useDenAuth } from "@/react-app/kernel/den-auth-context"
import { remoteSessionRouteId } from "@/lib/remote-session-route"
import { cloudSessionDraftScope, getSessionDraft, useSessionDraftState } from "../sync/draft-store"
import { useDesktopFeature } from "../status/use-desktop-feature"
import {
  clearRemoteFollowUpDraftMessageId,
  remoteFollowUpDraftMessageId,
} from "./remote-draft-message-id"

export const REMOTE_THREAD_PAGE_SIZE = 30
export const REMOTE_THREAD_PAGE_MAX = 100
const READ_GAP_MS = 3_000
const RETRY_BASE_MS = 2_000
const RETRY_MAX_MS = 15_000
const MAX_AUTO_RETRIES = 6
const FOLLOW_SLACK_PX = 48
const REMOTE_DRAFT_WORKSPACE = "remote"

type FollowUp = { id: string; text: string }

function userTurn(id: string, text: string): UIMessage {
  return { id, role: "user", parts: [{ type: "text", text }] }
}

function canAutoRetry(): boolean {
  if (typeof document !== "undefined" && document.visibilityState === "hidden") return false
  return typeof navigator === "undefined" || navigator.onLine !== false
}

export function useRemoteThreadConversation(entry: RemoteThreadEntry, options: {
  foldTask?: boolean
} = {}) {
  const liveSyncEnabled = useDesktopFeature("remoteSessionLiveSync")
  const { verifiedIdentity } = useDenAuth()
  const draftScope = verifiedIdentity?.organizationId === entry.organizationId ? cloudSessionDraftScope(verifiedIdentity) : null
  const draftSessionId = remoteSessionRouteId(entry.start.key)
  const [now, setNow] = useState(() => Date.now())
  const [stoppedHere, setStoppedHere] = useState(false)
  const view = remoteThreadView(entry.start, entry, now, stoppedHere)
  const streamedTail = useRemoteThreadTail(liveSyncEnabled ? entry.start.key : null)
  const [page, setPage] = useState<RemoteTranscriptPage | null>(null)
  const [readError, setReadError] = useState<string | null>(null)
  const [limit, setLimit] = useState(REMOTE_THREAD_PAGE_SIZE)
  const [sent, setSent] = useState<FollowUp[]>([])
  const { scopeKey, snapshot, save, clear } = useSessionDraftState(draftScope, REMOTE_DRAFT_WORKSPACE, draftSessionId)
  const [unsaved, setUnsaved] = useState<{ scopeKey: string; text: string } | null>(null)
  const draft = unsaved?.scopeKey === scopeKey ? unsaved.text : snapshot?.text ?? ""
  const draftRevision = useRef(0)
  const sendInFlight = useRef(false)
  const activePage = liveSyncEnabled && limit <= REMOTE_THREAD_PAGE_SIZE ? (streamedTail ?? page) : (page ?? streamedTail)

  function setDraft(text: string) {
    draftRevision.current += 1
    if (!text.trim()) clearRemoteFollowUpDraftMessageId(draftScope, entry.start.key)
    const result = text ? save({ text, mode: "prompt" }) : clear()
    setUnsaved(result.status === "saved" ? null : { scopeKey, text })
  }

  const [sending, setSending] = useState(false)
  const [stopping, setStopping] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)
  const latest = useRef({ entry, limit, liveSyncEnabled })
  latest.current = { entry, limit, liveSyncEnabled }
  const reads = useRef<{ inflight: AbortController | null; again: boolean; lastAt: number; mounted: boolean; timer?: number; retryCount: number }>({
    inflight: null,
    again: false,
    lastAt: 0,
    mounted: true,
    retryCount: 0,
  })
  const scroller = useRef<HTMLDivElement>(null)
  const following = useRef(true)
  const draftRef = useRef(draft)
  draftRef.current = draft
  const currentScope = useRef(scopeKey)
  currentScope.current = scopeKey

  useEffect(() => {
    const state = reads.current
    state.mounted = true
    return () => {
      state.mounted = false
      state.inflight?.abort()
      window.clearTimeout(state.timer)
    }
  }, [])

  useEffect(() => {
    if (view.state !== "running") return
    const interval = window.setInterval(() => setNow(Date.now()), 1_000)
    return () => window.clearInterval(interval)
  }, [view.state])

  const read = useCallback(async function read(forceRunnerRead = false): Promise<void> {
    const state = reads.current
    if (!state.mounted) return
    if (state.inflight && !state.inflight.signal.aborted) {
      state.again = true
      return
    }
    window.clearTimeout(state.timer)
    state.again = false
    const controller = new AbortController()
    state.inflight = controller
    state.lastAt = Date.now()
    let retryDelayMs: number | null = null
    try {
      const { entry: currentEntry, limit: currentLimit, liveSyncEnabled: useLiveSync } = latest.current
      if (useLiveSync && !forceRunnerRead && currentLimit <= REMOTE_THREAD_PAGE_SIZE) {
        const tail = await fetchRemoteSessionTail(currentEntry.start.key, controller.signal)
        if (controller.signal.aborted || !state.mounted) return
        if (tail) {
          state.retryCount = 0
          setPage(tail)
          setReadError(null)
          setSent((current) => current.filter((followUp) => !tail.messages.some((message) => message.role === "user" && message.text.trim() === followUp.text)))
          return
        }
      }
      const outcome = await readRemoteThread(currentEntry, { limit: currentLimit, signal: controller.signal })
      if (controller.signal.aborted || !state.mounted) return
      if (outcome.kind === "page") {
        state.retryCount = 0
        setPage(outcome.page)
        setReadError(null)
        setSent((current) => current.filter((followUp) => !outcome.page.messages.some((message) => message.role === "user" && message.text.trim() === followUp.text)))
      } else if (outcome.kind === "pending") {
        if (!useLiveSync && state.retryCount < MAX_AUTO_RETRIES && canAutoRetry()) {
          state.retryCount += 1
          retryDelayMs = Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** Math.min(3, state.retryCount - 1))
          setReadError(null)
        } else {
          setReadError(t("session.remote_task_read_failed"))
        }
      } else {
        setReadError(outcome.message || t("session.remote_task_read_failed"))
        if (!useLiveSync && outcome.retryable && state.retryCount < MAX_AUTO_RETRIES && canAutoRetry()) {
          state.retryCount += 1
          retryDelayMs = Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** Math.min(3, state.retryCount - 1))
        }
      }
    } finally {
      if (state.inflight === controller) {
        state.inflight = null
        if (state.mounted && !controller.signal.aborted) {
          if (state.again && !latest.current.liveSyncEnabled) {
            state.again = false
            state.timer = window.setTimeout(() => void read(), Math.max(0, state.lastAt + READ_GAP_MS - Date.now()))
          } else if (retryDelayMs !== null && canAutoRetry()) {
            state.timer = window.setTimeout(() => void read(), retryDelayMs)
          }
        }
      }
    }
  }, [])

  useEffect(() => {
    if (liveSyncEnabled) {
      if (limit > REMOTE_THREAD_PAGE_SIZE) {
        if (view.started) void read(true)
        return
      }
      if (!streamedTail) void read(false)
      return
    }
    if (!view.started) return
    const wait = reads.current.lastAt === 0 ? 0 : Math.max(0, reads.current.lastAt + READ_GAP_MS - Date.now())
    const timer = window.setTimeout(() => void read(), wait)
    return () => window.clearTimeout(timer)
  }, [liveSyncEnabled, entry.version, view.started, limit, streamedTail, read])

  const transcript = activePage?.messages ?? []
  const running = view.state === "running"
  const prompt = entry.start.prompt?.trim() ?? ""
  const foldTask = options.foldTask === true
  const messages = useMemo(() => {
    const shown = activePage ? remoteTranscriptToUIMessages(activePage.messages, { running }) : []
    const first = shown[0]
    const firstText = first?.role === "user" ? first.parts.map((part) => part.type === "text" ? part.text : "").join("").trim() : null
    const pendingSent = activePage
      ? sent.filter((followUp) => !activePage.messages.some((message) => message.role === "user" && message.text.trim() === followUp.text))
      : sent
    return [
      ...(activePage
        ? foldTask && prompt && firstText === prompt ? shown.slice(1) : shown
        : prompt && !foldTask ? [userTurn(`${entry.start.key}:prompt`, prompt)] : []),
      ...pendingSent.map((followUp) => userTurn(followUp.id, followUp.text)),
    ]
  }, [activePage, running, entry.start.key, prompt, foldTask, sent])

  useLayoutEffect(() => {
    const element = scroller.current
    if (element && following.current) element.scrollTop = element.scrollHeight
  }, [messages])

  const onScroll = useCallback((element: HTMLElement) => {
    following.current = element.scrollHeight - element.scrollTop - element.clientHeight <= FOLLOW_SLACK_PX
  }, [])

  async function sendFollowUp() {
    const text = draft.trim()
    if (!text || !view.started || sendInFlight.current) return
    const revision = draftRevision.current
    const messageId = remoteFollowUpDraftMessageId(draftScope, entry.start.key, text)
    sendInFlight.current = true
    setSending(true)
    setActionError(null)
    const failure = await sendRemoteFollowUp(entry, text, messageId)
    sendInFlight.current = false
    setSending(false)
    if (currentScope.current !== scopeKey) {
      clearRemoteFollowUpDraftMessageId(draftScope, entry.start.key)
      return
    }
    if (failure) {
      setActionError(failure.message)
      return
    }
    clearRemoteFollowUpDraftMessageId(draftScope, entry.start.key)
    const storedDraft = getSessionDraft(draftScope, REMOTE_DRAFT_WORKSPACE, draftSessionId)?.text
    if (draftRevision.current === revision && draftRef.current.trim() === text && (storedDraft === undefined || storedDraft.trim() === text)) setDraft("")
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

  const refresh = useCallback(() => read(true), [read])

  return {
    view, page: activePage, transcript, messages, running, readError, read: refresh, limit, setLimit,
    draft, setDraft, draftRef, sending, stopping, actionError, sendFollowUp, stop, scroller, onScroll,
  }
}
