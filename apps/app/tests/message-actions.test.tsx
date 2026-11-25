import { afterAll, afterEach, expect, test } from "bun:test"
import { GlobalRegistrator } from "@happy-dom/global-registrator"
import { act, createElement } from "react"
import { createRoot, type Root } from "react-dom/client"
import type { UIMessage } from "ai"

GlobalRegistrator.register({ url: "https://web.example/" })
const previousAct = Reflect.get(globalThis, "IS_REACT_ACT_ENVIRONMENT")
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true)
const { PlatformProvider, createDefaultPlatform } = await import("../src/react-app/kernel/platform")
const { MessageListProvider } = await import("../src/components/chat/message-list-provider")
const { MessageList } = await import("../src/components/chat/message-list")
let mounted: { root: Root; container: HTMLElement } | null = null

afterEach(async () => {
  if (!mounted) return
  const { root, container } = mounted
  await act(async () => root.unmount())
  container.remove()
  mounted = null
})
afterAll(() => {
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", previousAct)
  GlobalRegistrator.unregister()
})

const user = (id: string): UIMessage => ({ id, role: "user", parts: [{ type: "text", text: "Check the report." }], metadata: { opencode: { created: 500 } } })
const answer = (id: string): UIMessage => ({ id, role: "assistant", parts: [{ type: "text", text: "The report is ready." }], metadata: { opencode: { created: 1000, completed: 2000 } } })
// The native engine ends each turn with an empty assistant message.
const completionMarker = (id: string): UIMessage => ({ id, role: "assistant", parts: [] })

async function render(messages: UIMessage[], status: "ready" | "streaming" = "ready") {
  const container = document.createElement("div")
  document.body.append(container)
  const root = createRoot(container)
  mounted = { root, container }
  await act(async () => root.render(createElement(PlatformProvider, {
    value: createDefaultPlatform(),
    children: createElement(MessageListProvider, {
      workspaceId: "workspace_fixture", sessionId: "session_fixture",
      showThinking: true, developerMode: false, displaySuggestions: false, providerConnectedCount: 0,
      dispatchAction: () => {}, setPrompt: () => {}, onRevertToUserMessage: () => {},
      onForkAtMessage: () => {}, onEditUserMessage: () => {},
      onMcpReconnect: async () => {}, onMcpReopenAuthorization: async () => {},
      children: createElement(MessageList, { messages, status, activityStatus: status === "streaming" ? "responding" : "idle" }),
    }),
  })))
  return container
}

const buttonLabels = (scope: Element | null) =>
  [...(scope?.querySelectorAll("button") ?? [])].map(button => button.getAttribute("aria-label"))

test("a reply offers copy and branch, even when the turn ends with a completion marker", async () => {
  const container = await render([user("u1"), answer("a1"), completionMarker("m1"), user("u2"), answer("a2"), completionMarker("m2")])
  const replies = [...container.querySelectorAll('[data-testid="reply-actions"]')]
  expect(replies.length).toBe(2)
  for (const reply of replies) expect(buttonLabels(reply)).toEqual(["Copy message", "Branch in new chat"])
})

async function openMenu(target: Element | null) {
  if (!target) throw new Error("No element to right-click")
  await act(async () => {
    target.dispatchEvent(new window.MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 10, clientY: 10 }))
  })
  return [...document.querySelectorAll('[role="menuitem"]')].map(item => item.textContent?.trim())
}

test("right-clicking a reply offers copy and branch", async () => {
  const container = await render([user("u1"), answer("a1"), completionMarker("m1")])
  const reply = container.querySelector('[data-message-role="assistant"]')
  expect(await openMenu(reply)).toEqual(["Copy", "Branch in new chat"])
})

test("right-clicking a user message offers copy, edit and revert", async () => {
  const container = await render([user("u1"), answer("a1")])
  const bubble = container.querySelector('[data-message-role="user"] [data-slot="context-menu-trigger"]')
  expect(await openMenu(bubble)).toEqual(["Copy", "Edit message", "Revert"])
})

test("a streaming reply opens no empty menu", async () => {
  const container = await render([user("u1"), answer("a1")], "streaming")
  const reply = container.querySelector('[data-message-role="assistant"]')
  expect(await openMenu(reply)).toEqual([])
})

test("a user message offers copy, edit and revert", async () => {
  const container = await render([user("u1"), answer("a1")])
  const bubble = container.querySelector('[data-message-role="user"]')
  expect(buttonLabels(bubble)).toEqual(["Copy message", "Edit message", "Revert"])
})
