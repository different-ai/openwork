import type { RemoteThreadStart } from "@/lib/remote-session-thread"
import type { RemoteThreadOwner } from "./remote-thread-store"

/**
 * What a task opened in the main pane needs to know about where it came
 * from: the task itself, the chat that started it and that chat's title.
 * Kept per window in sessionStorage so a reload on the task's route still
 * shows it and can return to its chat; the scroll and pane to return to stay
 * in `child-navigation.ts` like a local helper's.
 *
 * The follow-up draft lives here too, so leaving with Esc and coming back
 * keeps what the person was typing.
 */

export type RemoteHelperOrigin = {
  start: RemoteThreadStart
  owner: RemoteThreadOwner
  parentTitle: string | null
}

const STORAGE_PREFIX = "openwork.remoteHelper."
const memory = new Map<string, RemoteHelperOrigin>()
const drafts = new Map<string, string>()

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

function storage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.sessionStorage
  } catch {
    return null
  }
}

export function rememberRemoteHelperOrigin(origin: RemoteHelperOrigin) {
  memory.set(origin.start.key, origin)
  try {
    storage()?.setItem(`${STORAGE_PREFIX}${origin.start.key}`, JSON.stringify(origin))
  } catch {
    // A full or blocked storage only loses reload recovery.
  }
}

export function remoteHelperOrigin(threadKey: string): RemoteHelperOrigin | null {
  const known = memory.get(threadKey)
  if (known) return known
  try {
    const raw = storage()?.getItem(`${STORAGE_PREFIX}${threadKey}`)
    const parsed = raw ? parseRemoteHelperOrigin(JSON.parse(raw)) : null
    if (parsed?.start.key !== threadKey) return null
    memory.set(threadKey, parsed)
    return parsed
  } catch {
    return null
  }
}

export function remoteHelperDraft(threadKey: string): string {
  return drafts.get(threadKey) ?? ""
}

export function saveRemoteHelperDraft(threadKey: string, draft: string) {
  if (draft) drafts.set(threadKey, draft)
  else drafts.delete(threadKey)
}
