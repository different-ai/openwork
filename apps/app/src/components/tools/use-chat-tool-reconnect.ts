"use client"

import type { DynamicToolUIPart, ToolUIPart } from "ai"

import {
  reconnectActionFromChatToolResult,
  type ChatToolReconnectAction,
  type ChatToolReconnectProgress,
  type ChatToolReconnectResult,
} from "@/components/tools/error-attribution"
import {
  chatMcpReconnectKey,
  chatMcpReconnectPresentation,
  useChatMcpReconnectStore,
} from "@/components/tools/mcp-reconnect-state"

export type ChatToolReconnectCallbacks = {
  onReconnect?: (
    action: ChatToolReconnectAction,
    onProgress: (progress: ChatToolReconnectProgress) => void,
  ) => Promise<ChatToolReconnectResult>
  onReopenAuthorization?: (action: ChatToolReconnectAction, authorizeUrl: string) => Promise<void>
  onRetry?: (action: ChatToolReconnectAction) => void | Promise<void>
}

/**
 * Reconnect/Retry state for a chat tool call, shared between the generic
 * Tool card and the sentence-style failure line. Only OpenWork Cloud
 * capability tools can produce a reconnect action (see error-attribution).
 */
export function useChatToolReconnect(
  toolPart: ToolUIPart | DynamicToolUIPart,
  { onReconnect, onReopenAuthorization, onRetry }: ChatToolReconnectCallbacks,
) {
  const isError = toolPart.state === "output-error"
  const reconnectResult = isError && toolPart.errorText
    ? toolPart.errorText
    : toolPart.state === "output-available" && "output" in toolPart
      ? toolPart.output
      : undefined
  const reconnectAction = toolPart.type === "dynamic-tool" && reconnectResult !== undefined
    ? reconnectActionFromChatToolResult(toolPart.toolName, reconnectResult)
    : null
  const reconnectKey = reconnectAction
    ? chatMcpReconnectKey(toolPart.toolCallId, reconnectAction.connectionId)
    : null
  const reconnectState = useChatMcpReconnectStore((store) => (
    reconnectKey ? store.records[reconnectKey]?.phase ?? "ready" : "ready"
  ))
  const reconnectError = useChatMcpReconnectStore((store) => (
    reconnectKey ? store.records[reconnectKey]?.error ?? null : null
  ))
  const reconnectAuthorizeUrl = useChatMcpReconnectStore((store) => (
    reconnectKey ? store.records[reconnectKey]?.authorizeUrl ?? null : null
  ))
  const setReconnectRecord = useChatMcpReconnectStore((store) => store.setRecord)
  const reconnectPresentation = reconnectAction
    ? chatMcpReconnectPresentation(reconnectAction, reconnectState)
    : null

  const handleReconnect = async () => {
    if (!reconnectAction || !reconnectKey || !onReconnect) return
    if (reconnectState === "connected") {
      await onRetry?.(reconnectAction)
      return
    }
    if (reconnectState === "authorization_opened") {
      if (!onReopenAuthorization) return
      if (!reconnectAuthorizeUrl) {
        setReconnectRecord(reconnectKey, {
          phase: "failed",
          error: `${reconnectAction.connectionName} sign-in is no longer pending. Try reconnecting again.`,
          authorizeUrl: null,
        })
        return
      }
      try {
        await onReopenAuthorization(reconnectAction, reconnectAuthorizeUrl)
        setReconnectRecord(reconnectKey, {
          phase: "authorization_opened",
          error: null,
          authorizeUrl: reconnectAuthorizeUrl,
        })
      } catch (error) {
        setReconnectRecord(reconnectKey, {
          phase: "failed",
          error: error instanceof Error ? error.message : "Could not reopen sign-in.",
          authorizeUrl: null,
        })
      }
      return
    }
    if (reconnectState === "opening") return
    setReconnectRecord(reconnectKey, { phase: "opening", error: null, authorizeUrl: null })
    try {
      const result = await onReconnect(reconnectAction, (progress) => {
        setReconnectRecord(reconnectKey, {
          phase: progress.phase,
          error: null,
          authorizeUrl: progress.phase === "authorization_opened" ? progress.authorizeUrl : null,
        })
      })
      setReconnectRecord(reconnectKey, { phase: result, error: null, authorizeUrl: null })
    } catch (error) {
      setReconnectRecord(reconnectKey, {
        phase: "failed",
        error: error instanceof Error ? error.message : "Could not reconnect this account.",
        authorizeUrl: null,
      })
    }
  }

  return { reconnectAction, reconnectState, reconnectError, reconnectPresentation, handleReconnect }
}
