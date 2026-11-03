import { afterAll, afterEach, expect, mock, test } from "bun:test"
import { GlobalRegistrator } from "@happy-dom/global-registrator"
import { act, createElement } from "react"
import { createRoot, type Root } from "react-dom/client"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"

GlobalRegistrator.register({ url: "https://web.example/" })
// This notice fixture does not mount the signed-in app or its artifact surface.
mock.module("../src/react-app/domains/session/status/use-desktop-feature", () => ({ useDesktopFeature: () => false }))
const previousAct = Reflect.get(globalThis, "IS_REACT_ACT_ENVIRONMENT")
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true)
const originalFetch = globalThis.fetch
let mounted: { root: Root; container: HTMLElement } | null = null
afterEach(async () => {
  globalThis.fetch = originalFetch
  if (mounted) {
    const { root, container } = mounted
    await act(async () => root.unmount())
    container.remove()
    mounted = null
  }
})
afterAll(() => {
  queryClient.clear()
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", previousAct)
  GlobalRegistrator.unregister()
})

const { createClientV2, createV2EventTranslationState, translateV2Event } = await import("../src/app/lib/opencode-v2-adapter")
const { readSubagentCompletion, subagentNoticeLabel } = await import("../src/app/lib/subagent-notices")
const { snapshotToUIMessages } = await import("../src/react-app/domains/session/sync/usechat-adapter")
const { subagentNoticeFromMessage } = await import("../src/components/chat/background-tasks")
const { PlatformProvider, createDefaultPlatform } = await import("../src/react-app/kernel/platform")
const { MessageListProvider } = await import("../src/components/chat/message-list-provider")
const { DenAuthProvider } = await import("../src/react-app/domains/cloud/den-auth-provider")
const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } })
const { MessageList } = await import("../src/components/chat/message-list")

const SESSION = "ses_parent"
const CHILD = "ses_child"
const location = { directory: "/tmp/subagents" }

/** The engine's synthetic message for a background sub-agent that ended, as v2 stores and enqueues it. */
function engineNotice(state: string) {
  return {
    metadata: { source: "subagent", childID: CHILD, agent: "general", state },
    text: `<subagent sessionID="${CHILD}" state="${state}" description="Sort the photos">\nSorted 40 photos.\n</subagent>`,
    description: "Sort the photos",
  }
}

test("a sub-agent that ends while the chat is open shows one plain row, never the raw <subagent> text", () => {
  const events = translateV2Event({
    type: "session.inbox.enqueued", created: 10, location,
    data: { sessionID: SESSION, inboxID: "msg_notice", item: { type: "synthetic", payload: engineNotice("completed") } },
  }, createV2EventTranslationState()) ?? []
  expect(events.map((event) => event.type)).toEqual(["message.updated", "message.part.updated"])
  expect(events[0]?.properties).toMatchObject({ info: { id: "msg_notice", role: "system", sessionID: SESSION } })
  expect(events[1]?.properties).toMatchObject({ part: {
    type: "text", text: "Sub-agent finished",
    metadata: { openworkSubagentNotice: { childSessionId: CHILD, description: "Sort the photos", outcome: "finished" } },
  } })
  expect(JSON.stringify(events)).not.toContain("<subagent")
})

test("the row stays in the chat after reopening it", async () => {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init)
    if (new URL(request.url).pathname.endsWith(`/api/session/${SESSION}/message`)) {
      return Response.json({ location, data: [{ id: "msg_notice", sessionID: SESSION, type: "synthetic", time: { created: 10 }, ...engineNotice("error") }] })
    }
    return Response.json({ location, data: [] })
  }) as typeof fetch
  const client = createClientV2("http://127.0.0.1:9/workspace/ws_1/opencode2", "/tmp/subagents", { token: "t" })
  const history = await client.session.messages({ sessionID: SESSION })
  expect(history.error).toBeUndefined()
  const [message] = snapshotToUIMessages({ messages: history.data ?? [] })
  expect(message?.role).toBe("system")
  expect(subagentNoticeFromMessage(message!)).toEqual({ childSessionId: CHILD, description: "Sort the photos", outcome: "failed" })
  expect(JSON.stringify(message)).not.toContain("<subagent")
})

test("rows say how the sub-agent ended, and other synthetic messages are not sub-agent rows", () => {
  expect(subagentNoticeLabel({ outcome: "finished" })).toBe("Sub-agent finished")
  expect(subagentNoticeLabel({ outcome: "failed" })).toBe("Sub-agent failed")
  expect(subagentNoticeLabel({ outcome: "stopped" })).toBe("Sub-agent stopped")
  expect(readSubagentCompletion(engineNotice("cancelled"))?.outcome).toBe("stopped")
  expect(readSubagentCompletion(engineNotice("running"))).toBeNull()
  expect(readSubagentCompletion({ metadata: { source: "shell", shellID: "sh_1", state: "completed" } })).toBeNull()
  expect(readSubagentCompletion({ metadata: { headlessTurn: true }, text: "continue" })).toBeNull()
})

test("the row opens the sub-agent's chat", async () => {
  const opened: string[] = []
  const container = document.createElement("div")
  document.body.append(container)
  const root = createRoot(container)
  mounted = { root, container }
  const notice = { id: "msg_notice", role: "system" as const, parts: [{
    type: "text" as const, text: "Sub-agent finished", state: "done" as const,
    providerMetadata: { opencode: { subagentNotice: { childSessionId: CHILD, description: "Sort the photos", outcome: "finished" } } },
  }] }
  await act(async () => root.render(createElement(QueryClientProvider, { client: queryClient,
    children: createElement(DenAuthProvider, { children: createElement(PlatformProvider, {
    value: createDefaultPlatform(),
    children: createElement(MessageListProvider, {
      workspaceId: "workspace_fixture", sessionId: SESSION,
      showThinking: false, developerMode: false, displaySuggestions: false, providerConnectedCount: 0,
      dispatchAction: () => {}, setPrompt: () => {}, onRevertToUserMessage: () => {},
      onForkAtMessage: () => {}, onEditUserMessage: () => {},
      onMcpReconnect: async () => { throw new Error("Unexpected reconnect") },
      onMcpReopenAuthorization: async () => {},
      onOpenSubagentSession: (sessionId: string) => opened.push(sessionId),
      children: createElement(MessageList, { messages: [notice], status: "ready", activityStatus: "idle" }),
    }),
  }) }), })))
  const row = container.querySelector<HTMLButtonElement>('button[data-subagent-notice="finished"]')
  expect(row?.textContent).toBe("Sub-agent finishedSort the photos")
  await act(async () => row?.click())
  expect(opened).toEqual([CHILD])
})
