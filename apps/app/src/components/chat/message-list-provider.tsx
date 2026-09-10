"use memo";

import { useSessionActivityStore } from "@/react-app/domains/session/status/session-activity-store"
import type {
  ChatToolReconnectAction,
  ChatToolReconnectProgress,
  ChatToolReconnectResult,
} from "@/components/tools/error-attribution"
import * as React from "react"
import type { ConnectorToolIdentity } from "@/react-app/domains/connections/connector-tool-identity"
import type { OpenworkServerClient } from "@/app/lib/openwork-server"
import type { McpAppOrigin } from "./mcp-app-origin"

interface MessageListContextValue {
  mcpAppOrigin: McpAppOrigin | null
  readOnly: boolean
  workspaceId: string
  sessionId: string
  /** Verified principal/org, endpoint, workspace and session; absent means no retention. */
  uiStateOwner?: string | null
  showThinking: boolean
  highlightQuery?: string
  developerMode: boolean
  displaySuggestions: boolean
  providerConnectedCount: number
  connectorIdentities: ConnectorToolIdentity[]
  /**
   * True while the workspace sync layer cannot validate live run status
   * (failed status revalidation). Working indicators must stop ticking.
   */
  syncDegraded: boolean
  dispatchAction: (action: DispatchAction) => void
  setPrompt: (prompt: string) => void
  onRevertToUserMessage: (messageId: string) => void
  onForkAtMessage: (messageId: string) => void | Promise<void>
  forkingMessageId?: string
  onEditUserMessage: (messageId: string, text: string) => void
  /** Open a sub-agent (child) session in the main chat surface. */
  onOpenSubagentSession?: (sessionId: string) => void
  /** Re-submit an interrupted run by sending its recovery prompt. */
  onResumeInterrupted?: (recoveryPrompt: string) => void
  onMcpReconnect: (
    action: ChatToolReconnectAction,
    onProgress: (progress: ChatToolReconnectProgress) => void,
  ) => Promise<ChatToolReconnectResult>
  onMcpReopenAuthorization: (action: ChatToolReconnectAction, authorizeUrl: string) => Promise<void>
  onMcpRetry: (action: ChatToolReconnectAction) => void | Promise<void>
}

const MessageListContext = React.createContext<MessageListContextValue | null>(null)

interface MessageListProviderProps {
  client?: OpenworkServerClient
  mcpAppEngine?: "v1" | "v2"
  readOnly?: boolean
  children: React.ReactNode
  workspaceId: string
  sessionId: string
  uiStateOwner?: string | null
  showThinking: boolean
  highlightQuery?: string
  developerMode: boolean
  onRevertToUserMessage: (messageId: string) => void
  onForkAtMessage: (messageId: string) => void | Promise<void>
  forkingMessageId?: string
  onEditUserMessage: (messageId: string, text: string) => void
  onOpenSubagentSession?: (sessionId: string) => void
  onResumeInterrupted?: (recoveryPrompt: string) => void
  onMcpReconnect: (
    action: ChatToolReconnectAction,
    onProgress: (progress: ChatToolReconnectProgress) => void,
  ) => Promise<ChatToolReconnectResult>
  onMcpReopenAuthorization: (action: ChatToolReconnectAction, authorizeUrl: string) => Promise<void>
  onMcpRetry: (action: ChatToolReconnectAction) => void | Promise<void>
  displaySuggestions: boolean
  providerConnectedCount: number
  connectorIdentities?: ConnectorToolIdentity[]
  syncDegraded?: boolean
  dispatchAction: (action: DispatchAction) => void
  setPrompt: (prompt: string) => void
}

export interface DispatchAction {
  target: "settings"
  action: "open"
  section: "commands" | "skills" | "mcps" | "plugins" | "providers"
}

export function MessageListProvider({
  client,
  mcpAppEngine,
  readOnly = false,
  children,
  workspaceId,
  sessionId,
  uiStateOwner,
  showThinking,
  highlightQuery,
  developerMode,
  displaySuggestions,
  providerConnectedCount,
  connectorIdentities = [],
  syncDegraded = false,
  dispatchAction,
  setPrompt,
  onRevertToUserMessage,
  onForkAtMessage,
  forkingMessageId,
  onEditUserMessage,
  onOpenSubagentSession,
  onResumeInterrupted,
  onMcpReconnect,
  onMcpReopenAuthorization,
  onMcpRetry,
}: MessageListProviderProps) {
  const handlersRef = React.useRef({
    dispatchAction,
    setPrompt,
    onRevertToUserMessage,
    onForkAtMessage,
    onEditUserMessage,
    onOpenSubagentSession,
    onResumeInterrupted,
    onMcpReconnect,
    onMcpReopenAuthorization,
    onMcpRetry,
  })
  React.useEffect(() => {
    handlersRef.current = {
      dispatchAction,
      setPrompt,
      onRevertToUserMessage,
      onForkAtMessage,
      onEditUserMessage,
      onOpenSubagentSession,
      onResumeInterrupted,
      onMcpReconnect,
      onMcpReopenAuthorization,
      onMcpRetry,
    }
  }, [
    dispatchAction,
    setPrompt,
    onRevertToUserMessage,
    onForkAtMessage,
    onEditUserMessage,
    onOpenSubagentSession,
    onResumeInterrupted,
    onMcpReconnect,
    onMcpReopenAuthorization,
    onMcpRetry,
  ])
  const stableHandlers = React.useMemo(() => ({
    dispatchAction: (action: DispatchAction) => handlersRef.current.dispatchAction(action),
    setPrompt: (prompt: string) => handlersRef.current.setPrompt(prompt),
    onRevertToUserMessage: (messageId: string) => handlersRef.current.onRevertToUserMessage(messageId),
    onForkAtMessage: (messageId: string) => handlersRef.current.onForkAtMessage(messageId),
    onEditUserMessage: (messageId: string, text: string) => handlersRef.current.onEditUserMessage(messageId, text),
    onOpenSubagentSession: (sessionId: string) => handlersRef.current.onOpenSubagentSession?.(sessionId),
    onResumeInterrupted: (recoveryPrompt: string) => handlersRef.current.onResumeInterrupted?.(recoveryPrompt),
    onMcpReconnect: (
      action: ChatToolReconnectAction,
      onProgress: (progress: ChatToolReconnectProgress) => void,
    ) => handlersRef.current.onMcpReconnect(action, onProgress),
    onMcpReopenAuthorization: (action: ChatToolReconnectAction, authorizeUrl: string) => (
      handlersRef.current.onMcpReopenAuthorization(action, authorizeUrl)
    ),
    onMcpRetry: (action: ChatToolReconnectAction) => handlersRef.current.onMcpRetry(action),
  }), [])
  const canOpenSubagentSession = Boolean(onOpenSubagentSession)
  const canResumeInterrupted = Boolean(onResumeInterrupted)
  const mcpAppOrigin = React.useMemo<McpAppOrigin | null>(
    () => client ? { client, workspaceId, sessionId, readOnly, ...(mcpAppEngine ? { engine: mcpAppEngine } : {}) } : null,
    [client, workspaceId, sessionId, readOnly, mcpAppEngine],
  )
  const value = React.useMemo(
    () => ({
      mcpAppOrigin,
      readOnly,
      workspaceId,
      sessionId,
      uiStateOwner,
      showThinking,
      highlightQuery,
      forkingMessageId,
      developerMode,
      displaySuggestions,
      providerConnectedCount,
      connectorIdentities,
      syncDegraded,
      ...stableHandlers,
      onOpenSubagentSession: canOpenSubagentSession
        ? stableHandlers.onOpenSubagentSession
        : undefined,
      onResumeInterrupted: canResumeInterrupted
        ? stableHandlers.onResumeInterrupted
        : undefined,
    }),
    [
      mcpAppOrigin,
      readOnly,
      workspaceId,
      sessionId,
      uiStateOwner,
      showThinking,
      highlightQuery,
      forkingMessageId,
      developerMode,
      displaySuggestions,
      providerConnectedCount,
      connectorIdentities,
      syncDegraded,
      stableHandlers,
      canOpenSubagentSession,
      canResumeInterrupted,
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

export function useOptionalMessageList() {
  return React.useContext(MessageListContext)
}
