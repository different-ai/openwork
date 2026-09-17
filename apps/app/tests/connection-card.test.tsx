import { beforeEach, expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import type { DynamicToolUIPart } from "ai"
import { ConnectionCard } from "../src/components/chat/connection-card"
import { MessageListProvider } from "../src/components/chat/message-list-provider"
import { useChatToolReconnect } from "../src/components/tools/use-chat-tool-reconnect"
import { chatMcpReconnectKey, useChatMcpReconnectStore } from "../src/components/tools/mcp-reconnect-state"
import { authenticateChatConnection } from "../src/react-app/domains/session/surface/mcp-chat-reconnect"
import type { DenExternalMcpConnection } from "../src/app/lib/den"
import type { ChatConnectionDecisionBinding, ChatConnectionDecisionResponse } from "../src/react-app/domains/session/surface/mcp-chat-reconnect"

const payload = {
  schemaVersion: "1", connectionId: "connection-1", connectionName: "Research Vault",
  state: "needs_connection", actor: "member", message: "Sign-in required",
  action: { type: "connect", surface: "openwork_your_connections", label: "Connect your account" },
}
const part: DynamicToolUIPart = {
  type: "dynamic-tool", toolName: "openwork_execute_capability", toolCallId: "call-1",
  state: "output-available", input: {}, output: payload,
}
const request = { requestId: "request-1", owner: "owner-1", sessionId: "session-1", turnId: "turn-1", toolCallId: "call-1", connectionId: "connection-1" }
const action = { connectionId: "connection-1", connectionName: "Research Vault", label: "Connect" }

beforeEach(() => useChatMcpReconnectStore.getState().reset())

test("transcript card is flat, has one line and does not authenticate on render", () => {
  let authentications = 0
  const html = renderToStaticMarkup(<ConnectionCard part={part} action={null} connection={null} reconnectScope={request.owner}
    reconnectCallbacks={{ decision: { request, isPending: () => true, respond: async () => {} }, onReconnect: async () => { authentications += 1; return "connected" } }} />)
  expect(html).toContain("Connect Research Vault")
  expect(html).toContain(">Skip</button>")
  expect(html).toContain(">Authenticate</button>")
  expect(html.match(/<p /g)?.length).toBe(1)
  for (const text of ["Turn stopped", "Nothing retried", "Draft retry", "Change instruction", "bg-muted/40"]) expect(html).not.toContain(text)
  expect(authentications).toBe(0)
})

test("admin setup names owner and action without OAuth", () => {
  const html = renderToStaticMarkup(<ConnectionCard part={{ ...part, output: { ...payload, actor: "provider_admin", action: { type: "fix_provider", surface: "provider_admin_console", label: "Enable the integration" } } }} action={null} connection={null} />)
  expect(html).toContain("The provider admin must restore provider access for Research Vault")
  expect(html).toContain(">Dismiss</button>")
  expect(html).not.toContain(">Authenticate</button>")
  expect(html.match(/<p /g)?.length).toBe(1)
})

test("read-only history has no actions", () => {
  const html = renderToStaticMarkup(<MessageListProvider workspaceId="workspace-1" sessionId="session-1" readOnly
    showThinking={false} developerMode={false} displaySuggestions={false} providerConnectedCount={1}
    onRevertToUserMessage={() => {}} onForkAtMessage={() => {}} onEditUserMessage={() => {}}
    onMcpReconnect={async () => "connected"} onMcpReopenAuthorization={async () => {}}
    dispatchAction={() => {}} setPrompt={() => {}}>
    <ConnectionCard part={part} action={null} connection={null} />
  </MessageListProvider>)
  expect(html).not.toContain("<button")
})

test("duplicate authentication clicks continue only once after verification", async () => {
  let authenticate = async () => {}
  let finish: (value: "connected") => void = () => {}
  const pending = new Promise<"connected">(resolve => { finish = resolve })
  const responses: ChatConnectionDecisionResponse[] = []
  let authentications = 0
  const decision: ChatConnectionDecisionBinding = { request, isPending: () => true, respond: async response => { responses.push(response) } }
  function Harness() {
    const hook = useChatToolReconnect(part, { decision, onReconnect: async () => { authentications += 1; return pending } }, action, request.owner)
    authenticate = hook.handleReconnect
    return null
  }
  renderToStaticMarkup(<Harness />)
  expect(authentications).toBe(0)
  const first = authenticate()
  await authenticate()
  expect(authentications).toBe(1)
  finish("connected")
  await first
  expect(responses).toEqual([{ outcome: "connected", continuation: "review_remaining_work", repeatCompletedWrites: false }])
  renderToStaticMarkup(<Harness />)
  await authenticate()
  expect(authentications).toBe(1)
  expect(responses).toHaveLength(1)
})

test("skip persists and a late OAuth completion cannot undo it or continue twice", async () => {
  let authenticate = async () => {}
  let skip = async () => {}
  let finish: (value: "connected") => void = () => {}
  const pending = new Promise<"connected">(resolve => { finish = resolve })
  const responses: ChatConnectionDecisionResponse[] = []
  const decision: ChatConnectionDecisionBinding = { request, isPending: () => true, respond: async response => { responses.push(response) } }
  function Harness() {
    const hook = useChatToolReconnect(part, { decision, onReconnect: async () => pending }, action, request.owner)
    authenticate = hook.handleReconnect
    skip = hook.handleSkip
    return null
  }
  renderToStaticMarkup(<Harness />)
  const first = authenticate()
  await skip()
  await skip()
  finish("connected")
  await first
  expect(responses).toEqual([{ outcome: "skipped", continuation: "without_connection", alternativeAuthorization: false }])
  renderToStaticMarkup(<Harness />)
  expect(useChatMcpReconnectStore.getState().records[chatMcpReconnectKey(request.toolCallId, request.connectionId, request.owner)]?.phase).toBe("skipped")
})

test("a changed current request cannot receive authorization continuation", async () => {
  let authenticate = async () => {}
  let finish: (value: "connected") => void = () => {}
  const pending = new Promise<"connected">(resolve => { finish = resolve })
  let current = true
  const responses: ChatConnectionDecisionResponse[] = []
  const decision: ChatConnectionDecisionBinding = { request, isPending: () => current, respond: async response => { responses.push(response) } }
  function Harness() {
    authenticate = useChatToolReconnect(part, { decision, onReconnect: async () => pending }, action, request.owner).handleReconnect
    return null
  }
  renderToStaticMarkup(<Harness />)
  const first = authenticate()
  current = false
  finish("connected")
  await first
  expect(responses).toEqual([])
})

test("failed native reply retries only the answer on explicit Continue without restarting OAuth", async () => {
  let authenticate = async () => {}
  let continueReply = async () => {}
  let authentications = 0
  let replies = 0
  const decision: ChatConnectionDecisionBinding = {
    request, isPending: () => true,
    respond: async () => { replies += 1; if (replies === 1) throw new Error("Reply rejected") },
  }
  function Harness() {
    const hook = useChatToolReconnect(part, { decision, onReconnect: async () => { authentications += 1; return "connected" } }, action, request.owner)
    authenticate = hook.handleReconnect
    continueReply = hook.handleContinue
    return null
  }
  renderToStaticMarkup(<Harness />)
  await authenticate()
  const key = chatMcpReconnectKey(request.toolCallId, request.connectionId, request.owner)
  expect(useChatMcpReconnectStore.getState().records[key]?.phase).toBe("connected")
  expect(useChatMcpReconnectStore.getState().records[key]?.responseSubmitted).toBe(false)
  renderToStaticMarkup(<Harness />)
  expect(replies).toBe(1)
  await continueReply()
  expect(replies).toBe(2)
  expect(authentications).toBe(1)
  await continueReply()
  expect(replies).toBe(2)
})

test("Skip invalidates the callback predicate before inventory resolves and duplicate clicks do not start OAuth", async () => {
  let authenticate = async () => {}
  let skip = async () => {}
  let finish: (connections: DenExternalMcpConnection[]) => void = () => {}
  const inventory = new Promise<DenExternalMcpConnection[]>(resolve => { finish = resolve })
  let lists = 0
  let starts = 0
  let opens = 0
  const responses: ChatConnectionDecisionResponse[] = []
  const decision: ChatConnectionDecisionBinding = { request, isPending: () => true, respond: async response => { responses.push(response) } }
  function Harness() {
    const hook = useChatToolReconnect(part, {
      decision,
      onReconnect: (action, onProgress, isCurrent) => authenticateChatConnection({
        ...action, isCurrent: isCurrent ?? (() => false), onProgress,
        listConnections: () => { lists += 1; return inventory },
        startConnect: async () => { starts += 1; return { status: "needs_auth", authorizeUrl: "https://provider.example/authorize" } },
        openUrl: async () => { opens += 1 },
      }),
    }, action, request.owner)
    authenticate = hook.handleReconnect
    skip = hook.handleSkip
    return null
  }
  renderToStaticMarkup(<Harness />)
  const first = authenticate()
  await authenticate()
  await skip()
  finish([{ id: action.connectionId, name: action.connectionName, url: "https://provider.example/mcp", authType: "oauth", credentialMode: "per_member", exposeDirectly: false, connected: false, connectedAt: null, connectedForMe: false }])
  await first
  expect(lists).toBe(1)
  expect(starts).toBe(0)
  expect(opens).toBe(0)
  expect(responses).toEqual([{ outcome: "skipped", continuation: "without_connection", alternativeAuthorization: false }])
})
