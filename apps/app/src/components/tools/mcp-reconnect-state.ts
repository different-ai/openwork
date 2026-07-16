import { create } from "zustand"

import type { ChatToolReconnectAction } from "./error-attribution"

export type ChatMcpReconnectPhase =
  | "ready"
  | "opening"
  | "authorization_opened"
  | "connected"
  | "failed"

export type ChatMcpReconnectRecord = {
  phase: ChatMcpReconnectPhase
  error: string | null
  authorizeUrl: string | null
}

type ChatMcpReconnectStore = {
  records: Record<string, ChatMcpReconnectRecord>
  setRecord: (key: string, record: ChatMcpReconnectRecord) => void
  reset: () => void
}

const READY_RECORD: ChatMcpReconnectRecord = { phase: "ready", error: null, authorizeUrl: null }

export function chatMcpReconnectKey(toolCallId: string, connectionId: string): string {
  return `${toolCallId}:${connectionId}`
}

export const useChatMcpReconnectStore = create<ChatMcpReconnectStore>((set) => ({
  records: {},
  setRecord: (key, record) => set((state) => ({
    records: { ...state.records, [key]: record },
  })),
  reset: () => set({ records: {} }),
}))

export function chatMcpReconnectRecord(key: string): ChatMcpReconnectRecord {
  return useChatMcpReconnectStore.getState().records[key] ?? READY_RECORD
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
      return { badgeLabel: "Reconnect required", buttonLabel: "Opening sign-in…", disabled: true }
    case "authorization_opened":
      return { badgeLabel: "Reconnect required", buttonLabel: "Open sign-in again", disabled: false }
    case "connected":
      return { badgeLabel: "Reconnected", buttonLabel: "Try again", disabled: false }
    case "failed":
      return { badgeLabel: "Reconnect failed", buttonLabel: "Try reconnecting", disabled: false }
    default:
      return { badgeLabel: "Reconnect required", buttonLabel: action.label, disabled: false }
  }
}
