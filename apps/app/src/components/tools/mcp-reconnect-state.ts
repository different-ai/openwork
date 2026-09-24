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

type ChatMcpReconnectStore = {
  records: Record<string, ChatMcpReconnectRecord>
  setRecord: (key: string, record: ChatMcpReconnectRecord) => void
  reset: () => void
}

const READY_RECORD: ChatMcpReconnectRecord = { phase: "ready", error: null, authorizeUrl: null }

export function chatMcpReconnectKey(toolCallId: string, connectionId: string, scope = ""): string {
  return JSON.stringify([scope, toolCallId, connectionId])
}

export const useChatMcpReconnectStore = create<ChatMcpReconnectStore>((set) => ({
  records: {},
  setRecord: (key, record) => set((state) => ({
    records: { ...state.records, [key]: { ...state.records[key], ...record } },
  })),
  reset: () => set({ records: {} }),
}))

export function chatMcpReconnectRecord(key: string): ChatMcpReconnectRecord {
  return useChatMcpReconnectStore.getState().records[key] ?? READY_RECORD
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
