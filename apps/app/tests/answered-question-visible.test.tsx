import { afterAll, afterEach, expect, test } from "bun:test"
import { GlobalRegistrator } from "@happy-dom/global-registrator"
import { act, createElement } from "react"
import { createRoot, type Root } from "react-dom/client"
import type { DynamicToolUIPart, UIMessage } from "ai"
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

const questions = [
  { header: "Branch", question: "Which branch?", options: [{ label: "dev", description: "" }, { label: "main", description: "" }] },
  { header: "Checks", question: "Which checks should run?", multiple: true, options: [{ label: "Typecheck", description: "" }, { label: "Unit tests", description: "" }] },
]

function question(state: "output-available" | "input-available"): DynamicToolUIPart {
  return state === "output-available"
    ? {
      type: "dynamic-tool", toolName: "question", toolCallId: "call_question", state,
      input: { questions },
      output: 'User has answered your questions: "Which branch?"="main", "Which checks should run?"="Typecheck, Unit tests". You can now continue with the user\'s answers in mind.',
      callProviderMetadata: { openwork: { questionAnswers: [["main"], ["Typecheck", "Unit tests"]] } },
    }
    : { type: "dynamic-tool", toolName: "question", toolCallId: "call_question", state, input: { questions } }
}

function turn(part: DynamicToolUIPart, completed: boolean): UIMessage[] {
  return [
    { id: "user_ask", role: "user", parts: [{ type: "text", text: "Ship the fix." }], metadata: { opencode: { created: 900 } } },
    {
      id: "reply",
      role: "assistant",
      parts: [part, { type: "text", text: "Running typecheck and unit tests on main." }],
      metadata: { opencode: { created: 1000, ...(completed ? { completed: 8000 } : {}), replyModel: { providerID: "anthropic", modelID: "claude-sonnet", name: "Claude Sonnet", resolved: true } } },
    },
  ]
}

async function render(messages: UIMessage[], streaming = false) {
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
      children: createElement(MessageList, { messages, status: streaming ? "streaming" : "ready", activityStatus: (streaming ? "responding" : "idle") as never }),
    }),
  }) }) })))
  return container
}

const occurrences = (text: string, needle: string) => text.split(needle).length - 1

test("a finished turn folds its steps but keeps the person's answers in view", async () => {
  const container = await render(turn(question("output-available"), true))
  expect(container.querySelector('[data-testid="completed-work-rail"]')?.textContent).toContain("Worked for 7s")
  const answered = container.querySelector("[data-answered-question]")
  expect(answered?.textContent).toContain("You answered")
  expect(answered?.textContent).toContain("main · Typecheck, Unit tests")
  expect(occurrences(container.textContent ?? "", "You answered")).toBe(1)
})

test("a running turn shows the answered question once, in place", async () => {
  const container = await render(turn(question("output-available"), false), true)
  expect(container.querySelector("[data-answered-question]")).toBeNull()
  expect(occurrences(container.textContent ?? "", "You answered")).toBe(1)
})
