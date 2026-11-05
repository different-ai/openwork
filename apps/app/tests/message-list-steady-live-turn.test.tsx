import { afterAll, afterEach, expect, spyOn, test } from "bun:test"
import { GlobalRegistrator } from "@happy-dom/global-registrator"
import { act, createElement } from "react"
import { createRoot, type Root } from "react-dom/client"
import type { UIMessage } from "ai"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"

GlobalRegistrator.register({ url: "https://web.example/" })
const previousAct = Reflect.get(globalThis, "IS_REACT_ACT_ENVIRONMENT")
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true)
afterAll(() => {
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", previousAct)
  GlobalRegistrator.unregister()
})

const { PlatformProvider, createDefaultPlatform } = await import("../src/react-app/kernel/platform")
const { MessageListProvider } = await import("../src/components/chat/message-list-provider")
const { MessageList } = await import("../src/components/chat/message-list")
const { DenAuthProvider } = await import("../src/react-app/domains/cloud/den-auth-provider")
const { useSteadyLiveTurnStore } = await import("../src/components/chat/steady-live-turn-store")
const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } })

let mounted: { root: Root; container: HTMLElement } | null = null

afterEach(async () => {
  if (mounted) {
    const { root, container } = mounted
    await act(async () => root.unmount())
    container.remove()
    mounted = null
  }
  useSteadyLiveTurnStore.getState().setEnabled(false)
})

const answer = "I found the thread and will check available times."

/** One OpenCode turn: steps, a short message, then more steps, still running. */
const messages: UIMessage[] = [{
  id: "msg_user",
  role: "user",
  parts: [{ type: "text", text: "Send them a booking link." }],
  metadata: { opencode: { created: 1 } },
}, {
  id: "msg_turn",
  role: "assistant",
  parts: [
    { type: "dynamic-tool", toolName: "bash", toolCallId: "call_before", state: "output-available", input: { command: "ls threads" }, output: "thread.txt" },
    { type: "text", text: answer },
    { type: "dynamic-tool", toolName: "bash", toolCallId: "call_after", state: "input-available", input: { command: "cat calendar" } },
  ],
  metadata: { opencode: { created: 2 } },
}]

async function renderLiveTurn(steady: boolean, status: "streaming" | "ready" = "streaming") {
  useSteadyLiveTurnStore.getState().setEnabled(steady)
  const container = document.createElement("div")
  document.body.append(container)
  const root = createRoot(container)
  mounted = { root, container }
  await act(async () => root.render(createElement(QueryClientProvider, { client: queryClient,
    children: createElement(DenAuthProvider, { children: createElement(PlatformProvider, {
      value: createDefaultPlatform(),
      children: createElement(MessageListProvider, {
        workspaceId: "workspace_fixture", sessionId: "session_fixture",
        showThinking: false, developerMode: false, displaySuggestions: false, providerConnectedCount: 0,
        dispatchAction: () => {}, setPrompt: () => {}, onRevertToUserMessage: () => {},
        onForkAtMessage: () => {}, onEditUserMessage: () => {},
        onMcpReconnect: async () => { throw new Error("Unexpected reconnect") },
        onMcpReopenAuthorization: async () => {},
        children: createElement(MessageList, { messages, status, activityStatus: status === "streaming" ? "responding" : "idle" }),
      }),
    }) }) })))
  return container
}

test("off: a running turn splits at its latest text without holding a blank steps panel open", async () => {
  // A tall live tool detail can disappear when the tool settles or the latest
  // answer moves. Simulate real layout: happy-dom does not measure content.
  const measure = spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    return new DOMRect(0, 0, 600, this.hasAttribute("data-live-steps") ? 900 : 0)
  })
  try {
    const container = await renderLiveTurn(false)
    const steps = container.querySelector<HTMLElement>("[data-live-steps]")
    expect(steps).not.toBeNull()
    expect(steps?.style.minHeight).toBe("")
    expect(container.querySelector("[data-live-turn-reserve]")).toBeNull()
    // Toggling the rollout must not leave a reserved height on the off path.
    await act(async () => useSteadyLiveTurnStore.getState().setEnabled(true))
    await act(async () => useSteadyLiveTurnStore.getState().setEnabled(false))
    expect(container.querySelector<HTMLElement>("[data-live-steps]")?.style.minHeight).toBe("")
  } finally {
    measure.mockRestore()
  }
})

test("on: a running turn keeps its parts in arrival order, with no steps area to hold open", async () => {
  const container = await renderLiveTurn(true)
  // Nothing moves between a steps area and the answer while the turn runs.
  expect(container.querySelector("[data-live-steps]")).toBeNull()
  expect(container.textContent).toContain(answer)
  // The room a shrinking turn gives up is kept at the end of the list, after the Working line.
  const reserve = container.querySelector("[data-live-turn-reserve]")
  const working = container.querySelector('[data-loading-message="working"]')
  expect(reserve).not.toBeNull()
  expect(working).not.toBeNull()
  expect(reserve?.previousElementSibling?.contains(working ?? null) || reserve?.previousElementSibling === working).toBe(true)
})

test("on: a finished turn splits its steps from the answer as before", async () => {
  const container = await renderLiveTurn(true, "ready")
  expect(container.textContent).toContain(answer)
  expect(container.querySelector("[data-live-turn-reserve]")?.getAttribute("style") ?? "").not.toContain("height")
})
