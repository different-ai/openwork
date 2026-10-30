import { useEffect, useRef } from "react"
import type { DynamicToolUIPart } from "ai"
import { create } from "zustand"
import {
  REMOTE_SESSION_STATUS_THREADS_MAX,
  REMOTE_SESSION_STATUS_WAIT_MAX_MS,
  type RemoteSessionStatusResult,
  type RemoteSessionThreadStatus,
} from "@openwork/types/automations"

import { createDenClient, DenApiError, readDenSettings } from "@/app/lib/den"
import { remoteThreadFollowUpSessionId, remoteToolCallStartedAt, type RemoteThreadStart } from "@/lib/remote-session-thread"

/**
 * Tasks the agent started on other computers, followed for the chat.
 *
 * One loop follows every task shown anywhere in the app, whatever number of
 * rows, panels or chats show it, with one Den call at a time:
 *
 * - The first look at a task asks at once; after that each call sends the
 *   versions it holds and waits on Den (up to 20 s) until one changes, so a
 *   quiet task costs about three small calls a minute and none of its data.
 * - A task stops being followed when it finishes or fails, 15 minutes after
 *   nothing on screen shows it, or 6 hours after it last started work.
 * - Nothing is called while the window is hidden or offline, nor when no
 *   task needs following. Failures back off to a minute; the feature turning
 *   off stops the loop.
 *
 * Transcripts are not part of this: the open panel reads one only when the
 * status says something changed.
 */

const WAIT_MS = REMOTE_SESSION_STATUS_WAIT_MAX_MS
/** However busy a task is, one status call starts at most every two seconds. */
const MIN_CALL_INTERVAL_MS = 2_000
const BACKOFF_BASE_MS = 2_000
const BACKOFF_MAX_MS = 60_000
const LINGER_MS = 15 * 60_000
const FOLLOW_MAX_MS = 6 * 60 * 60_000
/** After a follow-up, an idle status is still the previous turn until the task reports work again. */
const FOLLOW_UP_GRACE_MS = 90_000
/** Only a follow-up the agent just sent revives a task; reopening an old chat does not. */
const REVIVE_WINDOW_MS = 2 * 60_000

export type RemoteThreadOwner = { workspaceId: string; sessionId: string }

export type RemoteThreadEntry = {
  start: RemoteThreadStart
  organizationId: string
  version: string | null
  status: RemoteSessionThreadStatus | null
  /** The last check couldn't confirm the state; the row shows the last known one. */
  stale: boolean
  /** When Den last confirmed the state. */
  checkedAt: number | null
  /** When the task was started, or last sent a follow-up; null when the chat doesn't know. */
  activeSince: number | null
  /** When this window first showed the task. */
  firstSeenAt: number
  followedUpAt: number | null
  owners: Record<string, RemoteThreadOwner>
  viewers: number
  lastViewedAt: number
}

type RemoteThreadState = {
  enabled: boolean
  /** `remoteSessionThreadView`: a row opens the task's conversation beside the chat. */
  threadView: boolean
  /** `remoteSessionHelperView`: a row opens the task in the main pane, like a helper. */
  helperView: boolean
  /** `remoteSessionAnswers`: the person answers a task's question or permission from here. */
  answers: boolean
  threads: Record<string, RemoteThreadEntry>
  setEnabled: (enabled: boolean) => void
  setThreadView: (threadView: boolean) => void
  setHelperView: (helperView: boolean) => void
  setAnswers: (answers: boolean) => void
  watch: (start: RemoteThreadStart, input: { owner: RemoteThreadOwner; organizationId: string; startedAt: number | null }) => () => void
  followedUp: (key: string) => void
  /** The agent sent the task a follow-up itself. */
  revive: (sessionId: string) => void
  apply: (result: RemoteSessionStatusResult, keys: readonly string[], checkedAt: number) => void
  markStale: (keys: readonly string[]) => void
}

function settled(entry: RemoteThreadEntry) {
  return entry.status?.state === "idle" || entry.status?.state === "error"
}

export function remoteThreadNeedsStatus(entry: RemoteThreadEntry, organizationId: string, now: number): boolean {
  if (entry.organizationId !== organizationId) return false
  if (entry.viewers === 0 && now - entry.lastViewedAt > LINGER_MS) return false
  if (now - (entry.activeSince ?? entry.firstSeenAt) > FOLLOW_MAX_MS) return false
  if (!entry.status || entry.stale) return true
  if (!settled(entry)) return true
  return entry.followedUpAt !== null && now - entry.followedUpAt < FOLLOW_UP_GRACE_MS
}

export const useRemoteThreadStore = create<RemoteThreadState>()((set, get) => ({
  enabled: false,
  threadView: false,
  helperView: false,
  answers: false,
  threads: {},
  setEnabled: (enabled) => {
    if (get().enabled === enabled) return
    set({ enabled })
    if (enabled) kick()
    else stopFollowing()
  },
  setThreadView: (threadView) => set({ threadView }),
  setHelperView: (helperView) => set({ helperView }),
  setAnswers: (answers) => set({ answers }),
  watch: (start, input) => {
    const ownerKey = `${input.owner.workspaceId}:${input.owner.sessionId}`
    const now = Date.now()
    set((state) => {
      const current = state.threads[start.key]
      const entry: RemoteThreadEntry = current
        ? { ...current, viewers: current.viewers + 1, lastViewedAt: now, owners: { ...current.owners, [ownerKey]: input.owner } }
        : {
            start,
            organizationId: input.organizationId,
            version: null,
            status: null,
            stale: false,
            checkedAt: null,
            activeSince: input.startedAt,
            firstSeenAt: now,
            followedUpAt: null,
            owners: { [ownerKey]: input.owner },
            viewers: 1,
            lastViewedAt: now,
          }
      return { threads: { ...state.threads, [start.key]: entry } }
    })
    kick()
    return () => {
      set((state) => {
        const current = state.threads[start.key]
        if (!current) return state
        return { threads: { ...state.threads, [start.key]: { ...current, viewers: Math.max(0, current.viewers - 1), lastViewedAt: Date.now() } } }
      })
    }
  },
  followedUp: (key) => {
    const now = Date.now()
    set((state) => {
      const current = state.threads[key]
      if (!current) return state
      return { threads: { ...state.threads, [key]: { ...current, followedUpAt: now, activeSince: now } } }
    })
    kick(true)
  },
  revive: (sessionId) => {
    const key = Object.values(get().threads).find((entry) => (entry.status?.sessionId ?? entry.start.sessionId) === sessionId)?.start.key
    if (key) get().followedUp(key)
  },
  apply: (result, keys, checkedAt) => {
    set((state) => {
      const threads = { ...state.threads }
      const byRef = new Map(keys.map((key) => [refId(key), key]))
      for (const thread of result.threads) {
        const key = byRef.get(thread.ref)
        const current = key ? threads[key] : undefined
        if (!key || !current) continue
        if (!thread.changed) {
          threads[key] = { ...current, version: thread.version, stale: thread.stale === true, checkedAt: thread.stale ? current.checkedAt : checkedAt }
          continue
        }
        // Work reported after a follow-up ends its grace: the new turn is now visible.
        const followedUpAt = current.followedUpAt !== null && thread.state !== "idle" && thread.state !== "error" ? null : current.followedUpAt
        threads[key] = { ...current, version: thread.version, status: thread, stale: false, checkedAt, followedUpAt }
      }
      return { threads }
    })
  },
  markStale: (keys) => {
    set((state) => {
      const threads = { ...state.threads }
      for (const key of keys) {
        const current = threads[key]
        if (current) threads[key] = { ...current, stale: true }
      }
      return { threads }
    })
  },
}))

let loopRunning = false
let inflight: { controller: AbortController; keys: ReadonlySet<string> } | null = null
/** The tasks of the last call; only a task outside it needs a new call before the next one. */
let lastKeys: ReadonlySet<string> = new Set()
let wake: (() => void) | null = null
let listening = false

/** "command:<id>" → "<id>", the ref Den answers with. */
function refId(key: string) {
  return key.slice(key.indexOf(":") + 1)
}

function denContext() {
  const settings = readDenSettings()
  const token = settings.authToken?.trim()
  const organizationId = settings.activeOrgId?.trim()
  if (!token || !organizationId) return null
  return { client: createDenClient({ baseUrl: settings.baseUrl, apiBaseUrl: settings.apiBaseUrl, token }), organizationId }
}

function canCall() {
  if (typeof document !== "undefined" && document.visibilityState === "hidden") return false
  return typeof navigator === "undefined" || navigator.onLine !== false
}

/** Most relevant first: on screen, then the latest started. */
function keysToCheck(organizationId: string, now: number): string[] {
  return Object.values(useRemoteThreadStore.getState().threads)
    .filter((entry) => remoteThreadNeedsStatus(entry, organizationId, now))
    .sort((left, right) => Number(right.viewers > 0) - Number(left.viewers > 0)
      || (right.activeSince ?? right.firstSeenAt) - (left.activeSince ?? left.firstSeenAt))
    .slice(0, REMOTE_SESSION_STATUS_THREADS_MAX)
    .map((entry) => entry.start.key)
}

function pause(ms: number) {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(done, ms)
    function done() {
      clearTimeout(timer)
      if (wake === done) wake = null
      resolve()
    }
    wake = done
  })
}

function listen() {
  if (listening || typeof window === "undefined") return
  listening = true
  const onChange = () => {
    // Hidden: drop the waiting call. Visible or back online: look again now.
    if (!canCall()) inflight?.controller.abort()
    else kick(true)
  }
  document.addEventListener("visibilitychange", onChange)
  window.addEventListener("online", onChange)
  window.addEventListener("offline", onChange)
}

function stopFollowing() {
  inflight?.controller.abort()
  wake?.()
}

/**
 * Follow newly shown tasks now: a waiting call restarts with them. A row that
 * only remounts (scrolling) changes nothing, so it never cuts a backoff or a
 * wait short; `now` does, for a follow-up or the window coming back.
 */
function kick(now = false) {
  if (!useRemoteThreadStore.getState().enabled) return
  listen()
  const context = denContext()
  const keys = context ? keysToCheck(context.organizationId, Date.now()) : []
  const added = keys.some((key) => !lastKeys.has(key))
  if (added && inflight) inflight.controller.abort()
  if (added || now) wake?.()
  if (!loopRunning) void follow()
}

async function follow() {
  loopRunning = true
  let failures = 0
  try {
    for (;;) {
      if (!useRemoteThreadStore.getState().enabled) return
      const context = denContext()
      if (!context) return
      const keys = keysToCheck(context.organizationId, Date.now())
      if (keys.length === 0) return
      if (!canCall()) return
      const threads = useRemoteThreadStore.getState().threads
      const firstLook = keys.some((key) => threads[key]?.version === null || threads[key]?.stale)
      const waitMs = firstLook ? 0 : WAIT_MS
      const controller = new AbortController()
      lastKeys = new Set(keys)
      inflight = { controller, keys: lastKeys }
      const calledAt = Date.now()
      try {
        const result = await context.client.getRemoteSessionStatus(context.organizationId, {
          threads: keys.map((key) => {
            const entry = threads[key]
            return { ...entry?.start.ref, ...(entry?.version ? { version: entry.version } : {}) }
          }),
          waitMs,
        }, { signal: controller.signal })
        useRemoteThreadStore.getState().apply(result, keys, Date.now())
        // Den could not check any of them (a waking cloud computer): back off like a failure.
        const unchecked = result.threads.length > 0 && result.threads.every((thread) => !thread.changed && thread.stale)
        failures = unchecked ? failures + 1 : 0
        const changed = result.threads.some((thread) => thread.changed)
        const backoff = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** Math.max(0, failures - 1))
        // A waiting call already spent its time; a quick one honors Den's hint.
        const next = unchecked ? backoff : changed || waitMs > 0 ? 0 : result.retryAfterMs ?? 0
        await pause(Math.max(next, MIN_CALL_INTERVAL_MS - (Date.now() - calledAt)))
      } catch (error) {
        if (controller.signal.aborted) continue
        if (error instanceof DenApiError && (error.code === "feature_disabled" || error.status === 401)) {
          if (error.code === "feature_disabled") useRemoteThreadStore.getState().setEnabled(false)
          return
        }
        failures += 1
        useRemoteThreadStore.getState().markStale(keys)
        await pause(Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** (failures - 1)))
      } finally {
        if (inflight?.controller === controller) inflight = null
      }
    }
  } finally {
    loopRunning = false
  }
}

export function useRemoteThreadsEnabled(): boolean {
  return useRemoteThreadStore((state) => state.enabled)
}

/** Whether a task's question or permission can be answered here instead of on its computer. */
export function useRemoteThreadAnswersEnabled(): boolean {
  return useRemoteThreadStore((state) => state.enabled && state.answers)
}

/** Whether a task's row opens its conversation; rows alone show progress. */
export function useRemoteThreadViewEnabled(): boolean {
  return useRemoteThreadStore((state) => state.enabled && state.threadView)
}

/** Whether a task opens in the main pane like a helper; it needs the conversation view too. */
export function useRemoteThreadHelperViewEnabled(): boolean {
  return useRemoteThreadStore((state) => state.enabled && state.threadView && state.helperView)
}

export function useRemoteThread(key: string | null): RemoteThreadEntry | null {
  return useRemoteThreadStore((state) => key ? state.threads[key] ?? null : null)
}

/** Follow a task while this component shows it (and for a while after). */
export function useFollowRemoteThread(start: RemoteThreadStart | null, owner: RemoteThreadOwner, startedAt: number | null) {
  const enabled = useRemoteThreadsEnabled()
  // A task is identified by its key; a re-rendered part with the same key is the same task.
  const latest = useRef({ start, startedAt })
  latest.current = { start, startedAt }
  const key = start?.key ?? null
  const { workspaceId, sessionId } = owner
  useEffect(() => {
    const current = latest.current
    if (!enabled || !key || !current.start) return
    const organizationId = readDenSettings().activeOrgId?.trim()
    if (!organizationId) return
    return useRemoteThreadStore.getState().watch(current.start, { owner: { workspaceId, sessionId }, organizationId, startedAt: current.startedAt })
  }, [enabled, key, workspaceId, sessionId])
}

/** The agent's own `remote-session:send` to a task the chat shows: follow it again. */
export function useReviveRemoteThread(part: DynamicToolUIPart | null) {
  const sessionId = part ? remoteThreadFollowUpSessionId(part) : null
  const sentAt = part && sessionId ? remoteToolCallStartedAt(part) : null
  useEffect(() => {
    if (!sessionId || sentAt === null || Date.now() - sentAt > REVIVE_WINDOW_MS) return
    useRemoteThreadStore.getState().revive(sessionId)
  }, [sessionId, sentAt])
}

export type RemoteThreadAttention = { kind: "permission" | "question"; title: string }

/**
 * Chats whose task on another computer waits on the person, as a string that
 * only changes when that set does: status updates that change nothing here
 * never re-render the sidebar.
 */
export function useRemoteThreadAttentionKey(): string {
  return useRemoteThreadStore((state) => {
    if (!state.enabled) return "[]"
    const rows: string[][] = []
    for (const entry of Object.values(state.threads)) {
      if (entry.status?.state !== "waiting") continue
      for (const owner of Object.values(entry.owners)) {
        rows.push([owner.sessionId, entry.status.waitingFor ?? "question", entry.status.title ?? entry.start.title])
      }
    }
    return JSON.stringify(rows.sort())
  })
}

export function remoteThreadAttentionBySession(key: string): Map<string, RemoteThreadAttention> {
  const attention = new Map<string, RemoteThreadAttention>()
  const rows: unknown = JSON.parse(key)
  if (!Array.isArray(rows)) return attention
  for (const row of rows) {
    if (!Array.isArray(row)) continue
    const [sessionId, kind, title] = row
    if (typeof sessionId !== "string" || typeof title !== "string" || attention.has(sessionId)) continue
    attention.set(sessionId, { kind: kind === "permission" ? "permission" : "question", title })
  }
  return attention
}
