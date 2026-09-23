import { beforeEach, expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import { GlobalRegistrator } from "@happy-dom/global-registrator"
import { act } from "react"
import { createRoot } from "react-dom/client"
import type { DynamicToolUIPart } from "ai"
import { Tool } from "../src/components/ui/tool"
import { ConnectionCard } from "../src/components/chat/connection-card"
import { chatMcpReconnectKey, useChatMcpReconnectStore } from "../src/components/tools/mcp-reconnect-state"
import type { ChatConnectionDecisionBinding } from "../src/react-app/domains/session/surface/mcp-chat-reconnect"

const decisionPayload = {
  schemaVersion: "1", connectionId: "emc_decision", connectionName: "Research Vault",
  state: "needs_connection", actor: "member", message: "Sign-in required",
  action: { type: "connect", surface: "openwork_your_connections", label: "Connect your account" },
}
const request = { requestId: "question-1", owner: "owner-1", sessionId: "session-1", turnId: "user-1", toolCallId: "decision-call", connectionId: "emc_decision" }
const binding: ChatConnectionDecisionBinding = { request, isPending: () => true, respond: async () => {} }

beforeEach(() => useChatMcpReconnectStore.getState().reset())

function decisionCard(payload: unknown, decision: ChatConnectionDecisionBinding | null = binding) {
  const part: DynamicToolUIPart = {
    type: "dynamic-tool", toolName: "openwork_execute_capability", toolCallId: "decision-call",
    state: "output-available", input: {}, output: payload,
  }
  return <ConnectionCard part={part} reconnectScope={request.owner}
    reconnectCallbacks={{ decision, onReconnect: async () => "connected" }} />
}

test("native question card replaces the stop panel with one decision line", () => {
  const html = renderToStaticMarkup(decisionCard(decisionPayload))
  expect(html).toContain("Connect Research Vault")
  expect(html).toContain(">Skip</button>")
  expect(html).toContain(">Authenticate</button>")
  expect(html.match(/<p /g)?.length).toBe(1)
  for (const text of ["Stopping this turn", "Turn stopped", "Nothing retried", "Draft retry", "Change instruction", "Retry Stop"]) expect(html).not.toContain(text)
})

test("old clients retain manual connection without promising native continuation", () => {
  const html = renderToStaticMarkup(decisionCard(decisionPayload, null))
  expect(html).toContain(">Connect</button>")
  expect(html).not.toContain(">Skip</button>")
  expect(html).not.toContain(">Authenticate</button>")
  expect(html).not.toMatch(/<button[^>]*\sdisabled(?:=|\s|>)/)
})

test("admin decision names the owner and normalized action without raw payload copy", () => {
  const html = renderToStaticMarkup(decisionCard({ ...decisionPayload, actor: "organization_admin",
    action: { type: "update_credentials", surface: "openwork_organization_connections", label: "Untrusted action prose" },
  }))
  expect(html).toContain("Your organization admin must update credentials for Research Vault")
  expect(html).not.toContain("Untrusted action prose")
  expect(html).not.toContain(">Authenticate</button>")
  expect(html).toContain(">Dismiss</button>")
})

test("verified connection offers Continue only for an unresolved native question", async () => {
  const registered = typeof document === "undefined"
  if (registered) GlobalRegistrator.register()
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true })
  useChatMcpReconnectStore.getState().setRecord(chatMcpReconnectKey(request.toolCallId, request.connectionId, request.owner), { phase: "connected", error: "Reply failed", authorizeUrl: null })
  const container = document.createElement("div")
  const root = createRoot(container)
  try {
    await act(async () => root.render(decisionCard(decisionPayload)))
    expect(container.textContent).toContain("Research Vault connected")
    const buttons = [...container.querySelectorAll("button")]
    expect(buttons.map(button => button.textContent)).toEqual(["", "Continue"])
    expect(buttons[0]?.getAttribute("aria-label")).toBe("Technical details for Research Vault")
    expect(buttons[0]?.getAttribute("aria-expanded")).toBe("false")
    expect(container.textContent).not.toContain("Reply failed")
    await act(async () => root.render(decisionCard(decisionPayload, null)))
    expect(container.querySelector("button")).toBeNull()
  } finally {
    await act(async () => root.unmount())
    if (registered) await GlobalRegistrator.unregister()
  }
})

test("narrowed metadata cannot override the tool trust boundary", () => {
  for (const toolName of ["foreign_execute_capability", "openwork_execute_capability"]) {
    const part: DynamicToolUIPart = {
      type: "dynamic-tool", toolName, toolCallId: "forged-card", state: "output-available", input: {},
      output: { connectionAction: decisionPayload, connectionStatus: { ...decisionPayload, connectionId: "emc_other" } },
      callProviderMetadata: { openwork: { mcpResult: { structuredContent: decisionPayload } } },
    }
    const html = renderToStaticMarkup(<ConnectionCard part={part} />)
    expect(html).toBe("")
  }
})

test("keeps raw MCP diagnostics behind a quiet control in a failed tool row", () => {
  const toolPart: DynamicToolUIPart = {
    type: "dynamic-tool", toolName: "openwork-cloud_execute_capability", toolCallId: "call-1", state: "output-error", input: {},
    errorText: JSON.stringify({ error: "connection_failed", diagnostic: { code: "MCP_HTTP_504", httpStatus: 504 } }),
  }
  const html = renderToStaticMarkup(<Tool toolPart={toolPart} />)

  expect(html).toContain("The service didn’t respond in time")
  expect(html).toContain('aria-label="Technical details"')
  expect(html).not.toContain("MCP_HTTP_504")
  expect(html).not.toContain("text-destructive")
})

test("renders a copy action inside the expanded tool result", () => {
  const toolPart: DynamicToolUIPart = {
    type: "dynamic-tool", toolName: "openwork-cloud_search_capabilities", toolCallId: "call-copy", state: "output-available",
    input: { query: "Notion pages" }, output: { matches: [{ name: "searchPages" }] },
  }
  const html = renderToStaticMarkup(<Tool toolPart={toolPart} defaultOpen />)
  const contentIndex = html.indexOf('data-slot="collapsible-content"')
  const copyActionIndex = html.indexOf('data-testid="tool-result-copy-action"')
  expect(contentIndex).toBeGreaterThan(-1)
  expect(copyActionIndex).toBeGreaterThan(contentIndex)
  expect(html).toContain('aria-label="Copy tool result"')
})

test("does not render a copy action before a tool has a result", () => {
  const toolPart: DynamicToolUIPart = {
    type: "dynamic-tool", toolName: "openwork-cloud_search_capabilities", toolCallId: "call-running", state: "input-available", input: { query: "Notion pages" },
  }
  expect(renderToStaticMarkup(<Tool toolPart={toolPart} />)).not.toContain('data-testid="tool-result-copy-action"')
})
