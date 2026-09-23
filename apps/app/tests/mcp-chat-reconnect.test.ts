import { describe, expect, test } from "bun:test"
import type { UIMessage } from "ai"
import type { DenExternalMcpConnection } from "../src/app/lib/den"
import { parseDynamicToolUIPart } from "../src/react-app/domains/session/sync/parse-tool-parts"

import {
  hasFreshMcpAuthorization,
  isCurrentChatConnectionDecision,
  nativeChatConnectionDecision,
  isReservedConnectionQuestion,
  composerQuestionForConnectionDecision,
  authenticateChatConnection,
  type ChatConnectionDecisionRequest,
  isChatMcpReconnectScopeCurrent,
  waitForFreshMcpAuthorization,
} from "../src/react-app/domains/session/surface/mcp-chat-reconnect"

const baseConnection: DenExternalMcpConnection = {
  id: "emc_research",
  name: "Research Vault",
  url: "https://mcp.test/endpoint",
  authType: "oauth",
  credentialMode: "per_member",
  exposeDirectly: false,
  connected: true,
  connectedAt: "2026-07-16T20:00:00.000Z",
  connectedForMe: true,
}

describe("chat MCP reconnect completion", () => {
  test("requires a new member authorization timestamp, not merely an existing token", () => {
    expect(hasFreshMcpAuthorization(baseConnection, baseConnection.connectedAt)).toBe(false)
    expect(hasFreshMcpAuthorization({
      ...baseConnection,
      connectedAt: "2026-07-16T20:01:00.000Z",
    }, baseConnection.connectedAt)).toBe(true)
  })

  test("polls through the unchanged credential until the OAuth callback advances it", async () => {
    let now = 0
    let lists = 0
    const result = await waitForFreshMcpAuthorization({
      connectionId: baseConnection.id,
      connectionName: baseConnection.name,
      previousConnectedAt: baseConnection.connectedAt,
      listConnections: async () => {
        lists += 1
        return [{
          ...baseConnection,
          connectedAt: lists < 2 ? baseConnection.connectedAt : "2026-07-16T20:01:00.000Z",
        }]
      },
      isScopeCurrent: () => true,
      timeoutMs: 10,
      intervalMs: 1,
      now: () => now,
      sleep: async (milliseconds) => { now += milliseconds },
    })

    expect(result.connectedAt).toBe("2026-07-16T20:01:00.000Z")
    expect(lists).toBe(2)
  })

  test("stops if the active Den account or organization changes", async () => {
    const original = { baseUrl: "https://den.test", token: "member-a", organizationId: "org-a" }
    expect(isChatMcpReconnectScopeCurrent(original, { ...original })).toBe(true)
    expect(isChatMcpReconnectScopeCurrent(original, { ...original, organizationId: "org-b" })).toBe(false)

    await expect(waitForFreshMcpAuthorization({
      connectionId: baseConnection.id,
      connectionName: baseConnection.name,
      previousConnectedAt: baseConnection.connectedAt,
      listConnections: async () => [baseConnection],
      isScopeCurrent: () => false,
      timeoutMs: 10,
      intervalMs: 1,
    })).rejects.toThrow("active OpenWork Cloud account changed")
  })

  test("times out without claiming a stale connected account was repaired", async () => {
    let now = 0
    await expect(waitForFreshMcpAuthorization({
      connectionId: baseConnection.id,
      connectionName: baseConnection.name,
      previousConnectedAt: baseConnection.connectedAt,
      listConnections: async () => [baseConnection],
      isScopeCurrent: () => true,
      timeoutMs: 3,
      intervalMs: 1,
      now: () => now,
      sleep: async (milliseconds) => { now += milliseconds },
    })).rejects.toThrow("did not finish")
  })
})

const request: ChatConnectionDecisionRequest = {
  requestId: "request-1", owner: "account/session", sessionId: "session-1",
  turnId: "user-1", toolCallId: "call-1", connectionId: "connection-1",
}
const messages: UIMessage[] = [
  { id: "user-1", role: "user", parts: [{ type: "text", text: "Read the calendar" }] },
  { id: "assistant-1", role: "assistant", parts: [{ type: "dynamic-tool", toolName: "openwork-cloud_execute_capability", toolCallId: "call-1", state: "input-available", input: {} }] },
]

test("decision requires the exact current user turn, session, principal and tool call", () => {
  expect(isCurrentChatConnectionDecision(request, request.owner, request.sessionId, messages)).toBe(true)
  expect(isCurrentChatConnectionDecision(request, null, request.sessionId, messages)).toBe(false)
  expect(isCurrentChatConnectionDecision(request, "another-account", request.sessionId, messages)).toBe(false)
  expect(isCurrentChatConnectionDecision(request, request.owner, "another-session", messages)).toBe(false)
  expect(isCurrentChatConnectionDecision({ ...request, toolCallId: "old-call" }, request.owner, request.sessionId, messages)).toBe(false)
  expect(isCurrentChatConnectionDecision({ ...request, requestId: "" }, request.owner, request.sessionId, messages)).toBe(false)
  expect(isCurrentChatConnectionDecision(request, request.owner, request.sessionId, [])).toBe(false)
  expect(isCurrentChatConnectionDecision(request, request.owner, request.sessionId, [
    ...messages, { id: "user-2", role: "user", parts: [{ type: "text", text: "Different task" }] },
  ])).toBe(false)
})

const questionItem = {
  header: "Connection", question: "Connect Research Vault to continue?", multiple: false, custom: false,
  options: [{ label: "Authenticate", description: "Connect account" }, { label: "Skip", description: "Continue without this connection" }],
}
const nativeQuestion = { id: "question-1", sessionID: "session-1", tool: { messageID: "assistant-question", callID: "question-call" }, questions: [questionItem] }
const blockedPayload = {
  schemaVersion: "1", connectionId: "connection-1", connectionName: "Research Vault", state: "needs_connection", actor: "member", message: "Sign-in required",
  action: { type: "connect", label: "Connect", surface: "openwork_your_connections" },
}
function nativeMessages(output: unknown = blockedPayload, toolName = "openwork_execute_capability"): UIMessage[] {
  return [
    messages[0],
    { id: "assistant-result", role: "assistant", parts: [{ type: "dynamic-tool", toolName, toolCallId: "call-1", state: "output-available", input: {}, output }] },
    { id: "assistant-question", role: "assistant", parts: [{ type: "dynamic-tool", toolName: "question", toolCallId: "question-call", state: "input-available", input: { questions: [questionItem] } }] },
  ]
}
function bindQuestion(question: unknown = nativeQuestion, transcript = nativeMessages()) {
  return nativeChatConnectionDecision({ question, owner: request.owner, sessionId: request.sessionId, messages: transcript })
}

test("binds initial connect and reconnect to the exact native question", () => {
  expect(bindQuestion()).toEqual({ ...request, requestId: "question-1", questionToolCallId: "question-call" })
  expect(bindQuestion(nativeQuestion, nativeMessages({ ...blockedPayload, state: "reauth_required", action: { ...blockedPayload.action, type: "reconnect" } }))).toEqual({ ...request, requestId: "question-1", questionToolCallId: "question-call" })
  expect(bindQuestion({ ...nativeQuestion, tool: undefined, sessionID: undefined })).not.toBeNull()
})

test("binds native engine questions that omit the custom option", () => {
  const { custom, ...engineQuestion } = questionItem
  expect(custom).toBe(false)
  const question = { ...nativeQuestion, questions: [engineQuestion] }
  expect(isReservedConnectionQuestion(question)).toBe(true)
  expect(bindQuestion(question)).toEqual({ ...request, requestId: "question-1", questionToolCallId: "question-call" })
  expect(bindQuestion({ ...question, tool: { callID: "other-call" } })).toBeNull()
})

test("native connection binding fails closed on malformed questions and mismatched session or question tool", () => {
  for (const question of [
    null,
    { ...nativeQuestion, sessionID: "other-session" },
    { ...nativeQuestion, tool: { callID: "old-question" } },
    { ...nativeQuestion, tool: { callID: "call-1" } },
    { ...nativeQuestion, tool: { callID: "question-call", messageID: "old-message" } },
    { ...nativeQuestion, questions: [questionItem, questionItem] },
    ...[
      { ...questionItem, header: "Other" },
      { ...questionItem, question: "Connect Other to continue?" },
      { ...questionItem, multiple: true },
      { ...questionItem, custom: true },
      { ...questionItem, options: [...questionItem.options].reverse() },
    ].map(question => ({ ...nativeQuestion, questions: [question] })),
  ]) expect(bindQuestion(question)).toBeNull()
})

test("question text alone cannot authorize historical, foreign, admin or ambiguous connections", () => {
  expect(bindQuestion(nativeQuestion, nativeMessages(blockedPayload, "foreign_execute_capability"))).toBeNull()
  expect(bindQuestion(nativeQuestion, nativeMessages({ ...blockedPayload, actor: "organization_admin" }))).toBeNull()
  expect(bindQuestion(nativeQuestion, nativeMessages({ ...blockedPayload, state: "connected" }))).toBeNull()
  expect(bindQuestion(nativeQuestion, [...nativeMessages(), { id: "new-user", role: "user", parts: [] }])).toBeNull()
  const other: UIMessage = { id: "other-result", role: "assistant", parts: [{ type: "dynamic-tool", toolName: "openwork_execute_capability", toolCallId: "other-call", state: "output-available", input: {}, output: { ...blockedPayload, connectionId: "connection-2" } }] }
  expect(bindQuestion(nativeQuestion, [...nativeMessages(), other])).toBeNull()
  expect(bindQuestion(nativeQuestion, nativeMessages({ connectionAction: blockedPayload, connectionStatus: { ...blockedPayload, connectionId: "other" } }))).toBeNull()
})

test("reserved recognition remains independent of identity, result and request timing", () => {
  expect(isReservedConnectionQuestion({ questions: [questionItem] })).toBe(true)
  expect(isReservedConnectionQuestion({ questions: [questionItem, questionItem] })).toBe(true)
  expect(isReservedConnectionQuestion({ ...nativeQuestion, sessionID: "wrong-session" })).toBe(true)
  expect(isReservedConnectionQuestion({ ...nativeQuestion, questions: [{ ...questionItem, question: "Connect Another to continue?" }] })).toBe(true)
  expect(isReservedConnectionQuestion({ questions: [{ ...questionItem, custom: true }] })).toBe(false)
  expect(isReservedConnectionQuestion({ questions: [{ ...questionItem, multiple: true }] })).toBe(false)
  expect(nativeChatConnectionDecision({ question: nativeQuestion, owner: null, sessionId: "session-1", messages: nativeMessages() })).toBeNull()
  expect(bindQuestion(nativeQuestion, [messages[0]])).toBeNull()
})

test("v2 question source part ID resolves to the UI call ID only in the owning message", () => {
  const part = parseDynamicToolUIPart({
    type: "tool", id: "source-question", callID: "ui-question", tool: "question", sessionID: "session-1", messageID: "assistant-question",
    state: { status: "running", input: { questions: [questionItem] }, time: { start: 1 } },
  })
  if (!part) throw new Error("Question part missing")
  expect(part.callProviderMetadata?.openwork?.sourcePartId).toBe("source-question")
  const transcript: UIMessage[] = [...nativeMessages().slice(0, 2), { id: "assistant-question", role: "assistant", parts: [part] }]
  const question = { ...nativeQuestion, tool: { callID: "source-question", messageID: "assistant-question" } }
  expect(bindQuestion(question, transcript)?.questionToolCallId).toBe("ui-question")
  expect(bindQuestion({ ...question, tool: { ...question.tool, messageID: "wrong-message" } }, transcript)).toBeNull()
  expect(bindQuestion({ ...question, tool: { callID: "source-question" } }, transcript)).toBeNull()
})

/**
 * Real transcript: ordinary discovery (no `intent: "connect"`) reported the
 * Stripe blocker twice, a third search matched only an unrelated tool, then
 * the model paused on the reserved question. The question must bind to the
 * latest discovery part carrying Stripe instead of dead-ending the turn.
 */
const stripeStatus = {
  name: "mcp:emc_01kxh1ns3cesjax0x2zz6ekvxm:*", kind: "connection_status", status: "needs_connection",
  connectionStatus: {
    version: 1, kind: "connection_action", source: "openwork-cloud", layer: "downstream_provider",
    connectionId: "emc_01kxh1ns3cesjax0x2zz6ekvxm", connectionName: "Stripe", authType: "oauth", credentialMode: "per_member",
    state: "needs_connection", errorCode: "not_connected", message: "You haven't connected your Stripe account yet.", actor: "member",
    action: { type: "connect", label: "Connect Stripe", surface: "openwork_your_connections", retry: "search_capabilities", url: "https://app.openworklabs.com/x" },
  },
}
const stripeQuestionItem = {
  header: "Connection", question: "Connect Stripe to continue?", multiple: false,
  options: [{ label: "Authenticate", description: "Connect this account to continue." }, { label: "Skip", description: "Continue without this connection." }],
}
const stripeQuestionCallId = "call_yB5y4amCg1D9QsZFUKrYtkHi"
const stripeQuestion = {
  id: "que_0c6b41285001W3e3iAhUamcorJ", sessionID: "session-1", questions: [stripeQuestionItem],
  tool: { messageID: "assistant-stripe", callID: stripeQuestionCallId },
}
function discovery(toolCallId: string, query: string, matches: unknown[]): UIMessage["parts"][number] {
  return {
    type: "dynamic-tool", toolName: "openwork-cloud_search_capabilities", toolCallId, state: "output-available",
    input: { query, type: "mcp", limit: 10 }, output: { matches },
  }
}
function stripeTranscript(extraDiscovery: UIMessage["parts"] = []): UIMessage[] {
  return [
    { id: "user-stripe", role: "user", parts: [{ type: "text", text: "How fast is Stripe revenue growing week over week?" }] },
    { id: "assistant-stripe", role: "assistant", parts: [
      discovery("call_stripe_1", "Stripe weekly revenue growth", [stripeStatus]),
      discovery("call_stripe_2", "Stripe revenue by week", [stripeStatus]),
      discovery("call_granola", "meeting notes", [{ name: "mcp:emc_granola:list_notes", kind: "mcp", description: "Granola notes" }]),
      ...extraDiscovery,
      { type: "dynamic-tool", toolName: "openwork_context", toolCallId: "call_context", state: "output-available", input: {}, output: { screen: "session" } },
      { type: "dynamic-tool", toolName: "question", toolCallId: stripeQuestionCallId, state: "input-available", input: { questions: [stripeQuestionItem] } },
    ] },
  ]
}

test("a reserved question binds to the blocker that ordinary discovery reported, not a dead end", () => {
  expect(nativeChatConnectionDecision({ question: stripeQuestion, owner: request.owner, sessionId: "session-1", messages: stripeTranscript() })).toEqual({
    requestId: "que_0c6b41285001W3e3iAhUamcorJ", owner: request.owner, sessionId: "session-1", turnId: "user-stripe",
    toolCallId: "call_stripe_2", connectionId: "emc_01kxh1ns3cesjax0x2zz6ekvxm", questionToolCallId: stripeQuestionCallId,
  })
})

test("a question naming a connection no discovery reported stays unbound", () => {
  const question = { ...stripeQuestion, questions: [{ ...stripeQuestionItem, question: "Connect Notion to continue?" }] }
  expect(nativeChatConnectionDecision({ question, owner: request.owner, sessionId: "session-1", messages: stripeTranscript() })).toBeNull()
})

test("with two blockers only the one named in the question binds", () => {
  const notionStatus = {
    ...stripeStatus, name: "mcp:emc_notion:*",
    connectionStatus: { ...stripeStatus.connectionStatus, connectionId: "emc_notion", connectionName: "Notion", action: { ...stripeStatus.connectionStatus.action, label: "Connect Notion" } },
  }
  const transcript = stripeTranscript([discovery("call_notion", "Notion pages", [notionStatus])])
  expect(nativeChatConnectionDecision({ question: stripeQuestion, owner: request.owner, sessionId: "session-1", messages: transcript }))
    .toMatchObject({ toolCallId: "call_stripe_2", connectionId: "emc_01kxh1ns3cesjax0x2zz6ekvxm", questionToolCallId: stripeQuestionCallId })
  const notionQuestion = { ...stripeQuestion, questions: [{ ...stripeQuestionItem, question: "Connect Notion to continue?" }] }
  expect(nativeChatConnectionDecision({ question: notionQuestion, owner: request.owner, sessionId: "session-1", messages: transcript }))
    .toMatchObject({ toolCallId: "call_notion", connectionId: "emc_notion", questionToolCallId: stripeQuestionCallId })
})

test("the composer keeps a reserved question unless a native card is bound to it", () => {
  const decision = nativeChatConnectionDecision({ question: stripeQuestion, owner: request.owner, sessionId: "session-1", messages: stripeTranscript() })
  expect(decision).not.toBeNull()
  expect(composerQuestionForConnectionDecision(stripeQuestion, null)).toBe(stripeQuestion)
  expect(composerQuestionForConnectionDecision(stripeQuestion, decision)).toBeNull()
  const ordinary = { ...stripeQuestion, questions: [{ header: "Scope", question: "Which report?", multiple: false, options: [{ label: "Weekly", description: "" }, { label: "Monthly", description: "" }] }] }
  expect(composerQuestionForConnectionDecision(ordinary, null)).toBe(ordinary)
  expect(composerQuestionForConnectionDecision(ordinary, decision)).toBe(ordinary)
  expect(composerQuestionForConnectionDecision(null, decision)).toBeNull()
  expect(composerQuestionForConnectionDecision(undefined, null)).toBeNull()
})

test("cancelled inventory lookup cannot start OAuth or open a browser", async () => {
  let current = true
  let finish: (value: DenExternalMcpConnection[]) => void = () => {}
  const inventory = new Promise<DenExternalMcpConnection[]>(resolve => { finish = resolve })
  let starts = 0
  let opens = 0
  const operation = authenticateChatConnection({
    connectionId: baseConnection.id, connectionName: baseConnection.name, isCurrent: () => current,
    listConnections: () => inventory,
    startConnect: async () => { starts += 1; return { status: "needs_auth", authorizeUrl: "https://provider.example/authorize" } },
    openUrl: async () => { opens += 1 }, onProgress: () => {},
  })
  current = false
  finish([baseConnection])
  await expect(operation).rejects.toThrow("request or account changed")
  expect(starts).toBe(0)
  expect(opens).toBe(0)
})

test("account switch while OAuth start is pending prevents the browser effect", async () => {
  const original = { baseUrl: "https://den.test", token: "account-a", organizationId: "org-a" }
  let current = original
  let finish: (value: { status: "needs_auth"; authorizeUrl: string }) => void = () => {}
  let started = () => {}
  const startObserved = new Promise<void>(resolve => { started = resolve })
  const authorization = new Promise<{ status: "needs_auth"; authorizeUrl: string }>(resolve => { finish = resolve })
  let opens = 0
  const operation = authenticateChatConnection({
    connectionId: baseConnection.id, connectionName: baseConnection.name,
    isCurrent: () => isChatMcpReconnectScopeCurrent(original, current), listConnections: async () => [baseConnection],
    startConnect: () => { started(); return authorization }, openUrl: async () => { opens += 1 }, onProgress: () => {},
  })
  await startObserved
  current = { ...original, token: "account-b" }
  finish({ status: "needs_auth", authorizeUrl: "https://provider.example/authorize" })
  await expect(operation).rejects.toThrow("request or account changed")
  expect(opens).toBe(0)
})
