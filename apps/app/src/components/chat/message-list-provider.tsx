"use memo";

import { useSessionActivityStore } from "@/react-app/domains/session/status/session-activity-store"
import type {
  ChatToolReconnectAction,
  ChatToolReconnectProgress,
  ChatToolReconnectResult,
} from "@/components/tools/error-attribution"
import * as React from "react"

interface MessageListContextValue {
  workspaceId: string
  sessionId: string
  showThinking: boolean
  highlightQuery?: string
  developerMode: boolean
  displaySuggestions: boolean
  providerConnectedCount: number
  dispatchAction: (action: DispatchAction) => void
  setPrompt: (prompt: string) => void
  onRevertToUserMessage: (messageId: string) => void
  onForkAtMessage: (messageId: string) => void
  onEditUserMessage: (messageId: string, text: string) => void
  onMcpReconnect: (
    action: ChatToolReconnectAction,
    onProgress: (progress: ChatToolReconnectProgress) => void,
  ) => Promise<ChatToolReconnectResult>
  onMcpReopenAuthorization: (action: ChatToolReconnectAction, authorizeUrl: string) => Promise<void>
  onMcpRetry: (action: ChatToolReconnectAction) => void | Promise<void>
}

const MessageListContext = React.createContext<MessageListContextValue | null>(null)

interface MessageListProviderProps {
  children: React.ReactNode
  workspaceId: string
  sessionId: string
  showThinking: boolean
  highlightQuery?: string
  developerMode: boolean
  onRevertToUserMessage: (messageId: string) => void
  onForkAtMessage: (messageId: string) => void
  onEditUserMessage: (messageId: string, text: string) => void
  onMcpReconnect: (
    action: ChatToolReconnectAction,
    onProgress: (progress: ChatToolReconnectProgress) => void,
  ) => Promise<ChatToolReconnectResult>
  onMcpReopenAuthorization: (action: ChatToolReconnectAction, authorizeUrl: string) => Promise<void>
  onMcpRetry: (action: ChatToolReconnectAction) => void | Promise<void>
  displaySuggestions: boolean
  providerConnectedCount: number
  dispatchAction: (action: DispatchAction) => void
  setPrompt: (prompt: string) => void
}

export interface DispatchAction {
  target: "settings"
  action: "open"
  section: "commands" | "skills" | "mcps" | "plugins" | "providers"
}

export function MessageListProvider({
  children,
  workspaceId,
  sessionId,
  showThinking,
  highlightQuery,
  developerMode,
  displaySuggestions,
  providerConnectedCount,
  dispatchAction,
  setPrompt,
  onRevertToUserMessage,
  onForkAtMessage,
  onEditUserMessage,
  onMcpReconnect,
  onMcpReopenAuthorization,
  onMcpRetry,
}: MessageListProviderProps) {
  const value = React.useMemo(
    () => ({
      workspaceId,
      sessionId,
      showThinking,
      highlightQuery,
      developerMode,
      displaySuggestions,
      providerConnectedCount,
      dispatchAction,
      setPrompt,
      onRevertToUserMessage,
      onForkAtMessage,
      onEditUserMessage,
      onMcpReconnect,
      onMcpReopenAuthorization,
      onMcpRetry,
    }),
    [
      workspaceId,
      sessionId,
      showThinking,
      highlightQuery,
      developerMode,
      displaySuggestions,
      providerConnectedCount,
      dispatchAction,
      setPrompt,
      onRevertToUserMessage,
      onForkAtMessage,
      onEditUserMessage,
      onMcpReconnect,
      onMcpReopenAuthorization,
      onMcpRetry,
    ],
  )

  return (
    <MessageListContext.Provider value={value}>
      {children}
    </MessageListContext.Provider>
  )
}

export function useMessageList() {
  const context = React.useContext(MessageListContext)

  if (!context) {
    throw new Error("useMessageList must be used within a MessageListProvider")
  }

  return context
}

export function useSessionErrorMessage() {
  const { workspaceId, sessionId } = useMessageList();

  return useSessionActivityStore(state => state.getSessionError(workspaceId, sessionId));
}
