import { create } from "zustand"

import type { ChatToolReconnectAction } from "./error-attribution"
import type { ChatConnectionDecisionBinding, ChatConnectionDecisionResponse } from "@/react-app/domains/session/surface/mcp-chat-reconnect"

export type ChatMcpReconnectPhase =
  | "ready"
  | "opening"
  | "authorization_opened"
  | "connected"
  | "failed"
  | "skipped"

export type ChatMcpReconnectRecord = {
  phase: ChatMcpReconnectPhase
  error: string | null
  authorizeUrl: string | null
  responseSubmitted?: boolean
}

/**
 * A sign-in that is still in the browser. It belongs to the connection, not to
 * the tool call whose card started it: the card moves to the newest report of
 * a connection, and the sign-in must outlive that move.
 */
export type ChatMcpReconnectAttempt = {
  id: number
  phase: "opening" | "authorization_opened"
  authorizeUrl: string | null
}

type ChatMcpReconnectStore = {
  records: Record<string, ChatMcpReconnectRecord>
  attempts: Record<string, ChatMcpReconnectAttempt>
  setRecord: (key: string, record: ChatMcpReconnectRecord) => void
  setAttempt: (connectionKey: string, attempt: ChatMcpReconnectAttempt | null) => void
  settleAttempt: (connectionKey: string, keys: readonly string[], record: ChatMcpReconnectRecord) => void
  reset: () => void
}

const READY_RECORD: ChatMcpReconnectRecord = { phase: "ready", error: null, authorizeUrl: null }

export function chatMcpReconnectKey(toolCallId: string, connectionId: string, scope = ""): string {
  return JSON.stringify([scope, toolCallId, connectionId])
}

export function chatMcpConnectionKey(connectionId: string, scope = ""): string {
  return JSON.stringify([scope, connectionId])
}

function withoutAttempt(attempts: Record<string, ChatMcpReconnectAttempt>, connectionKey: string) {
  return Object.fromEntries(Object.entries(attempts).filter(([key]) => key !== connectionKey))
}

export const useChatMcpReconnectStore = create<ChatMcpReconnectStore>((set) => ({
  records: {},
  attempts: {},
  setRecord: (key, record) => set((state) => ({
    records: { ...state.records, [key]: { ...state.records[key], ...record } },
  })),
  setAttempt: (connectionKey, attempt) => set((state) => ({
    attempts: attempt ? { ...state.attempts, [connectionKey]: attempt } : withoutAttempt(state.attempts, connectionKey),
  })),
  // The outcome lands on the tool calls that were showing the sign-in, so a
  // report that arrives later for the same connection starts from its own state.
  settleAttempt: (connectionKey, keys, record) => set((state) => ({
    attempts: withoutAttempt(state.attempts, connectionKey),
    records: {
      ...state.records,
      ...Object.fromEntries(keys.flatMap((key) => {
        const phase = state.records[key]?.phase
        return phase === "skipped" || phase === "connected" ? [] : [[key, { ...state.records[key], ...record }]]
      })),
    },
  })),
  reset: () => set({ records: {}, attempts: {} }),
}))

/** What a tool call's card shows: its own outcome, else the connection's sign-in in flight. */
export function effectiveChatMcpReconnectRecord(
  state: Pick<ChatMcpReconnectStore, "records" | "attempts">,
  key: string,
  connectionKey: string,
): ChatMcpReconnectRecord {
  const own = state.records[key]
  if (own?.phase === "connected" || own?.phase === "skipped") return own
  const attempt = state.attempts[connectionKey]
  if (attempt) return { ...own, phase: attempt.phase, error: null, authorizeUrl: attempt.authorizeUrl }
  return own ?? READY_RECORD
}

export function chatMcpReconnectRecord(key: string, connectionKey?: string): ChatMcpReconnectRecord {
  const state = useChatMcpReconnectStore.getState()
  return connectionKey ? effectiveChatMcpReconnectRecord(state, key, connectionKey) : state.records[key] ?? READY_RECORD
}

export async function respondChatConnectionDecision(
  key: string,
  binding: ChatConnectionDecisionBinding,
  response: ChatConnectionDecisionResponse,
): Promise<boolean> {
  const request = binding.request
  if (key !== chatMcpReconnectKey(request.toolCallId, request.connectionId, request.owner)) return false
  const record = chatMcpReconnectRecord(key)
  if (record.responseSubmitted || !binding.isPending()) return false
  useChatMcpReconnectStore.getState().setRecord(key, { ...record, responseSubmitted: true })
  try {
    await binding.respond(response)
    return true
  } catch (error) {
    useChatMcpReconnectStore.getState().setRecord(key, { ...chatMcpReconnectRecord(key), responseSubmitted: false })
    throw error
  }
}

export type ChatMcpReconnectPresentation = {
  badgeLabel: string
  buttonLabel: string
  disabled: boolean
}

export function chatMcpReconnectPresentation(
  action: ChatToolReconnectAction,
  phase: ChatMcpReconnectPhase,
): ChatMcpReconnectPresentation {
  switch (phase) {
    case "opening":
      return { badgeLabel: "Opening sign-in…", buttonLabel: "Opening…", disabled: true }
    case "authorization_opened":
      return { badgeLabel: "Finish sign-in in your browser", buttonLabel: "Open sign-in again", disabled: false }
    case "connected":
      return { badgeLabel: `${action.connectionName} connected`, buttonLabel: "Connected", disabled: true }
    case "skipped":
      return { badgeLabel: `Skipped ${action.connectionName}`, buttonLabel: "Skipped", disabled: true }
    case "failed":
      return { badgeLabel: `${action.connectionName} sign-in could not finish`, buttonLabel: "Authenticate", disabled: false }
    default:
      return { badgeLabel: `Authenticate ${action.connectionName} to continue`, buttonLabel: "Authenticate", disabled: false }
  }
}
