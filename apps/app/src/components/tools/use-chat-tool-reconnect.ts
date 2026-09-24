"use client"

import { useEffect, useId, useRef } from "react"
import { useOptionalMessageList } from "@/components/chat/message-list-provider"
import type { DynamicToolUIPart, ToolUIPart } from "ai"
import type { ChatConnectionDecisionBinding } from "@/react-app/domains/session/surface/mcp-chat-reconnect"
import {
  connectionResultFromChatToolPart,
  reconnectActionFromChatToolResult,
  type ChatToolReconnectAction,
  type ChatToolReconnectProgress,
  type ChatToolReconnectResult,
} from "@/components/tools/error-attribution"
import {
  chatMcpReconnectKey,
  chatMcpReconnectPresentation,
  chatMcpReconnectRecord,
  respondChatConnectionDecision,
  useChatMcpReconnectStore,
} from "@/components/tools/mcp-reconnect-state"

export type ChatToolReconnectCallbacks = {
  blocked?: boolean
  decision?: ChatConnectionDecisionBinding | null
  onReconnect?: (
    action: ChatToolReconnectAction,
    onProgress: (progress: ChatToolReconnectProgress) => void,
    isCurrent?: () => boolean,
  ) => Promise<ChatToolReconnectResult>
  onReopenAuthorization?: (action: ChatToolReconnectAction, authorizeUrl: string, isCurrent?: () => boolean) => Promise<void>
}

const reopening = new Set<string>()

export function useChatToolReconnect(
  toolPart: ToolUIPart | DynamicToolUIPart,
  { onReconnect, onReopenAuthorization, blocked = false, decision: suppliedDecision }: ChatToolReconnectCallbacks,
  actionOverride?: ChatToolReconnectAction | null,
  scopeOverride?: string,
  connectionIdOverride?: string,
) {
  const messageList = useOptionalMessageList()
  const instanceId = useId()
  const scope = scopeOverride ?? messageList?.uiStateOwner ?? (messageList ? JSON.stringify([messageList.workspaceId, messageList.sessionId]) : instanceId)
  const reconnectBlocked = blocked || messageList?.readOnly === true
  const reconnectAction = actionOverride !== undefined ? actionOverride : toolPart.type === "dynamic-tool"
    ? reconnectActionFromChatToolResult(toolPart.toolName, connectionResultFromChatToolPart(toolPart), toolPart.input)
    : null
  const connectionId = connectionIdOverride ?? reconnectAction?.connectionId
  const reconnectKey = connectionId ? chatMcpReconnectKey(toolPart.toolCallId, connectionId, scope) : null
  const candidateDecision = suppliedDecision ?? messageList?.getConnectionDecision?.(toolPart.toolCallId)
  const decision = candidateDecision?.request.toolCallId === toolPart.toolCallId
    && candidateDecision.request.connectionId === connectionId && candidateDecision.request.owner === scope
    ? candidateDecision : null
  const lifecycle = useRef(0)
  const current = useRef({ scope, reconnectBlocked })
  current.current = { scope, reconnectBlocked }
  useEffect(() => () => { lifecycle.current += 1 }, [scope])
  const reconnectState = useChatMcpReconnectStore(store => reconnectKey ? store.records[reconnectKey]?.phase ?? "ready" : "ready")
  const reconnectError = useChatMcpReconnectStore(store => reconnectKey ? store.records[reconnectKey]?.error ?? null : null)
  const responseSubmitted = useChatMcpReconnectStore(store => reconnectKey ? store.records[reconnectKey]?.responseSubmitted === true : false)
  const setRecord = useChatMcpReconnectStore(store => store.setRecord)
  const reconnectPresentation = reconnectAction ? chatMcpReconnectPresentation(reconnectAction, reconnectState) : null
  const decisionAvailable = Boolean(decision?.isPending()) && !reconnectBlocked

  const handleReconnect = async () => {
    if (!reconnectAction || !reconnectKey || !onReconnect || reconnectBlocked) return
    if (candidateDecision && !decision) return
    if (decision && !decision.isPending()) return
    const record = chatMcpReconnectRecord(reconnectKey)
    if (record.phase === "connected" || record.phase === "skipped" || record.phase === "opening" || record.responseSubmitted) return
    const epoch = lifecycle.current
    const isCurrent = () => epoch === lifecycle.current && current.current.scope === scope
      && !current.current.reconnectBlocked && (!decision || decision.isPending())
      && chatMcpReconnectRecord(reconnectKey).phase !== "skipped"
    if (record.phase === "authorization_opened") {
      if (!onReopenAuthorization || !record.authorizeUrl || reopening.has(reconnectKey)) return
      reopening.add(reconnectKey)
      try {
        await onReopenAuthorization(reconnectAction, record.authorizeUrl, isCurrent)
      } catch (error) {
        if (isCurrent()) setRecord(reconnectKey, { ...chatMcpReconnectRecord(reconnectKey), error: error instanceof Error ? error.message : "Could not reopen sign-in." })
      } finally {
        reopening.delete(reconnectKey)
      }
      return
    }
    setRecord(reconnectKey, { phase: "opening", error: null, authorizeUrl: null })
    try {
      const result = await onReconnect(reconnectAction, progress => {
        if (!isCurrent()) return
        setRecord(reconnectKey, { phase: progress.phase, error: null, authorizeUrl: progress.phase === "authorization_opened" ? progress.authorizeUrl : null })
      }, isCurrent)
      if (current.current.scope !== scope || chatMcpReconnectRecord(reconnectKey).phase === "skipped") return
      setRecord(reconnectKey, { phase: result, error: null, authorizeUrl: null })
      if (isCurrent() && result === "connected" && decision) {
        await respondChatConnectionDecision(reconnectKey, decision, {
          outcome: "connected", continuation: "review_remaining_work", repeatCompletedWrites: false,
        })
      }
    } catch (error) {
      if (epoch !== lifecycle.current || current.current.scope !== scope || chatMcpReconnectRecord(reconnectKey).phase === "skipped") return
      const latest = chatMcpReconnectRecord(reconnectKey)
      setRecord(reconnectKey, {
        phase: latest.phase === "connected" ? "connected" : "failed",
        error: error instanceof Error ? error.message : "Could not reconnect this account.",
        authorizeUrl: null,
      })
    }
  }

  const handleSkip = async () => {
    if (!decision || !reconnectKey || !decisionAvailable || !decision.isPending()) return
    const record = chatMcpReconnectRecord(reconnectKey)
    if (record.phase === "connected" || record.phase === "skipped" || record.responseSubmitted) return
    setRecord(reconnectKey, { phase: "skipped", error: null, authorizeUrl: null })
    try {
      await respondChatConnectionDecision(reconnectKey, decision, {
        outcome: "skipped", continuation: "without_connection", alternativeAuthorization: false,
      })
    } catch (error) {
      setRecord(reconnectKey, { phase: "skipped", error: error instanceof Error ? error.message : "Could not deliver the decision.", authorizeUrl: null })
    }
  }

  const handleContinue = async () => {
    if (!decision || !reconnectKey || !decisionAvailable || !decision.isPending()) return
    const record = chatMcpReconnectRecord(reconnectKey)
    if (record.responseSubmitted || (record.phase !== "connected" && record.phase !== "skipped")) return
    const epoch = lifecycle.current
    setRecord(reconnectKey, { ...record, error: null })
    try {
      await respondChatConnectionDecision(reconnectKey, decision, record.phase === "connected"
        ? { outcome: "connected", continuation: "review_remaining_work", repeatCompletedWrites: false }
        : { outcome: "skipped", continuation: "without_connection", alternativeAuthorization: false })
    } catch (error) {
      if (epoch !== lifecycle.current || current.current.scope !== scope) return
      setRecord(reconnectKey, { ...chatMcpReconnectRecord(reconnectKey), error: error instanceof Error ? error.message : "Could not deliver the decision." })
    }
  }

  const handleDismiss = () => {
    if (reconnectBlocked || !reconnectKey || reconnectAction) return
    setRecord(reconnectKey, { phase: "skipped", error: null, authorizeUrl: null })
  }

  return { reconnectAction, reconnectState, reconnectError, reconnectPresentation, reconnectBlocked, decisionAvailable, responseSubmitted, handleReconnect, handleSkip, handleContinue, handleDismiss }
}
