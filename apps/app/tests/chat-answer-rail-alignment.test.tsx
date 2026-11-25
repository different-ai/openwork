import { afterAll, afterEach, expect, test } from "bun:test"
import { GlobalRegistrator } from "@happy-dom/global-registrator"
import { act, createElement } from "react"
import { createRoot, type Root } from "react-dom/client"
import type { DynamicToolUIPart, UIMessage } from "ai"
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

async function render(messages: UIMessage[], streaming = false, modelOptions?: readonly ModelOption[], activityStatus?: string) {
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
      children: createElement(MessageList, {
        messages,
        status: streaming ? "streaming" : "ready",
        activityStatus: (activityStatus ?? (streaming ? "responding" : "idle")) as never,
      }),
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

/** A script that started but has no visible calls yet — its lane must be a spinner, not a generic dot. */
function runningScript(toolCallId: string): UIMessage {
  const scriptPart: DynamicToolUIPart = {
    type: "dynamic-tool",
    toolName: "tools",
    toolCallId,
    state: "input-streaming",
    input: { prompt: "Summarize the changes and post them" },
    callProviderMetadata: { openwork: { codeMode: { calls: [] } } },
  }
  return {
    id: "reply_script",
    role: "assistant",
    parts: [scriptPart],
    metadata: { opencode: { created: 1000 } },
  }
}

test("a running script with no visible calls shows a spinner in the lane, not a generic dot", async () => {
  const container = await render(
    [{ id: "user_script", role: "user", parts: [{ type: "text", text: "Run a script." }], metadata: { opencode: { created: 900 } } }, runningScript("call_script")],
    true,
    undefined,
    "responding",
  )
  // The empty-group row's label is the script summary ("Running a script").
  expect(container.textContent).toContain("Running a script")
  // The lane holds a spinner (LoaderCircle svg with animate-spin), never the
  // generic solid-dot fallback (size-1 rounded-full bg-muted-foreground) that
  // read as a bullet beside the run (DESIGN.md T1).
  expect(container.querySelector('[data-code-mode-call] .animate-spin')).not.toBeNull()
  expect(container.querySelector('[data-code-mode-call] .size-1.rounded-full.bg-muted-foreground')).toBeNull()
})

/** A capability call in flight with no connector mark — its lane must be a spinner, not a generic dot. */
function runningGenericCall(toolCallId: string): UIMessage {
  const callPart: DynamicToolUIPart = {
    type: "dynamic-tool",
    toolName: "acme-api_get_data",
    toolCallId,
    state: "input-streaming",
    input: { path: "/data" },
  }
  return {
    id: "reply_call",
    role: "assistant",
    parts: [callPart],
    metadata: { opencode: { created: 1000 } },
  }
}

test("an in-flight capability call with no connector shows a spinner in the lane, not a generic dot", async () => {
  const container = await render(
    [{ id: "user_call", role: "user", parts: [{ type: "text", text: "Fetch the data." }], metadata: { opencode: { created: 900 } } }, runningGenericCall("call_data")],
    true,
    undefined,
    "responding",
  )
  // The lane holds a spinner (LoaderCircle svg with animate-spin), never the
  // generic solid-dot fallback (size-1 rounded-full bg-muted-foreground) that
  // read as a bullet, whether the text shimmers or not (DESIGN.md T1).
  expect(container.querySelector('[data-capability-call] .animate-spin')).not.toBeNull()
  expect(container.querySelector('[data-capability-call] .size-1.rounded-full.bg-muted-foreground')).toBeNull()
})