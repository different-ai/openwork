import { afterAll, beforeEach, describe, expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import { GlobalRegistrator } from "@happy-dom/global-registrator"
import { act, type ReactNode } from "react"
import { createRoot } from "react-dom/client"
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
  const html = renderToStaticMarkup(<ConnectionCard part={part} reconnectScope={request.owner}
    reconnectCallbacks={{ decision: { request, isPending: () => true, respond: async () => {} }, onReconnect: async () => { authentications += 1; return "connected" } }} />)
  expect(html).toContain("Connect Research Vault")
  expect(html).toContain(">Skip</button>")
  expect(html).toContain(">Authenticate</button>")
  expect(html.match(/<p /g)?.length).toBe(1)
  for (const text of ["Turn stopped", "Nothing retried", "Draft retry", "Change instruction", "bg-muted/40"]) expect(html).not.toContain(text)
  expect(authentications).toBe(0)
})

test("admin setup names owner and action without OAuth", () => {
  const html = renderToStaticMarkup(<ConnectionCard part={{ ...part, output: { ...payload, actor: "provider_admin", action: { type: "fix_provider", surface: "provider_admin_console", label: "Enable the integration" } } }} />)
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
    <ConnectionCard part={part} />
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

/**
 * Every visual state of the native card, driven by the reconnect store the
 * way the OAuth flow drives it. DESIGN rules: one state-first line, at most
 * two verb labels, neutral blocked states, the raw failure behind an
 * icon-only disclosure, and no ad hoc colors.
 */
describe("connection card states", () => {
  const registered = typeof document === "undefined"
  if (registered) GlobalRegistrator.register()
  afterAll(async () => { if (registered) await GlobalRegistrator.unregister() })

  const stripe = {
    connectionId: "emc_01kxh1ns3cesjax0x2zz6ekvxm", connectionName: "Stripe",
  }
  const stripePayload = {
    version: 1, kind: "connection_action", source: "openwork-cloud", layer: "downstream_provider",
    ...stripe, authType: "oauth", credentialMode: "per_member",
    state: "needs_connection", errorCode: "not_connected", message: "You haven't connected your Stripe account yet.", actor: "member",
    action: { type: "connect", label: "Connect Stripe", surface: "openwork_your_connections", retry: "search_capabilities", url: "https://app.openworklabs.com/x" },
  }
  const stripePart: DynamicToolUIPart = {
    type: "dynamic-tool", toolName: "openwork-cloud_execute_capability", toolCallId: "call_stripe_status",
    state: "output-available", input: { name: "mcp:emc_01kxh1ns3cesjax0x2zz6ekvxm:*" }, output: stripePayload,
  }
  const owner = "account/session"
  const stripeRequest = { requestId: "que_stripe", owner, sessionId: "session-1", turnId: "user-1", toolCallId: stripePart.toolCallId, connectionId: stripe.connectionId }
  const stripeKey = chatMcpReconnectKey(stripePart.toolCallId, stripe.connectionId, owner)
  const pendingDecision: ChatConnectionDecisionBinding = { request: stripeRequest, isPending: () => true, respond: async () => {} }

  function card(decision: ChatConnectionDecisionBinding | null = pendingDecision, part: DynamicToolUIPart = stripePart) {
    return <ConnectionCard part={part} reconnectScope={owner} reconnectCallbacks={{ decision, onReconnect: async () => "connected", onReopenAuthorization: async () => {} }} />
  }

  async function mount(element: ReactNode) {
    Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true })
    const container = document.body.appendChild(document.createElement("div"))
    const root = createRoot(container)
    await act(async () => root.render(element))
    const buttons = () => [...container.querySelectorAll("button")]
    const button = (text: string) => {
      const match = buttons().find(candidate => candidate.textContent === text)
      if (!match) throw new Error(`Missing ${text} button among ${JSON.stringify(buttons().map(candidate => candidate.textContent))}`)
      return match
    }
    return {
      container, buttons, button,
      card: () => container.querySelector<HTMLElement>('[data-testid="desktop-connection-card"]'),
      line: () => container.querySelector<HTMLElement>('[role="status"], [role="alert"]'),
      rerender: (next: ReactNode) => act(async () => root.render(next)),
      dispose: () => act(async () => { root.unmount(); container.remove() }),
    }
  }

  function expectQuietPalette(html: string) {
    expect(html).not.toContain("text-destructive")
    expect(html).not.toContain("bg-destructive")
    expect(html).not.toMatch(/(?:text|bg|border)-red-/)
    expect(html).not.toMatch(/#[0-9a-fA-F]{3,8}\b/)
  }

  test("ready: one decision line with Skip and Authenticate", async () => {
    const view = await mount(card())
    try {
      expect(view.card()?.getAttribute("aria-label")).toBe("Stripe connection")
      expect(view.line()?.getAttribute("role")).toBe("status")
      expect(view.line()?.textContent).toBe("Connect Stripe to continue")
      expect(view.buttons().map(button => button.textContent)).toEqual(["Skip", "Authenticate"])
      expect(view.buttons().every(button => !button.disabled)).toBe(true)
      expect(view.container.querySelectorAll("p")).toHaveLength(1)
      expect(view.container.textContent).not.toContain("You haven't connected")
      expectQuietPalette(view.container.innerHTML)
    } finally { await view.dispose() }
  })

  test("ready without a pending question keeps the plain Connect verb", async () => {
    const view = await mount(card(null))
    try {
      expect(view.line()?.textContent).toBe("Connect Stripe")
      expect(view.buttons().map(button => button.textContent)).toEqual(["Connect"])
      expect(view.container.textContent).not.toContain("Authenticate")
    } finally { await view.dispose() }
  })

  test("opening: the primary button spins and is disabled while Skip stays available", async () => {
    useChatMcpReconnectStore.getState().setRecord(stripeKey, { phase: "opening", error: null, authorizeUrl: null })
    const view = await mount(card())
    try {
      expect(view.line()?.textContent).toBe("Signing in to Stripe…")
      const authenticate = view.button("Authenticate")
      expect(authenticate.disabled).toBe(true)
      expect(authenticate.querySelector("svg.animate-spin")).not.toBeNull()
      expect(view.button("Skip").disabled).toBe(false)
      expect(view.buttons()).toHaveLength(2)
      expect(view.container.textContent).not.toContain("Opening…")
      expectQuietPalette(view.container.innerHTML)
    } finally { await view.dispose() }
  })

  test("authorization_opened: names the browser hand-off and offers to reopen sign-in", async () => {
    useChatMcpReconnectStore.getState().setRecord(stripeKey, { phase: "authorization_opened", error: null, authorizeUrl: "https://provider.example/authorize" })
    const view = await mount(card())
    try {
      expect(view.line()?.textContent).toBe("Finish signing in to Stripe in your browser")
      expect(view.line()?.querySelector("svg.animate-spin")).not.toBeNull()
      expect(view.buttons().map(button => button.textContent)).toEqual(["Skip", "Open sign-in again"])
      expect(view.button("Open sign-in again").disabled).toBe(false)
      expect(view.container.textContent).not.toContain("provider.example")
      expectQuietPalette(view.container.innerHTML)
    } finally { await view.dispose() }
  })

  test("connected: check mark, Continue only while the native question is pending", async () => {
    useChatMcpReconnectStore.getState().setRecord(stripeKey, { phase: "connected", error: null, authorizeUrl: null })
    const view = await mount(card())
    try {
      expect(view.line()?.textContent).toBe("Stripe connected")
      expect(view.line()?.querySelector("svg.lucide-check")).not.toBeNull()
      expect(view.line()?.querySelector("svg.animate-spin")).toBeNull()
      expect(view.buttons().map(button => button.textContent)).toEqual(["Continue"])
      await view.rerender(card({ ...pendingDecision, isPending: () => false }))
      expect(view.buttons()).toHaveLength(0)
      await view.rerender(card(null))
      expect(view.line()?.textContent).toBe("Stripe connected")
      expect(view.buttons()).toHaveLength(0)
      expectQuietPalette(view.container.innerHTML)
    } finally { await view.dispose() }
  })

  test("connected from the tool result itself needs no store record", async () => {
    const connectedPart: DynamicToolUIPart = { ...stripePart, output: { connectionStatus: {
      schemaVersion: "1", ...stripe, state: "connected", actor: null, message: "Connected", action: null,
    } } }
    const view = await mount(card(null, connectedPart))
    try {
      expect(view.line()?.textContent).toBe("Stripe connected")
      expect(view.buttons()).toHaveLength(0)
    } finally { await view.dispose() }
  })

  test("skipped: settled line with Continue only for a pending question", async () => {
    useChatMcpReconnectStore.getState().setRecord(stripeKey, { phase: "skipped", error: null, authorizeUrl: null })
    const view = await mount(card())
    try {
      expect(view.line()?.textContent).toBe("Skipped Stripe")
      expect(view.line()?.querySelector("svg")).toBeNull()
      expect(view.buttons().map(button => button.textContent)).toEqual(["Continue"])
      await view.rerender(card(null))
      expect(view.buttons()).toHaveLength(0)
      expectQuietPalette(view.container.innerHTML)
    } finally { await view.dispose() }
  })

  test("failed: plain-language line, Try again, and the raw error only behind Technical details", async () => {
    const rawError = "OAuth callback returned invalid_grant (state mismatch)"
    useChatMcpReconnectStore.getState().setRecord(stripeKey, { phase: "failed", error: rawError, authorizeUrl: null })
    const view = await mount(card())
    try {
      expect(view.line()?.getAttribute("role")).toBe("alert")
      expect(view.line()?.textContent).toBe("Stripe sign-in didn't finish")
      expect(view.container.textContent).not.toContain(rawError)
      expect(view.container.textContent).not.toContain("invalid_grant")
      expect(view.buttons().map(button => button.textContent)).toEqual(["", "Skip", "Try again"])
      const details = view.buttons()[0]
      expect(details.getAttribute("aria-label")).toBe("Technical details for Stripe")
      expect(details.getAttribute("aria-expanded")).toBe("false")
      expect(details.querySelector("svg.lucide-braces")).not.toBeNull()
      expect(view.button("Try again").disabled).toBe(false)
      expectQuietPalette(view.container.innerHTML)
      await act(async () => details.click())
      expect(details.getAttribute("aria-expanded")).toBe("true")
      expect(view.container.textContent).toContain(rawError)
      expect(view.container.querySelector("pre")?.textContent).toBe(rawError)
      await act(async () => details.click())
      expect(details.getAttribute("aria-expanded")).toBe("false")
      expect(view.container.querySelector('[data-slot="collapsible-content"]')?.hasAttribute("data-closed")).toBe(true)
    } finally { await view.dispose() }
  })

  test("blocked by an admin: neutral lock line with Dismiss and no OAuth controls", async () => {
    const adminPart: DynamicToolUIPart = {
      ...stripePart,
      output: { ...stripePayload, authType: "apikey", credentialMode: "shared", actor: "organization_admin",
        action: { type: "update_credentials", label: "Rotate the key", surface: "openwork_organization_connections", retry: "search_capabilities" } },
    }
    const view = await mount(card(null, adminPart))
    try {
      expect(view.line()?.getAttribute("role")).toBe("status")
      expect(view.line()?.textContent).toBe("Your organization admin must update credentials for Stripe")
      expect(view.line()?.querySelector("svg.lucide-lock")).not.toBeNull()
      expect(view.buttons().map(button => button.textContent)).toEqual(["Dismiss"])
      expect(view.container.textContent).not.toContain("Rotate the key")
      expect(view.container.textContent).not.toContain("Authenticate")
      expectQuietPalette(view.container.innerHTML)
      await act(async () => view.button("Dismiss").click())
      expect(view.line()?.textContent).toBe("Skipped Stripe")
      expect(view.buttons()).toHaveLength(0)
    } finally { await view.dispose() }
  })

  test("read-only history renders every state without controls", async () => {
    const readOnly = (children: ReactNode) => (
      <MessageListProvider workspaceId="workspace-1" sessionId="session-1" readOnly uiStateOwner={owner}
        showThinking={false} developerMode={false} displaySuggestions={false} providerConnectedCount={1}
        onRevertToUserMessage={() => {}} onForkAtMessage={() => {}} onEditUserMessage={() => {}}
        onMcpReconnect={async () => "connected"} onMcpReopenAuthorization={async () => {}}
        getConnectionDecision={() => pendingDecision}
        dispatchAction={() => {}} setPrompt={() => {}}>
        {children}
      </MessageListProvider>
    )
    for (const record of [
      null,
      { phase: "opening", error: null, authorizeUrl: null },
      { phase: "authorization_opened", error: null, authorizeUrl: "https://provider.example/authorize" },
      { phase: "failed", error: "OAuth callback returned invalid_grant", authorizeUrl: null },
      { phase: "connected", error: null, authorizeUrl: null },
      { phase: "skipped", error: null, authorizeUrl: null },
    ] as const) {
      useChatMcpReconnectStore.getState().reset()
      if (record) useChatMcpReconnectStore.getState().setRecord(stripeKey, record)
      const view = await mount(readOnly(<ConnectionCard part={stripePart} />))
      try {
        expect(view.card()).not.toBeNull()
        expect(view.buttons()).toHaveLength(0)
        expect(view.container.textContent).not.toContain("invalid_grant")
        expectQuietPalette(view.container.innerHTML)
      } finally { await view.dispose() }
    }
  })
})
