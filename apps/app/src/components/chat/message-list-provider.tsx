"use memo";

import { useSessionActivityStore } from "@/react-app/domains/session/status/session-activity-store"
import * as React from "react"

interface MessageListContextValue {
  workspaceId: string
  sessionId: string
  showThinking: boolean
  developerMode: boolean
  displaySuggestions: boolean
  dispatchAction: (action: DispatchAction) => void
  setPrompt: (prompt: string) => void
  onRevertToUserMessage: (messageId: string) => void
  onForkAtMessage: (messageId: string) => void
}

const MessageListContext = React.createContext<MessageListContextValue | null>(null)

interface MessageListProviderProps {
  children: React.ReactNode
  workspaceId: string
  sessionId: string
  showThinking: boolean
  developerMode: boolean
  onRevertToUserMessage: (messageId: string) => void
  onForkAtMessage: (messageId: string) => void
  displaySuggestions: boolean
  dispatchAction: (action: DispatchAction) => void
  setPrompt: (prompt: string) => void
}

export interface DispatchAction {
  target: "settings"
  action: "open"
  section: "commands" | "skills" | "mcps" | "plugins"
}

export function MessageListProvider({
  children,
  workspaceId,
  sessionId,
  showThinking,
  developerMode,
  displaySuggestions,
  dispatchAction,
  setPrompt,
  onRevertToUserMessage,
  onForkAtMessage,
}: MessageListProviderProps) {
  const value = React.useMemo(
    () => ({
      workspaceId,
      sessionId,
      showThinking,
      developerMode,
      displaySuggestions,
      dispatchAction,
      setPrompt,
      onRevertToUserMessage,
      onForkAtMessage,
    }),
    [
      workspaceId,
      sessionId,
      showThinking,
      developerMode,
      displaySuggestions,
      dispatchAction,
      setPrompt,
      onRevertToUserMessage,
      onForkAtMessage,
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