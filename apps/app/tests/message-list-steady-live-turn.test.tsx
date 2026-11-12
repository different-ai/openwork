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

function liveTurnView(status: "streaming" | "ready", content: UIMessage[] = messages) {
  return createElement(QueryClientProvider, { client: queryClient,
    children: createElement(DenAuthProvider, { children: createElement(PlatformProvider, {
      value: createDefaultPlatform(),
      children: createElement(MessageListProvider, {
        workspaceId: "workspace_fixture", sessionId: "session_fixture",
        showThinking: false, developerMode: false, displaySuggestions: false, providerConnectedCount: 0,
        dispatchAction: () => {}, setPrompt: () => {}, onRevertToUserMessage: () => {},
        onForkAtMessage: () => {}, onEditUserMessage: () => {},
        onMcpReconnect: async () => { throw new Error("Unexpected reconnect") },
        onMcpReopenAuthorization: async () => {},
        children: createElement(MessageList, { messages: content, status, activityStatus: status === "streaming" ? "responding" : "idle" }),
      }),
    }) }) })
}

async function renderLiveTurn(steady: boolean, status: "streaming" | "ready" = "streaming") {
  useSteadyLiveTurnStore.getState().setEnabled(steady)
  const container = document.createElement("div")
  document.body.append(container)
  const root = createRoot(container)
  mounted = { root, container }
  await act(async () => root.render(liveTurnView(status)))
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

test("off: settling a tool and advancing the answer releases its old height before the turn ends", async () => {
  let height = 900
  const measure = spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    return new DOMRect(0, 0, 600, this.hasAttribute("data-live-steps") ? height : 0)
  })
  try {
    const container = await renderLiveTurn(false)
    const root = mounted?.root
    if (!root) throw new Error("Missing live turn root")
    // The same call settles, then the next text changes the steps/answer split.
    // Neither transition is a pointer/key event that could release a height hold.
    const next: UIMessage[] = messages.map(message => message.role !== "assistant" ? message : {
      ...message,
      parts: message.parts.map(part => part.type === "dynamic-tool" && part.toolCallId === "call_after"
        ? { ...part, state: "output-available", output: "No conflicts." } : part).concat({ type: "text", text: "Available times are ready." }),
    })
    height = 40
    await act(async () => root.render(liveTurnView("streaming", next)))
    expect(container.textContent).toContain("Available times are ready.")
    expect(container.querySelector<HTMLElement>("[data-live-steps]")?.style.minHeight).toBe("")
    expect(container.querySelector("[data-live-turn-reserve]")).toBeNull()
    await act(async () => root.render(liveTurnView("ready", next)))
    expect(container.textContent).toContain("Available times are ready.")
    expect(container.querySelector("[data-live-steps]")).toBeNull()
    expect(container.querySelector("[data-live-turn-reserve]")).toBeNull()
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

/** Lays out each group and the reserve as a real list would, and drives the reserve's ResizeObserver. */
async function measuredLiveTurn(viewHeight: number) {
  const heights: Record<string, number> = { msg_user: 50, msg_turn: 900 }
  const observed: { callback: ResizeObserverCallback; targets: Element[]; self: ResizeObserver }[] = []
  const previousObserver = globalThis.ResizeObserver
  Reflect.set(globalThis, "ResizeObserver", class {
    entry: (typeof observed)[number]
    constructor(callback: ResizeObserverCallback) { this.entry = { callback, targets: [], self: this as unknown as ResizeObserver }; observed.push(this.entry) }
    observe(target: Element) { this.entry.targets.push(target) }
    unobserve() {}
    disconnect() { this.entry.targets = [] }
  })
  const bottomOf = (list: Element | null) => {
    let top = 0
    for (const group of list?.querySelectorAll(":scope > [data-thread-group]") ?? []) top += (heights[group.getAttribute("data-thread-group") ?? ""] ?? 0) + 8
    return top
  }
  const measure = spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    if (this.hasAttribute("data-live-turn-reserve")) return new DOMRect(0, bottomOf(this.parentElement), 600, Number.parseFloat(this.style.height) || 0)
    const key = this.getAttribute("data-thread-group")
    if (!key) return new DOMRect(0, 0, 600, 0)
    let top = 0
    for (const group of this.parentElement?.querySelectorAll(":scope > [data-thread-group]") ?? []) {
      if (group === this) break
      top += (heights[group.getAttribute("data-thread-group") ?? ""] ?? 0) + 8
    }
    return new DOMRect(0, top, 600, heights[key] ?? 0)
  })
  const container = await renderLiveTurn(true)
  container.setAttribute("data-thread-scroll", "")
  Object.defineProperty(container, "clientHeight", { configurable: true, get: () => viewHeight })
  const reserve = () => container.querySelector<HTMLElement>("[data-live-turn-reserve]")
  const resize = async () => {
    await act(async () => {
      for (const entry of observed) if (entry.targets.some(target => target.contains(reserve()))) entry.callback([], entry.self)
    })
  }
  return {
    heights, container, reserve, resize,
    restore() { measure.mockRestore(); Reflect.set(globalThis, "ResizeObserver", previousObserver) },
  }
}

test("on: a message sent mid-run lands at the bottom instead of inheriting the room held for the earlier turn", async () => {
  const view = await measuredLiveTurn(2000)
  try {
    await view.resize()
    expect(view.reserve()?.style.height).toBe("")
    // A step folds while the turn runs: its room moves to the end of the list.
    view.heights.msg_turn = 100
    await view.resize()
    expect(view.reserve()?.style.height).toBe("800px")
    // The person sends a follow-up: their message is the new last group and
    // must not sit on top of the 800px held for the turn above it.
    view.heights.msg_follow = 50
    const root = mounted?.root
    if (!root) throw new Error("Missing live turn root")
    await act(async () => root.render(liveTurnView("streaming", [...messages, {
      id: "msg_follow", role: "user", parts: [{ type: "text", text: "Use next week instead." }], metadata: { opencode: { created: 3 } },
    }])))
    await view.resize()
    expect(view.container.textContent).toContain("Use next week instead.")
    expect(view.reserve()?.style.height).toBe("")
  } finally {
    view.restore()
  }
})

test("on: a turn that shrinks by more than the view holds at most half of it open", async () => {
  const view = await measuredLiveTurn(600)
  try {
    await view.resize()
    view.heights.msg_turn = 100
    await view.resize()
    // 800px of blank space would leave the screen empty; the turn's end stays in view.
    expect(view.reserve()?.style.height).toBe("300px")
  } finally {
    view.restore()
  }
})
