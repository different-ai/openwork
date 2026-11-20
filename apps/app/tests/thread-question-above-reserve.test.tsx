import { afterAll, afterEach, expect, test } from "bun:test"
import { GlobalRegistrator } from "@happy-dom/global-registrator"
import { act, createElement } from "react"
import { createRoot, type Root } from "react-dom/client"
import type { UIMessage } from "ai"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"

GlobalRegistrator.register({ url: "https://web.example/" })
const previousAct = Reflect.get(globalThis, "IS_REACT_ACT_ENVIRONMENT")
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true)
const { PlatformProvider, createDefaultPlatform } = await import("../src/react-app/kernel/platform")
const { MessageListProvider } = await import("../src/components/chat/message-list-provider")
const { DenAuthProvider } = await import("../src/react-app/domains/cloud/den-auth-provider")
const { MessageList } = await import("../src/components/chat/message-list")
const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } })
let mounted: { root: Root; container: HTMLElement } | null = null

afterEach(async () => {
  if (!mounted) return
  const { root, container } = mounted
  await act(async () => root.unmount())
  container.remove()
  mounted = null
})
afterAll(() => {
  queryClient.clear()
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", previousAct)
  GlobalRegistrator.unregister()
})

const messages: UIMessage[] = [
  { id: "user_ask", role: "user", parts: [{ type: "text", text: "Check Bedrock on the Mac Studio." }], metadata: { opencode: { created: 900 } } },
  { id: "reply", role: "assistant", parts: [{ type: "text", text: "Open the sign-in link below and approve code HMXP-JFRM." }], metadata: { opencode: { created: 1000 } } },
]

// A question that stops the turn keeps it running, and a running turn holds
// the room its folded steps gave up at the end of the list. The card has to
// come before that room, or it lands below a screen of blank space.
test("a question card in the conversation sits above the room a running turn holds", async () => {
  const container = document.createElement("div")
  document.body.append(container)
  const root = createRoot(container)
  mounted = { root, container }
  await act(async () => root.render(createElement(QueryClientProvider, { client: queryClient,
    children: createElement(DenAuthProvider, { children: createElement(PlatformProvider, {
    value: createDefaultPlatform(),
    children: createElement(MessageListProvider, {
      workspaceId: "workspace_fixture", sessionId: "session_fixture",
      showThinking: true, developerMode: false, displaySuggestions: false, providerConnectedCount: 0,
      dispatchAction: () => {}, setPrompt: () => {}, onRevertToUserMessage: () => {},
      onForkAtMessage: () => {}, onEditUserMessage: () => {},
      onMcpReconnect: async () => {}, onMcpReopenAuthorization: async () => {},
      children: createElement(MessageList, {
        messages, status: "streaming", activityStatus: "responding" as never,
        trailing: createElement("div", { "data-question-variant": "thread" }, "Needs your input"),
      }),
    }),
  }) }) })))

  const card = container.querySelector('[data-question-variant="thread"]')
  const reserve = container.querySelector("[data-live-turn-reserve]")
  expect(card).not.toBeNull()
  expect(reserve).not.toBeNull()
  expect(card?.parentElement).toBe(reserve?.parentElement ?? null)
  expect(card?.nextElementSibling).toBe(reserve)
})
