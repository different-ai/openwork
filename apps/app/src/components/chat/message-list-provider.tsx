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
import type { RemoteThreadStart } from "@/lib/remote-session-thread"
import { publicModelTitle } from "@/react-app/domains/models/model-catalog"
import type { AutoRouteNameResolver, ReplyModelTitleResolver } from "@/react-app/domains/session/sync/reply-model"
import type { AutoRouterReplyRoute } from "@openwork/types/den/auto-router"
import { useSessionAutoRoutes } from "@/react-app/domains/session/sync/auto-route-store"
import { useModelPickerCatalogStore } from "@/react-app/domains/session/models/model-collections-store"
import type { ChatConnectionDecisionBinding } from "@/react-app/domains/session/surface/mcp-chat-reconnect"

interface MessageListContextValue {
  mcpAppOrigin: McpAppOrigin | null
  readOnly: boolean
  workspaceId: string
  sessionId: string
  /** Verified principal/org, endpoint, workspace and session; absent means no retention. */
  uiStateOwner?: string | null
  getConnectionDecision?: (toolCallId: string) => ChatConnectionDecisionBinding | null
  /** A Connect card's sign-in landed with no question waiting on it: carry the latest turn on. */
  continueAfterConnection?: (toolCallId: string, prompt?: string) => void
  connectionQuestionToolCallId?: string | null
  showThinking: boolean
  highlightQuery?: string
  developerMode: boolean
  displaySuggestions: boolean
  providerConnectedCount: number
  resolveReplyModelTitle: ReplyModelTitleResolver
  /** Auto (feature `autoRouter`): the gateway's routing decisions for this session's replies. */
  autoRoutes: readonly AutoRouterReplyRoute[]
  resolveAutoRouteName: AutoRouteNameResolver
  connectorIdentities: ConnectorToolIdentity[]
  /**
   * True while the workspace sync layer cannot validate live run status
   * (failed status revalidation). Working indicators must stop ticking.
   */
  syncDegraded: boolean
  dispatchAction: (action: DispatchAction) => void
  setPrompt: (prompt: string) => void
  onRevertToUserMessage: (messageId: string) => void
  /** Absent where a reply cannot be branched into a new chat (a task on another computer). */
  onForkAtMessage?: (messageId: string) => void | Promise<void>
  forkingMessageId?: string
  onEditUserMessage: (messageId: string, text: string) => void
  /** Open a sub-agent (child) session in the main chat surface. */
  onOpenSubagentSession?: (sessionId: string) => void
  /** Stop one running sub-agent (child) session without stopping the parent turn. */
  onStopSubagentSession?: (sessionId: string) => void | Promise<void>
  /** Open a task on another computer in the main pane, like a helper. Absent where it opens beside the chat. */
  onOpenRemoteTask?: (start: RemoteThreadStart) => void
  /** Sub-agent calls the composer's Agents list shows; their Stop lives there, not on the chat row. */
  composerSubagentToolCallIds: ReadonlySet<string>
  /** Re-submit an interrupted run by sending its recovery prompt. */
  onResumeInterrupted?: (recoveryPrompt: string) => void
  /** Open one Library item's detail, by the same id Library rows use. Absent where there is no Library. */
  onOpenLibraryDetail?: (detailId: string) => void
  onMcpReconnect: (
    action: ChatToolReconnectAction,
    onProgress: (progress: ChatToolReconnectProgress) => void,
    isCurrent?: () => boolean,
  ) => Promise<ChatToolReconnectResult>
  onMcpReopenAuthorization: (action: ChatToolReconnectAction, authorizeUrl: string, isCurrent?: () => boolean) => Promise<void>
}

const NO_TOOL_CALL_IDS: ReadonlySet<string> = new Set()

const MessageListContext = React.createContext<MessageListContextValue | null>(null)

interface MessageListProviderProps {
  client?: OpenworkServerClient
  mcpAppEngine?: "v1" | "v2"
  readOnly?: boolean
  children: React.ReactNode
  workspaceId: string
  sessionId: string
  uiStateOwner?: string | null
  getConnectionDecision?: (toolCallId: string) => ChatConnectionDecisionBinding | null
  continueAfterConnection?: (toolCallId: string, prompt?: string) => void
  connectionQuestionToolCallId?: string | null
  showThinking: boolean
  highlightQuery?: string
  developerMode: boolean
  onRevertToUserMessage: (messageId: string) => void
  onForkAtMessage?: (messageId: string) => void | Promise<void>
  forkingMessageId?: string
  onEditUserMessage: (messageId: string, text: string) => void
  onOpenSubagentSession?: (sessionId: string) => void
  onStopSubagentSession?: (sessionId: string) => void | Promise<void>
  onOpenRemoteTask?: (start: RemoteThreadStart) => void
  composerSubagentToolCallIds?: ReadonlySet<string>
  onResumeInterrupted?: (recoveryPrompt: string) => void
  onOpenLibraryDetail?: (detailId: string) => void
  onMcpReconnect: (
    action: ChatToolReconnectAction,
    onProgress: (progress: ChatToolReconnectProgress) => void,
    isCurrent?: () => boolean,
  ) => Promise<ChatToolReconnectResult>
  onMcpReopenAuthorization: (action: ChatToolReconnectAction, authorizeUrl: string, isCurrent?: () => boolean) => Promise<void>
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
  getConnectionDecision,
  continueAfterConnection,
  connectionQuestionToolCallId,
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
  onStopSubagentSession,
  onOpenRemoteTask,
  composerSubagentToolCallIds = NO_TOOL_CALL_IDS,
  onResumeInterrupted,
  onOpenLibraryDetail,
  onMcpReconnect,
  onMcpReopenAuthorization,
}: MessageListProviderProps) {
  const handlersRef = React.useRef({
    dispatchAction,
    setPrompt,
    onRevertToUserMessage,
    onForkAtMessage,
    onEditUserMessage,
    onOpenSubagentSession,
    onStopSubagentSession,
    onOpenRemoteTask,
    onResumeInterrupted,
    onOpenLibraryDetail,
    onMcpReconnect,
    onMcpReopenAuthorization,
  })
  React.useEffect(() => {
    handlersRef.current = {
      dispatchAction,
      setPrompt,
      onRevertToUserMessage,
      onForkAtMessage,
      onEditUserMessage,
      onOpenSubagentSession,
      onStopSubagentSession,
      onOpenRemoteTask,
      onResumeInterrupted,
      onOpenLibraryDetail,
      onMcpReconnect,
      onMcpReopenAuthorization,
    }
  }, [
    dispatchAction,
    setPrompt,
    onRevertToUserMessage,
    onForkAtMessage,
    onEditUserMessage,
    onOpenSubagentSession,
    onStopSubagentSession,
    onOpenRemoteTask,
    onResumeInterrupted,
    onOpenLibraryDetail,
    onMcpReconnect,
    onMcpReopenAuthorization,
  ])
  const stableHandlers = React.useMemo(() => ({
    dispatchAction: (action: DispatchAction) => handlersRef.current.dispatchAction(action),
    setPrompt: (prompt: string) => handlersRef.current.setPrompt(prompt),
    onRevertToUserMessage: (messageId: string) => handlersRef.current.onRevertToUserMessage(messageId),
    onForkAtMessage: (messageId: string) => handlersRef.current.onForkAtMessage?.(messageId),
    onEditUserMessage: (messageId: string, text: string) => handlersRef.current.onEditUserMessage(messageId, text),
    onOpenSubagentSession: (sessionId: string) => handlersRef.current.onOpenSubagentSession?.(sessionId),
    onStopSubagentSession: (sessionId: string) => handlersRef.current.onStopSubagentSession?.(sessionId),
    onOpenRemoteTask: (start: RemoteThreadStart) => handlersRef.current.onOpenRemoteTask?.(start),
    onResumeInterrupted: (recoveryPrompt: string) => handlersRef.current.onResumeInterrupted?.(recoveryPrompt),
    onOpenLibraryDetail: (detailId: string) => handlersRef.current.onOpenLibraryDetail?.(detailId),
    onMcpReconnect: (
      action: ChatToolReconnectAction,
      onProgress: (progress: ChatToolReconnectProgress) => void,
      isCurrent?: () => boolean,
    ) => handlersRef.current.onMcpReconnect(action, onProgress, isCurrent),
    onMcpReopenAuthorization: (action: ChatToolReconnectAction, authorizeUrl: string, isCurrent?: () => boolean) => (
      handlersRef.current.onMcpReopenAuthorization(action, authorizeUrl, isCurrent)
    ),
  }), [])
  const canForkAtMessage = Boolean(onForkAtMessage)
  const canOpenSubagentSession = Boolean(onOpenSubagentSession)
  const canStopSubagentSession = Boolean(onStopSubagentSession)
  const canOpenRemoteTask = Boolean(onOpenRemoteTask)
  const canResumeInterrupted = Boolean(onResumeInterrupted)
  const canOpenLibraryDetail = Boolean(onOpenLibraryDetail)
  const mcpAppOrigin = React.useMemo<McpAppOrigin | null>(
    () => client ? { client, workspaceId, sessionId, readOnly, ...(mcpAppEngine ? { engine: mcpAppEngine } : {}) } : null,
    [client, workspaceId, sessionId, readOnly, mcpAppEngine],
  )
  // The composer owns a workspace-scoped catalog even for background panes.
  const replyModelOptions = useModelPickerCatalogStore(state => state.bySession[sessionId]?.options)
  const resolveReplyModelTitle = React.useCallback<ReplyModelTitleResolver>(
    model => {
      const option = replyModelOptions?.find(option => option.providerID === model.providerID && option.modelID === model.modelID);
      return option ? publicModelTitle(option) : undefined;
    },
    [replyModelOptions],
  )
  const autoRoutes = useSessionAutoRoutes(sessionId)
  // The gateway names the routed model; older gateways send only its id,
  // which the member's catalog may know by name.
  const resolveAutoRouteName = React.useCallback<AutoRouteNameResolver>(
    modelID => {
      const option = replyModelOptions?.find(option => option.modelID === modelID || option.modelID.endsWith(`/${modelID}`));
      return option ? publicModelTitle(option) : undefined;
    },
    [replyModelOptions],
  )
  const value = React.useMemo(
    () => ({
      mcpAppOrigin,
      readOnly,
      workspaceId,
      sessionId,
      uiStateOwner,
      getConnectionDecision,
      continueAfterConnection,
      connectionQuestionToolCallId,
      showThinking,
      highlightQuery,
      forkingMessageId,
      developerMode,
      displaySuggestions,
      providerConnectedCount,
      resolveReplyModelTitle,
      autoRoutes,
      resolveAutoRouteName,
      connectorIdentities,
      syncDegraded,
      composerSubagentToolCallIds,
      ...stableHandlers,
      onForkAtMessage: canForkAtMessage ? stableHandlers.onForkAtMessage : undefined,
      onOpenSubagentSession: canOpenSubagentSession
        ? stableHandlers.onOpenSubagentSession
        : undefined,
      onStopSubagentSession: canStopSubagentSession
        ? stableHandlers.onStopSubagentSession
        : undefined,
      onOpenRemoteTask: canOpenRemoteTask ? stableHandlers.onOpenRemoteTask : undefined,
      onResumeInterrupted: canResumeInterrupted
        ? stableHandlers.onResumeInterrupted
        : undefined,
      onOpenLibraryDetail: canOpenLibraryDetail
        ? stableHandlers.onOpenLibraryDetail
        : undefined,
    }),
    [
      mcpAppOrigin,
      readOnly,
      workspaceId,
      sessionId,
      uiStateOwner,
      getConnectionDecision,
      continueAfterConnection,
      connectionQuestionToolCallId,
      showThinking,
      highlightQuery,
      forkingMessageId,
      developerMode,
      displaySuggestions,
      providerConnectedCount,
      resolveReplyModelTitle,
      autoRoutes,
      resolveAutoRouteName,
      connectorIdentities,
      syncDegraded,
      composerSubagentToolCallIds,
      stableHandlers,
      canForkAtMessage,
      canOpenSubagentSession,
      canStopSubagentSession,
      canOpenRemoteTask,
      canResumeInterrupted,
      canOpenLibraryDetail,
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
