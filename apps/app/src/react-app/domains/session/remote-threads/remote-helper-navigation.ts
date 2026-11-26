import type { RemoteThreadStart } from "@/lib/remote-session-thread"
import type { RemoteThreadOwner } from "./remote-thread-store"

export type RemoteHelperOrigin = {
  start: RemoteThreadStart
  owner: RemoteThreadOwner
  parentTitle: string | null
}

const STORAGE_KEY = "openwork.remoteHelper.v2"
const MAX_STORED_ORIGINS = 30
const MAX_PROMPT_LENGTH = 1000
const memory = new Map<string, RemoteHelperOrigin>()

type StoredOriginRecord = {
  savedAt: number
  origin: RemoteHelperOrigin
}

function storageKey(scope: string | null, threadKey: string) {
  return JSON.stringify([scope, threadKey])
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function stringOrNull(value: unknown): string | null | undefined {
  if (value === null) return null
  return typeof value === "string" ? value : undefined
}

function parseStart(value: unknown): RemoteThreadStart | null {
  if (!isRecord(value) || !isRecord(value.ref)) return null
  const ref = typeof value.ref.commandId === "string"
    ? { commandId: value.ref.commandId }
    : typeof value.ref.sessionId === "string" ? { sessionId: value.ref.sessionId } : null
  const target = value.target === "cloud" || value.target === "desktop" ? value.target : null
  const prompt = stringOrNull(value.prompt)
  const sessionId = stringOrNull(value.sessionId)
  const workspaceId = stringOrNull(value.workspaceId)
  const computerId = stringOrNull(value.computerId)
  if (!ref || !target || typeof value.key !== "string" || typeof value.toolCallId !== "string" || typeof value.title !== "string"
    || prompt === undefined || sessionId === undefined || workspaceId === undefined || computerId === undefined) return null
  return { key: value.key, ref, toolCallId: value.toolCallId, title: value.title, prompt, target, sessionId, workspaceId, computerId }
}

export function parseRemoteHelperOrigin(value: unknown): RemoteHelperOrigin | null {
  if (!isRecord(value) || !isRecord(value.owner)) return null
  const start = parseStart(value.start)
  const { workspaceId, sessionId } = value.owner
  const parentTitle = stringOrNull(value.parentTitle)
  if (!start || typeof workspaceId !== "string" || typeof sessionId !== "string" || parentTitle === undefined) return null
  return { start, owner: { workspaceId, sessionId }, parentTitle }
}

function readMap(): Record<string, StoredOriginRecord> {
  if (typeof window === "undefined") return {}
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) return {}
    const parsed: unknown = JSON.parse(raw)
    if (!isRecord(parsed)) return {}
    const records: Record<string, StoredOriginRecord> = {}
    for (const [key, value] of Object.entries(parsed)) {
      if (!isRecord(value) || typeof value.savedAt !== "number") continue
      const origin = parseRemoteHelperOrigin(value.origin)
      if (origin) records[key] = { savedAt: value.savedAt, origin }
    }
    return records
  } catch {
    return {}
  }
}

function compactOrigin(origin: RemoteHelperOrigin): RemoteHelperOrigin {
  const prompt = origin.start.prompt && origin.start.prompt.length > MAX_PROMPT_LENGTH
    ? `${origin.start.prompt.slice(0, MAX_PROMPT_LENGTH - 1)}…`
    : origin.start.prompt
  return { ...origin, start: { ...origin.start, prompt } }
}

export function rememberRemoteHelperOrigin(origin: RemoteHelperOrigin, scope: string | null) {
  const key = storageKey(scope, origin.start.key)
  memory.set(key, origin)
  if (!scope || typeof window === "undefined") return
  try {
    const map = readMap()
    map[key] = { savedAt: Date.now(), origin: compactOrigin(origin) }
    const pruned = Object.fromEntries(
      Object.entries(map)
        .sort((left, right) => right[1].savedAt - left[1].savedAt)
        .slice(0, MAX_STORED_ORIGINS),
    )
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(pruned))
  } catch {
  }
}

export function remoteHelperOrigin(threadKey: string, scope: string | null): RemoteHelperOrigin | null {
  const key = storageKey(scope, threadKey)
  const known = memory.get(key)
  if (known) return known
  if (!scope || typeof window === "undefined") return null
  const stored = readMap()[key]?.origin ?? null
  if (stored?.start.key !== threadKey) return null
  memory.set(key, stored)
  return stored
}

export function clearRemoteHelperOrigins() {
  memory.clear()
  if (typeof window === "undefined") return
  try {
    window.localStorage.removeItem(STORAGE_KEY)
  } catch {
  }
}
