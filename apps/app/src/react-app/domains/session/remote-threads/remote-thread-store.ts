import { useEffect, useRef, useSyncExternalStore } from "react"
import { denSettingsChangedEvent } from "@/app/lib/den-session-events"
import type { DynamicToolUIPart } from "ai"
import { create } from "zustand"
import {
  REMOTE_SESSION_STATUS_THREADS_MAX,
  REMOTE_SESSION_STATUS_WAIT_MAX_MS,
  type RemoteSessionStatusResult,
  type RemoteSessionThreadStatus,
} from "@openwork/types/automations"
import type { BoundRemoteSession } from "@openwork/types/den/remote-sessions"

import { createDenClient, DenApiError, readDenSettings } from "@/app/lib/den"
import {
  mergeRemoteThreadStart,
  parseRemoteRead,
  remoteFollowUpMatches,
  type RemoteThreadFollowUp,
  type RemoteThreadStart,
  type RemoteTranscriptPage,
} from "@/lib/remote-session-thread"
import { remoteThreadFollowUpsInPart } from "@/lib/remote-thread-starts"
import { clearRemoteHelperOrigins } from "./remote-helper-navigation"
import { clearRemoteDraftMessageIds } from "./remote-draft-message-id"

const WAIT_MS = REMOTE_SESSION_STATUS_WAIT_MAX_MS
const MIN_CALL_INTERVAL_MS = 2_000
const BACKOFF_BASE_MS = 2_000
const BACKOFF_MAX_MS = 60_000
const LINGER_MS = 15 * 60_000
export const REMOTE_THREAD_FOLLOW_MAX_MS = 6 * 60 * 60_000
const FOLLOW_MAX_MS = REMOTE_THREAD_FOLLOW_MAX_MS
const FOLLOW_UP_GRACE_MS = 90_000
const REVIVE_WINDOW_MS = 2 * 60_000

export type RemoteThreadOwner = { workspaceId: string; sessionId: string }

export type RemoteThreadEntry = {
  start: RemoteThreadStart
  organizationId: string
  version: string | null
  status: RemoteSessionThreadStatus | null
  stale: boolean
  checkedAt: number | null
  activeSince: number | null
  firstSeenAt: number
  followedUpAt: number | null
  followUpVersion: string | null
  revivedAt: number | null
  owners: Record<string, RemoteThreadOwner>
  viewers: number
  lastViewedAt: number
  tailUpdatedAt?: number | null
}

type RemoteThreadState = {
  threads: Record<string, RemoteThreadEntry>
  tailsByKey: Record<string, RemoteTranscriptPage>
  liveHydratedOrgId: string | null
  watch: (start: RemoteThreadStart, input: { owner?: RemoteThreadOwner | null; organizationId: string; startedAt: number | null }) => () => void
  followedUp: (key: string) => void
  revive: (followUp: RemoteThreadFollowUp) => void
  apply: (result: RemoteSessionStatusResult, keys: readonly string[], checkedAt: number) => void
  applyBoundSessions: (
    organizationId: string,
    sessions: readonly BoundRemoteSession[],
    options?: { replace?: boolean; tails?: Readonly<Record<string, unknown>>; checkedAt?: number },
  ) => void
  setTail: (threadKey: string, page: RemoteTranscriptPage, updatedAt?: number) => void
  markStale: (keys: readonly string[]) => void
  clearAll: () => void
}

function settled(entry: RemoteThreadEntry) {
  return entry.status?.state === "idle" || entry.status?.state === "error"
}

export function remoteThreadAwaitingFollowUp(entry: RemoteThreadEntry, now: number): boolean {
  return settled(entry) && entry.followedUpAt !== null && now - entry.followedUpAt < FOLLOW_UP_GRACE_MS
}

export function remoteThreadNeedsStatus(entry: RemoteThreadEntry, organizationId: string, now: number): boolean {
  if (entry.organizationId !== organizationId) return false
  if (entry.viewers === 0 && now - entry.lastViewedAt > LINGER_MS) return false
  if (entry.viewers === 0 && now - (entry.activeSince ?? entry.firstSeenAt) > FOLLOW_MAX_MS) return false
  if (!entry.status || entry.stale) return true
  if (entry.viewers > 0 && entry.version === null) return true
  if (!settled(entry)) return true
  return entry.followedUpAt !== null && now - entry.followedUpAt < FOLLOW_UP_GRACE_MS
}

function activeOrganization() {
  return readDenSettings().activeOrgId?.trim() || null
}

function boundToEntry(
  organizationId: string,
  session: BoundRemoteSession,
  existing: RemoteThreadEntry | undefined,
  checkedAt: number,
): RemoteThreadEntry {
  const ref = session.target === "cloud" && session.status.sessionId
    ? { sessionId: session.status.sessionId }
    : { commandId: session.commandId }
  const start: RemoteThreadStart = {
    key: session.threadKey,
    ref,
    toolCallId: existing?.start.toolCallId ?? `den:${session.commandId}`,
    title: session.title,
    prompt: session.prompt,
    target: session.target,
    sessionId: session.status.sessionId,
    workspaceId: session.status.workspaceId,
    computerId: session.status.computerId,
  }
  const sameOrg = existing && existing.organizationId === organizationId
  const owners: Record<string, RemoteThreadOwner> = sameOrg ? { ...existing.owners } : {}
  if (session.parentSessionId) {
    const workspaceId = session.parentWorkspaceId ?? ""
    owners[`${workspaceId}:${session.parentSessionId}`] = { workspaceId, sessionId: session.parentSessionId }
  }
  const newTurn = session.status.state !== "idle" && session.status.state !== "error"
    || (sameOrg && existing.followUpVersion !== null && session.status.version !== existing.followUpVersion)
  const followedUpAt = sameOrg && existing.followedUpAt !== null && !newTurn ? existing.followedUpAt : null
  const activeSince = followedUpAt !== null && existing?.activeSince != null
    ? Math.max(session.activeSince, existing.activeSince)
    : session.activeSince
  return {
    start: sameOrg ? mergeRemoteThreadStart(existing.start, start) : start,
    organizationId,
    version: session.status.version,
    status: session.status,
    stale: false,
    checkedAt,
    activeSince,
    firstSeenAt: sameOrg ? existing.firstSeenAt : checkedAt,
    followedUpAt,
    followUpVersion: sameOrg ? existing.followUpVersion : null,
    revivedAt: sameOrg ? existing.revivedAt : null,
    owners,
    viewers: sameOrg ? existing.viewers : 0,
    lastViewedAt: sameOrg ? existing.lastViewedAt : checkedAt,
    tailUpdatedAt: session.tailUpdatedAt,
  }
}

export const useRemoteThreadStore = create<RemoteThreadState>()((set, get) => ({
  threads: {},
  tailsByKey: {},
  liveHydratedOrgId: null,
  clearAll: () => {
    set({ threads: {}, tailsByKey: {}, liveHydratedOrgId: null })
  },
  setTail: (threadKey, page, updatedAt) => {
    set((state) => {
      const existing = state.threads[threadKey]
      return {
        tailsByKey: { ...state.tailsByKey, [threadKey]: page },
        ...(existing && typeof updatedAt === "number"
          ? {
              threads: {
                ...state.threads,
                [threadKey]: { ...existing, tailUpdatedAt: Math.max(existing.tailUpdatedAt ?? 0, updatedAt) },
              },
            }
          : {}),
      }
    })
  },
  applyBoundSessions: (organizationId, sessions, options = {}) => {
    const checkedAt = options.checkedAt ?? Date.now()
    set((state) => {
      const threads = options.replace ? {} : { ...state.threads }
      if (options.replace) {
        for (const [key, entry] of Object.entries(state.threads)) {
          if (entry.organizationId === organizationId && entry.viewers > 0) threads[key] = entry
        }
      }
      for (const session of sessions) {
        threads[session.threadKey] = boundToEntry(organizationId, session, state.threads[session.threadKey], checkedAt)
      }
      let tailsByKey = state.tailsByKey
      if (options.tails) {
        let copied = false
        for (const [threadKey, rawTail] of Object.entries(options.tails)) {
          const parsed = parseRemoteRead(rawTail)
          if (parsed.kind !== "page") continue
          if (!copied) {
            tailsByKey = { ...state.tailsByKey }
            copied = true
          }
          tailsByKey[threadKey] = parsed.page
        }
      }
      return {
        threads,
        tailsByKey,
        liveHydratedOrgId: options.replace ? organizationId : state.liveHydratedOrgId ?? organizationId,
      }
    })
  },
  watch: (start, input) => {
    const owner = input.owner && input.owner.workspaceId && input.owner.sessionId ? input.owner : null
    const ownerKey = owner ? `${owner.workspaceId}:${owner.sessionId}` : null
    const now = Date.now()
    set((state) => {
      const current = state.threads[start.key]
      const sameOrg = current && current.organizationId === input.organizationId
      const owners = sameOrg
        ? owner && ownerKey ? { ...current.owners, [ownerKey]: owner } : current.owners
        : owner && ownerKey ? { [ownerKey]: owner } : {}
      const entry: RemoteThreadEntry = sameOrg
        ? {
            ...current,
            start: mergeRemoteThreadStart(current.start, start),
            activeSince: input.startedAt !== null && (current.activeSince === null || input.startedAt > current.activeSince)
              ? input.startedAt
              : current.activeSince,
            viewers: current.viewers + 1,
            lastViewedAt: now,
            owners,
          }
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
            followUpVersion: null,
            revivedAt: null,
            owners,
            viewers: 1,
            lastViewedAt: now,
          }
      return { threads: { ...state.threads, [start.key]: entry } }
    })
    if (!liveSyncEnabled) kick()
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
      return { threads: { ...state.threads, [key]: { ...current, followedUpAt: now, followUpVersion: current.version, activeSince: now } } }
    })
    if (!liveSyncEnabled) kick(true)
  },
  revive: (followUp) => {
    const sentAt = followUp.sentAt
    if (sentAt === null) return
    const entry = Object.values(get().threads).find((candidate) => remoteFollowUpMatches(followUp, candidate.start, candidate.status?.sessionId ?? null))
    if (!entry || (entry.revivedAt !== null && entry.revivedAt >= sentAt)) return
    const key = entry.start.key
    set((state) => {
      const current = state.threads[key]
      return current ? { threads: { ...state.threads, [key]: { ...current, revivedAt: sentAt } } } : state
    })
    get().followedUp(key)
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
        const newTurn = thread.state !== "idle" && thread.state !== "error"
          || (current.followUpVersion !== null && thread.version !== current.followUpVersion)
        const followedUpAt = current.followedUpAt !== null && newTurn ? null : current.followedUpAt
        const enrichedStart: RemoteThreadStart = {
          ...current.start,
          sessionId: thread.sessionId ?? current.start.sessionId,
          workspaceId: thread.workspaceId ?? current.start.workspaceId,
          computerId: thread.computerId ?? current.start.computerId,
          title: thread.title && thread.title !== "Remote session" ? thread.title : current.start.title,
        }
        threads[key] = { ...current, start: enrichedStart, version: thread.version, status: thread, stale: false, checkedAt, followedUpAt }
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

let liveSyncEnabled = false
let streamRunning = false
let streamController: AbortController | null = null
let streamWake: (() => void) | null = null

let loopRunning = false
let inflight: { controller: AbortController; keys: ReadonlySet<string> } | null = null
let lastKeys: ReadonlySet<string> = new Set()
let wake: (() => void) | null = null
let listening = false

function refId(key: string) {
  return key.slice(key.indexOf(":") + 1)
}

function subscribeDenSettings(notify: () => void) {
  if (typeof window === "undefined") return () => undefined
  window.addEventListener(denSettingsChangedEvent, notify)
  return () => window.removeEventListener(denSettingsChangedEvent, notify)
}

export function useRemoteThreadOrganization() {
  return useSyncExternalStore(subscribeDenSettings, activeOrganization, () => null)
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

export function selectRemoteThreadKeysToCheck(
  threads: Readonly<Record<string, RemoteThreadEntry>>,
  organizationId: string,
  now: number,
): string[] {
  return Object.values(threads)
    .filter((entry) => remoteThreadNeedsStatus(entry, organizationId, now))
    .sort((left, right) => Number(right.viewers > 0) - Number(left.viewers > 0)
      || Number(left.checkedAt !== null) - Number(right.checkedAt !== null)
      || (left.checkedAt ?? 0) - (right.checkedAt ?? 0)
      || (right.activeSince ?? right.firstSeenAt) - (left.activeSince ?? left.firstSeenAt))
    .slice(0, REMOTE_SESSION_STATUS_THREADS_MAX)
    .map((entry) => entry.start.key)
}

function keysToCheck(organizationId: string, now: number): string[] {
  return selectRemoteThreadKeysToCheck(useRemoteThreadStore.getState().threads, organizationId, now)
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

function pauseStream(ms: number) {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(done, ms)
    function done() {
      clearTimeout(timer)
      if (streamWake === done) streamWake = null
      resolve()
    }
    streamWake = done
  })
}

export function clearPersistedRemoteThreads() {
  useRemoteThreadStore.getState().clearAll()
  clearRemoteHelperOrigins()
  clearRemoteDraftMessageIds()
}

export function setRemoteSessionLiveSync(enabled: boolean) {
  if (liveSyncEnabled === enabled) return
  liveSyncEnabled = enabled
  queueMicrotask(() => {
    if (liveSyncEnabled) {
      inflight?.controller.abort()
      kickStream(true)
    } else {
      streamController?.abort()
      streamWake?.()
      kick(true)
    }
  })
}

export async function fetchBoundRemoteSessions(parentSessionId?: string): Promise<void> {
  if (!liveSyncEnabled) return
  const context = denContext()
  if (!context) return
  try {
    const sessions = await context.client.getBoundRemoteSessions(context.organizationId, {
      ...(parentSessionId ? { parentSessionId } : {}),
      limit: 50,
    })
    useRemoteThreadStore.getState().applyBoundSessions(context.organizationId, sessions, {
      replace: !parentSessionId,
    })
  } catch {
  }
}

export async function fetchRemoteSessionTail(threadKey: string, signal?: AbortSignal): Promise<RemoteTranscriptPage | null> {
  if (!liveSyncEnabled) return null
  const context = denContext()
  if (!context) return null
  try {
    const response = await context.client.getRemoteSessionTail(context.organizationId, threadKey, { signal })
    if (!response.tail) return null
    const parsed = parseRemoteRead(response.tail)
    if (parsed.kind !== "page") return null
    useRemoteThreadStore.getState().setTail(threadKey, parsed.page, response.updatedAt ?? undefined)
    return parsed.page
  } catch {
    return null
  }
}

function kickStream(restart = false) {
  listen()
  if (!liveSyncEnabled) return
  if (restart) streamController?.abort()
  streamWake?.()
  if (!streamRunning) void followStream()
}

async function followStream() {
  streamRunning = true
  let failures = 0
  try {
    while (liveSyncEnabled) {
      const context = denContext()
      if (!context || !canCall()) return
      const controller = new AbortController()
      streamController = controller
      try {
        await context.client.openRemoteSessionStream(context.organizationId, {
          signal: controller.signal,
          onSnapshot: (event) => {
            failures = 0
            useRemoteThreadStore.getState().applyBoundSessions(context.organizationId, event.sessions, { replace: true })
          },
          onUpdate: (event) => {
            failures = 0
            useRemoteThreadStore.getState().applyBoundSessions(context.organizationId, event.sessions, { tails: event.tails })
          },
        })
      } catch (error) {
        if (controller.signal.aborted) continue
        if (error instanceof DenApiError && (error.status === 401 || error.status === 404)) {
          return
        }
        failures += 1
        const keys = Object.keys(useRemoteThreadStore.getState().threads)
        if (keys.length > 0) useRemoteThreadStore.getState().markStale(keys)
      } finally {
        if (streamController === controller) streamController = null
      }
      if (!liveSyncEnabled || !canCall()) return
      await pauseStream(Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** Math.max(0, failures - 1)))
    }
  } finally {
    streamRunning = false
  }
}

function listen() {
  if (listening || typeof window === "undefined") return
  listening = true
  const onChange = () => {
    if (!canCall()) {
      inflight?.controller.abort()
      streamController?.abort()
    } else if (liveSyncEnabled) {
      kickStream(true)
    } else {
      kick(true)
    }
  }
  document.addEventListener("visibilitychange", onChange)
  window.addEventListener("online", onChange)
  window.addEventListener("offline", onChange)
  window.addEventListener(denSettingsChangedEvent, () => {
    if (!readDenSettings().authToken?.trim()) {
      inflight?.controller.abort()
      streamController?.abort()
      clearPersistedRemoteThreads()
      return
    }
    inflight?.controller.abort()
    if (liveSyncEnabled) kickStream(true)
    else kick(true)
  })
}

listen()

function kick(now = false) {
  listen()
  if (liveSyncEnabled) return
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
      if (liveSyncEnabled) return
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
        if (controller.signal.aborted) continue
        useRemoteThreadStore.getState().apply(result, keys, Date.now())
        const unchecked = result.threads.length > 0 && result.threads.every((thread) => !thread.changed && thread.stale)
        failures = unchecked ? failures + 1 : 0
        const changed = result.threads.some((thread) => thread.changed)
        const backoff = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** Math.max(0, failures - 1))
        const next = unchecked ? backoff : changed || waitMs > 0 ? 0 : result.retryAfterMs ?? 0
        await pause(Math.max(next, MIN_CALL_INTERVAL_MS - (Date.now() - calledAt)))
      } catch (error) {
        if (controller.signal.aborted) continue
        if (error instanceof DenApiError && error.status === 401) {
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

export function useRemoteThread(key: string | null): RemoteThreadEntry | null {
  const organizationId = useRemoteThreadOrganization()
  return useRemoteThreadStore((state) => {
    const entry = key ? state.threads[key] : undefined
    if (!entry) return null
    if (organizationId) return entry.organizationId === organizationId ? entry : null
    return readDenSettings().authToken?.trim() ? null : entry
  })
}

export function useRemoteThreadTail(key: string | null): RemoteTranscriptPage | null {
  return useRemoteThreadStore((state) => (key ? state.tailsByKey[key] ?? null : null))
}

export function useRemoteThreadLiveHydrated(): boolean {
  const organizationId = useRemoteThreadOrganization()
  return useRemoteThreadStore((state) => Boolean(organizationId && state.liveHydratedOrgId === organizationId))
}

export function useFollowRemoteThread(start: RemoteThreadStart | null, owner: RemoteThreadOwner | null, startedAt: number | null) {
  const latest = useRef({ start, startedAt })
  latest.current = { start, startedAt }
  const key = start?.key ?? null
  const workspaceId = owner?.workspaceId ?? ""
  const sessionId = owner?.sessionId ?? ""
  const organizationId = useRemoteThreadOrganization()
  useEffect(() => {
    const current = latest.current
    if (!key || !current.start || !organizationId) return
    return useRemoteThreadStore.getState().watch(current.start, {
      owner: workspaceId && sessionId ? { workspaceId, sessionId } : null,
      organizationId,
      startedAt: current.startedAt,
    })
  }, [key, workspaceId, sessionId, organizationId])
}

export function reviveRemoteThreads(followUps: readonly RemoteThreadFollowUp[], now = Date.now()) {
  for (const followUp of followUps) {
    if (followUp.sentAt === null || now - followUp.sentAt > REVIVE_WINDOW_MS) continue
    useRemoteThreadStore.getState().revive(followUp)
  }
}

export function useReviveRemoteThread(part: DynamicToolUIPart | null) {
  const followUps = part ? remoteThreadFollowUpsInPart(part) : []
  const latest = useRef(followUps)
  latest.current = followUps
  const signature = followUps.map((followUp) => `${followUp.toolCallId}@${followUp.sentAt ?? ""}`).join("\n")
  useEffect(() => {
    if (signature) reviveRemoteThreads(latest.current)
  }, [signature])
}

export type RemoteThreadAttention = { kind: "permission" | "question"; title: string }

export function useRemoteThreadAttentionKey(): string {
  const organizationId = useRemoteThreadOrganization()
  return useRemoteThreadStore((state) => {
    if (!organizationId) return "[]"
    const rows: string[][] = []
    for (const entry of Object.values(state.threads)) {
      if (entry.organizationId !== organizationId) continue
      if (entry.checkedAt === null || entry.status?.state !== "waiting") continue
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
