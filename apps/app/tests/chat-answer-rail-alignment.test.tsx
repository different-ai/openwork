import { afterAll, afterEach, expect, test } from "bun:test"
import { GlobalRegistrator } from "@happy-dom/global-registrator"
import { act, createElement } from "react"
import { createRoot, type Root } from "react-dom/client"
import type { UIMessage } from "ai"
import type { ModelOption } from "../src/app/types"

GlobalRegistrator.register({ url: "https://web.example/" })
const previousAct = Reflect.get(globalThis, "IS_REACT_ACT_ENVIRONMENT")
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true)
const { PlatformProvider, createDefaultPlatform } = await import("../src/react-app/kernel/platform")
const { MessageListProvider } = await import("../src/components/chat/message-list-provider")
const { MessageList } = await import("../src/components/chat/message-list")
const { useModelPickerCatalogStore } = await import("../src/react-app/domains/session/models/model-collections-store")
const { useAutoRouteStore } = await import("../src/react-app/domains/session/sync/auto-route-store")
let mounted: { root: Root; container: HTMLElement } | null = null

afterEach(async () => {
  if (mounted) {
    const { root, container } = mounted
    await act(async () => root.unmount())
    container.remove()
    mounted = null
  }
  useModelPickerCatalogStore.setState({ bySession: {} })
  useAutoRouteStore.setState({ bySession: {} })
})
afterAll(() => {
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", previousAct)
  GlobalRegistrator.unregister()
})

/** A finished reply: steps fold to "Worked for 7s" and the answer stays visible. */
function answer(id: string): UIMessage {
  return {
    id,
    role: "assistant",
    parts: [{ type: "text", text: "The document is ready. It lists the changes and the next step." }],
    metadata: { opencode: { created: 1000, completed: 8000, replyModel: { providerID: "anthropic", modelID: "claude-sonnet", name: "Claude Sonnet", resolved: true } } },
  }
}

async function render(messages: UIMessage[], streaming = false, modelOptions?: readonly ModelOption[]) {
  if (modelOptions) useModelPickerCatalogStore.getState().publish("session_fixture", Symbol(), modelOptions)
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
      children: createElement(MessageList, { messages, status: streaming ? "streaming" : "ready" }),
    }),
  })))
  return container
}

/** The rail's leading 20px lane holds the chevron; its text starts after it (lane + gap-2). */
function railLane(container: HTMLElement): HTMLElement | null {
  return container.querySelector<HTMLElement>('[data-testid="completed-work-rail"] span[aria-hidden="true"]')
}

/** The answer's lane: the same 20px lane, reserved so the reply's text starts where the rail's labels do. */
function answerLane(container: HTMLElement): HTMLElement | null {
  const prose = container.querySelector<HTMLElement>('[data-message-role="assistant"] .prose')
  // The prose sits in a flex row whose first child is the lane (the rail's shared alignment).
  const row = prose?.parentElement
  if (!row || !row.classList.contains("flex") || !row.classList.contains("gap-2")) return null
  return row.querySelector<HTMLElement>(":scope > span[aria-hidden='true']")
}

test("the answer aligns with the activity rail: both reserve the same leading lane", async () => {
  const container = await render([answer("reply")])

  // The completed rail still folds to one line and keeps its chevron lane.
  const rail = container.querySelector('[data-testid="completed-work-rail"]')
  expect(rail?.textContent).toContain("Worked for 7s")
  const railLaneEl = railLane(container)
  expect(railLaneEl).not.toBeNull()
  // The rail's label sits after the lane (lane + gap), not at the rail row's left edge.
  expect(rail?.querySelector("span:not([aria-hidden='true'])")?.previousElementSibling).toBe(railLaneEl)

  // The answer reserves the same lane, so its text starts where the rail's labels do —
  // not 28px to the rail's left.
  const answerLaneEl = answerLane(container)
  expect(answerLaneEl).not.toBeNull()
  expect(answerLaneEl?.className).toContain("size-5")
  expect(railLaneEl?.className).toContain("size-5")
  // Same lane width and same gap: their text columns share one left edge.
  expect(answerLaneEl?.classList.contains("shrink-0")).toBe(true)
  const proseRow = container.querySelector('[data-message-role="assistant"] .prose')?.parentElement
  expect(proseRow?.classList.contains("gap-2")).toBe(true)
})

test("the answer keeps the lane while it streams, so it does not jump left when it finishes", async () => {
  const container = await render([answer("streaming")], true)
  expect(answerLane(container)).not.toBeNull()
  // No completed rail while streaming; the lane is the answer's own, not the rail's.
  expect(container.querySelector('[data-testid="completed-work-rail"]')).toBeNull()
})