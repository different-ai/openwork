import { remoteFollowUpMessageId } from "@/lib/remote-session-thread"

const MESSAGE_ID_STORAGE_KEY = "openwork.remoteFollowUpId.v1"
const MAX_STORED_MESSAGE_IDS = 30

type StoredMessageIdRecord = {
  savedAt: number
  messageId: string
  text: string
}

const messageIdMemory = new Map<string, { messageId: string; text: string }>()

function cacheKey(scope: string | null, threadKey: string): string | null {
  if (!scope) return null
  return JSON.stringify([scope, threadKey])
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function readStorageMap(): Record<string, unknown> {
  if (typeof window === "undefined") return {}
  try {
    const raw = window.localStorage.getItem(MESSAGE_ID_STORAGE_KEY)
    if (!raw) return {}
    const parsed: unknown = JSON.parse(raw)
    return isRecord(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

function writeStorageMap(map: Record<string, unknown>) {
  if (typeof window === "undefined") return
  try {
    window.localStorage.setItem(MESSAGE_ID_STORAGE_KEY, JSON.stringify(map))
  } catch {
  }
}

export function remoteFollowUpDraftMessageId(scope: string | null, threadKey: string, draftText: string): string {
  const normalized = draftText.trim()
  const key = cacheKey(scope, threadKey)
  if (!key) return remoteFollowUpMessageId()
  const existingMemory = messageIdMemory.get(key)
  if (existingMemory && existingMemory.text === normalized) return existingMemory.messageId
  const raw = readStorageMap()
  const stored = raw[key]
  if (isRecord(stored) && typeof stored.messageId === "string" && stored.messageId && stored.text === normalized) {
    messageIdMemory.set(key, { messageId: stored.messageId, text: normalized })
    return stored.messageId
  }
  const created = remoteFollowUpMessageId()
  messageIdMemory.set(key, { messageId: created, text: normalized })
  const entries: Array<[string, StoredMessageIdRecord]> = []
  for (const [entryKey, value] of Object.entries(raw)) {
    if (entryKey === key || !isRecord(value) || typeof value.savedAt !== "number" || typeof value.messageId !== "string" || typeof value.text !== "string") continue
    entries.push([entryKey, { savedAt: value.savedAt, messageId: value.messageId, text: value.text }])
  }
  entries.push([key, { savedAt: Date.now(), messageId: created, text: normalized }])
  const pruned = Object.fromEntries(
    entries
      .sort((left, right) => right[1].savedAt - left[1].savedAt)
      .slice(0, MAX_STORED_MESSAGE_IDS),
  )
  writeStorageMap(pruned)
  return created
}

export function clearRemoteFollowUpDraftMessageId(scope: string | null, threadKey: string) {
  const key = cacheKey(scope, threadKey)
  if (!key) return
  messageIdMemory.delete(key)
  const raw = readStorageMap()
  if (!(key in raw)) return
  delete raw[key]
  writeStorageMap(raw)
}

export function clearRemoteDraftMessageIds() {
  messageIdMemory.clear()
  if (typeof window === "undefined") return
  try {
    window.localStorage.removeItem(MESSAGE_ID_STORAGE_KEY)
  } catch {
  }
}
