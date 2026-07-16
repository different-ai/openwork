import { beforeEach, describe, expect, test } from "bun:test"

import {
  chatMcpReconnectKey,
  chatMcpReconnectPresentation,
  chatMcpReconnectRecord,
  useChatMcpReconnectStore,
} from "../src/components/tools/mcp-reconnect-state"

const action = {
  connectionId: "emc_research",
  connectionName: "Research Vault",
  label: "Reconnect",
}

beforeEach(() => useChatMcpReconnectStore.getState().reset())

describe("chat MCP reconnect state", () => {
  test("keeps completion by tool call and connection across component remounts", () => {
    const key = chatMcpReconnectKey("call-1", action.connectionId)
    useChatMcpReconnectStore.getState().setRecord(key, { phase: "connected", error: null, authorizeUrl: null })

    expect(chatMcpReconnectRecord(key)).toEqual({ phase: "connected", error: null, authorizeUrl: null })
    expect(chatMcpReconnectRecord(chatMcpReconnectKey("call-2", action.connectionId))).toEqual({
      phase: "ready",
      error: null,
      authorizeUrl: null,
    })
  })

  test("keeps the pending browser continuation across chat row remounts", () => {
    const key = chatMcpReconnectKey("call-1", action.connectionId)
    const authorizeUrl = "https://provider.example/authorize?state=pending"
    useChatMcpReconnectStore.getState().setRecord(key, {
      phase: "authorization_opened",
      error: null,
      authorizeUrl,
    })

    expect(chatMcpReconnectRecord(key)).toEqual({
      phase: "authorization_opened",
      error: null,
      authorizeUrl,
    })

    useChatMcpReconnectStore.getState().reset()
    expect(chatMcpReconnectRecord(key)).toEqual({ phase: "ready", error: null, authorizeUrl: null })
  })

  test("presents a safe retry only after reconnection completes", () => {
    expect(chatMcpReconnectPresentation(action, "ready")).toEqual({
      badgeLabel: "Reconnect required",
      buttonLabel: "Reconnect",
      disabled: false,
    })
    expect(chatMcpReconnectPresentation(action, "authorization_opened")).toEqual({
      badgeLabel: "Reconnect required",
      buttonLabel: "Open sign-in again",
      disabled: false,
    })
    expect(chatMcpReconnectPresentation(action, "connected")).toEqual({
      badgeLabel: "Reconnected",
      buttonLabel: "Try again",
      disabled: false,
    })
    expect(chatMcpReconnectPresentation(action, "failed")).toEqual({
      badgeLabel: "Reconnect failed",
      buttonLabel: "Try reconnecting",
      disabled: false,
    })
  })
})
