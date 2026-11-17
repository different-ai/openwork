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
  chatMcpConnectionKey,
  chatMcpReconnectKey,
  chatMcpReconnectPresentation,
  chatMcpReconnectRecord,
  effectiveChatMcpReconnectRecord,
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
let attemptSequence = 0

type LiveReconnectCard = {
  reconnectKey: string
  toolCallId: string
  blocked: boolean
  candidateDecision: () => ChatConnectionDecisionBinding | null
  decision: () => ChatConnectionDecisionBinding | null
  continueAfterConnection?: (toolCallId: string) => void
}

/**
 * The cards on screen for each connection. A sign-in finishes long after the
 * click, and by then the card may sit on a newer tool call: the outcome is
 * delivered through whichever card is mounted, never through the closure of
 * the one that was clicked.
 */
const liveCards = new Map<string, Map<string, { current: LiveReconnectCard | null }>>()

function liveCardsFor(connectionKey: string): LiveReconnectCard[] {
  return [...(liveCards.get(connectionKey)?.values() ?? [])].flatMap(entry => entry.current ? [entry.current] : [])
}

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
  const connectionKey = connectionId ? chatMcpConnectionKey(connectionId, scope) : null
  const readCandidateDecision = () => suppliedDecision ?? messageList?.getConnectionDecision?.(toolPart.toolCallId) ?? null
  const readDecision = () => {
    const candidate = readCandidateDecision()
    return candidate?.request.toolCallId === toolPart.toolCallId
      && candidate.request.connectionId === connectionId && candidate.request.owner === scope
      ? candidate : null
  }
  const candidateDecision = readCandidateDecision()
  const decision = readDecision()
  const lifecycle = useRef(0)
  const current = useRef({ scope, reconnectBlocked })
  current.current = { scope, reconnectBlocked }
  useEffect(() => () => { lifecycle.current += 1 }, [scope])
  const live = useRef<LiveReconnectCard | null>(null)
  live.current = reconnectKey ? {
    reconnectKey,
    toolCallId: toolPart.toolCallId,
    blocked: reconnectBlocked,
    candidateDecision: readCandidateDecision,
    decision: readDecision,
    continueAfterConnection: messageList?.continueAfterConnection,
  } : null
  useEffect(() => {
    if (!connectionKey) return
    const cards = liveCards.get(connectionKey) ?? new Map<string, { current: LiveReconnectCard | null }>()
    cards.set(instanceId, live)
    liveCards.set(connectionKey, cards)
    return () => {
      cards.delete(instanceId)
      if (cards.size === 0 && liveCards.get(connectionKey) === cards) liveCards.delete(connectionKey)
    }
  }, [connectionKey, instanceId])
  const reconnectState = useChatMcpReconnectStore(store => reconnectKey && connectionKey ? effectiveChatMcpReconnectRecord(store, reconnectKey, connectionKey).phase : "ready")
  const reconnectError = useChatMcpReconnectStore(store => reconnectKey && connectionKey ? effectiveChatMcpReconnectRecord(store, reconnectKey, connectionKey).error : null)
  const responseSubmitted = useChatMcpReconnectStore(store => reconnectKey ? store.records[reconnectKey]?.responseSubmitted === true : false)
  const setRecord = useChatMcpReconnectStore(store => store.setRecord)
  const reconnectPresentation = reconnectAction ? chatMcpReconnectPresentation(reconnectAction, reconnectState) : null
  const decisionAvailable = Boolean(decision?.isPending()) && !reconnectBlocked

  const handleReconnect = async () => {
    if (!reconnectAction || !reconnectKey || !connectionKey || !onReconnect || reconnectBlocked) return
    if (candidateDecision && !decision) return
    if (decision && !decision.isPending()) return
    const record = chatMcpReconnectRecord(reconnectKey, connectionKey)
    if (record.phase === "connected" || record.phase === "skipped" || record.phase === "opening" || record.responseSubmitted) return
    const store = useChatMcpReconnectStore.getState()
    if (record.phase === "authorization_opened") {
      const attemptId = store.attempts[connectionKey]?.id
      const isCurrent = () => useChatMcpReconnectStore.getState().attempts[connectionKey]?.id === attemptId
      if (!onReopenAuthorization || !record.authorizeUrl || reopening.has(connectionKey)) return
      reopening.add(connectionKey)
      try {
        await onReopenAuthorization(reconnectAction, record.authorizeUrl, isCurrent)
      } catch (error) {
        if (isCurrent()) setRecord(reconnectKey, { ...chatMcpReconnectRecord(reconnectKey), error: error instanceof Error ? error.message : "Could not reopen sign-in." })
      } finally {
        reopening.delete(connectionKey)
      }
      return
    }
    attemptSequence += 1
    const attemptId = attemptSequence
    // The sign-in stays current until it settles or someone skips it; the card
    // that started it unmounting is not a reason to stop waiting.
    const isCurrent = () => useChatMcpReconnectStore.getState().attempts[connectionKey]?.id === attemptId
    const settle = (settled: { phase: "connected" | "failed"; error: string | null }) => {
      const cards = liveCardsFor(connectionKey)
      useChatMcpReconnectStore.getState().settleAttempt(
        connectionKey,
        [...new Set([reconnectKey, ...cards.map(card => card.reconnectKey)])],
        { ...settled, authorizeUrl: null },
      )
      return cards.filter(card => !card.blocked)
    }
    store.setAttempt(connectionKey, { id: attemptId, phase: "opening", authorizeUrl: null })
    try {
      const result = await onReconnect(reconnectAction, progress => {
        if (!isCurrent()) return
        useChatMcpReconnectStore.getState().setAttempt(connectionKey, {
          id: attemptId, phase: progress.phase, authorizeUrl: progress.phase === "authorization_opened" ? progress.authorizeUrl : null,
        })
      }, isCurrent)
      if (!isCurrent()) return
      const cards = settle({ phase: result, error: null })
      // The question may have been asked, or the card moved, after the click.
      const bound = cards.flatMap(card => {
        const binding = card.decision()
        return binding?.isPending() ? [{ card, binding }] : []
      })[0]
      if (bound) {
        try {
          await respondChatConnectionDecision(bound.card.reconnectKey, bound.binding, {
            outcome: "connected", continuation: "review_remaining_work", repeatCompletedWrites: false,
          })
        } catch (error) {
          // Signed in, but the answer did not reach the agent: the card offers Continue.
          setRecord(bound.card.reconnectKey, {
            ...chatMcpReconnectRecord(bound.card.reconnectKey),
            error: error instanceof Error ? error.message : "Could not deliver the decision.",
          })
        }
      } else if (!cards.some(card => card.candidateDecision())) {
        // The turn ended on this card rather than waiting on a question: carry it on.
        const card = cards.find(entry => entry.reconnectKey === reconnectKey) ?? cards.at(-1)
        card?.continueAfterConnection?.(card.toolCallId)
      }
    } catch (error) {
      if (!isCurrent()) return
      settle({ phase: "failed", error: error instanceof Error ? error.message : "Could not reconnect this account." })
    }
  }

  const handleSkip = async () => {
    if (!decision || !reconnectKey || !decisionAvailable || !decision.isPending()) return
    const record = chatMcpReconnectRecord(reconnectKey)
    if (record.phase === "connected" || record.phase === "skipped" || record.responseSubmitted) return
    if (connectionKey) useChatMcpReconnectStore.getState().setAttempt(connectionKey, null)
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
