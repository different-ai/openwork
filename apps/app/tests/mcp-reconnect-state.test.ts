import { beforeEach, describe, expect, test } from "bun:test"
import {
  chatMcpReconnectKey,
  chatMcpReconnectPresentation,
  chatMcpReconnectRecord,
  respondChatConnectionDecision,
  useChatMcpReconnectStore,
} from "../src/components/tools/mcp-reconnect-state"
import type { ChatConnectionDecisionBinding, ChatConnectionDecisionResponse } from "../src/react-app/domains/session/surface/mcp-chat-reconnect"

const action = { connectionId: "connection-1", connectionName: "Research Vault", label: "Reconnect" }
const request = { requestId: "request-1", owner: "account/session", sessionId: "session", turnId: "turn-1", toolCallId: "call-1", connectionId: action.connectionId }
const skipped: ChatConnectionDecisionResponse = { outcome: "skipped", continuation: "without_connection", alternativeAuthorization: false }
const connected: ChatConnectionDecisionResponse = { outcome: "connected", continuation: "review_remaining_work", repeatCompletedWrites: false }
const key = chatMcpReconnectKey(request.toolCallId, request.connectionId, request.owner)

beforeEach(() => useChatMcpReconnectStore.getState().reset())

describe("connection decisions", () => {
  test("state labels offer authentication without draft retry or paused claims", () => {
    expect(chatMcpReconnectPresentation(action, "ready")).toEqual({ badgeLabel: "Authenticate Research Vault to continue", buttonLabel: "Authenticate", disabled: false })
    expect(chatMcpReconnectPresentation(action, "opening").disabled).toBe(true)
    expect(chatMcpReconnectPresentation(action, "authorization_opened")).toEqual({ badgeLabel: "Finish sign-in in your browser", buttonLabel: "Open sign-in again", disabled: false })
    expect(chatMcpReconnectPresentation(action, "connected")).toEqual({ badgeLabel: "Research Vault connected", buttonLabel: "Connected", disabled: true })
    expect(chatMcpReconnectPresentation(action, "skipped")).toEqual({ badgeLabel: "Skipped Research Vault", buttonLabel: "Skipped", disabled: true })
    expect(chatMcpReconnectPresentation(action, "failed").buttonLabel).toBe("Authenticate")
  })

  test("skipped decision survives row remount reads but never crosses owner or call scope", () => {
    useChatMcpReconnectStore.getState().setRecord(key, { phase: "skipped", error: null, authorizeUrl: null })
    expect(chatMcpReconnectRecord(key).phase).toBe("skipped")
    expect(chatMcpReconnectRecord(chatMcpReconnectKey("call-2", request.connectionId, request.owner)).phase).toBe("ready")
    expect(chatMcpReconnectRecord(chatMcpReconnectKey(request.toolCallId, request.connectionId, "other-account/session")).phase).toBe("ready")
  })

  test("preserves the browser URL for explicit reopen only", () => {
    const authorizeUrl = "https://provider.example/authorize"
    useChatMcpReconnectStore.getState().setRecord(key, { phase: "authorization_opened", error: null, authorizeUrl })
    expect(chatMcpReconnectRecord(key).authorizeUrl).toBe(authorizeUrl)
    useChatMcpReconnectStore.getState().reset()
    expect(chatMcpReconnectRecord(key).authorizeUrl).toBeNull()
  })

  test("duplicate decisions cannot deliver two continuations", async () => {
    const responses: ChatConnectionDecisionResponse[] = []
    let finish = () => {}
    const pending = new Promise<void>(resolve => { finish = resolve })
    const binding: ChatConnectionDecisionBinding = { request, isPending: () => true, respond: async response => { responses.push(response); await pending } }
    const first = respondChatConnectionDecision(key, binding, connected)
    expect(await respondChatConnectionDecision(key, binding, skipped)).toBe(false)
    finish()
    expect(await first).toBe(true)
    expect(responses).toEqual([connected])
    expect(await respondChatConnectionDecision(key, binding, connected)).toBe(false)
  })

  test("skip explicitly declines the dependency and alternative authorization", async () => {
    const responses: ChatConnectionDecisionResponse[] = []
    const binding: ChatConnectionDecisionBinding = { request, isPending: () => true, respond: async response => { responses.push(response) } }
    expect(await respondChatConnectionDecision(key, binding, skipped)).toBe(true)
    expect(responses).toEqual([skipped])
  })

  test("stale or unrelated running work cannot receive a decision", async () => {
    let delivered = false
    const binding: ChatConnectionDecisionBinding = { request, isPending: () => false, respond: async () => { delivered = true } }
    expect(await respondChatConnectionDecision(key, binding, connected)).toBe(false)
    expect(delivered).toBe(false)
    expect(chatMcpReconnectRecord(key).responseSubmitted).toBeUndefined()
  })

  test("a rejected native reply releases the latch without automatically retrying", async () => {
    let calls = 0
    const binding: ChatConnectionDecisionBinding = { request, isPending: () => true, respond: async () => { calls += 1; if (calls === 1) throw new Error("Reply rejected") } }
    await expect(respondChatConnectionDecision(key, binding, skipped)).rejects.toThrow("Reply rejected")
    expect(chatMcpReconnectRecord(key).responseSubmitted).toBe(false)
    expect(calls).toBe(1)
    expect(await respondChatConnectionDecision(key, binding, skipped)).toBe(true)
    expect(calls).toBe(2)
  })
})
