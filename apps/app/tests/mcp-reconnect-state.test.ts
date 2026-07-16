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
    useChatMcpReconnectStore.getState().setRecord(key, { phase: "connected", error: null })

    expect(chatMcpReconnectRecord(key)).toEqual({ phase: "connected", error: null })
    expect(chatMcpReconnectRecord(chatMcpReconnectKey("call-2", action.connectionId))).toEqual({
      phase: "ready",
      error: null,
    })
  })

  test("presents a safe retry only after reconnection completes", () => {
    expect(chatMcpReconnectPresentation(action, "ready")).toEqual({
      badgeLabel: "Reconnect required",
      buttonLabel: "Reconnect",
      disabled: false,
    })
    expect(chatMcpReconnectPresentation(action, "authorization_opened")).toEqual({
      badgeLabel: "Reconnect required",
      buttonLabel: "Finish in browser",
      disabled: true,
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
