import { afterAll, afterEach, expect, test } from "bun:test"
import { GlobalRegistrator } from "@happy-dom/global-registrator"
import { act, createElement } from "react"
import { createRoot, type Root } from "react-dom/client"
import type { Part } from "@opencode-ai/sdk/v2/client"
import type { UIMessage } from "ai"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"

GlobalRegistrator.register({ url: "https://web.example/" })
const previousAct = Reflect.get(globalThis, "IS_REACT_ACT_ENVIRONMENT")
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true)
const { DenAuthProvider } = await import("../src/react-app/domains/cloud/den-auth-provider")
const { PlatformProvider, createDefaultPlatform } = await import("../src/react-app/kernel/platform")
const { MessageListProvider } = await import("../src/components/chat/message-list-provider")
const { MessageList } = await import("../src/components/chat/message-list")
const { mapV2UserPart, v2PromptText } = await import("../src/app/lib/opencode-v2-adapter")
const { snapshotToUIMessages } = await import("../src/react-app/domains/session/sync/usechat-adapter")
const { composerPillPromptParts } = await import("../src/react-app/domains/session/surface/composer/composer-pills")
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

const meetingSkill = { kind: "connect-skill", slug: "meeting-analysis", name: "Meeting analysis", marketplace: "OpenWork", capability: "skill:meeting-analysis" } as const

/** The turn as a one-string engine stores it and the transcript reads it back from history. */
function reloadedTurn(): UIMessage {
  const text = v2PromptText([...composerPillPromptParts(meetingSkill), { type: "text", text: " today's meeting" }, { type: "agent", name: "explore" }])
  const stored: Part = { id: "prt_1", sessionID: "ses_1", messageID: "msg_1", type: "text", text }
  const [message] = snapshotToUIMessages({
    messages: [{ info: { id: "msg_1", sessionID: "ses_1", role: "user", time: { created: 1 } }, parts: mapV2UserPart(stored) }],
  } as unknown as Parameters<typeof snapshotToUIMessages>[0])
  if (!message) throw new Error("no message")
  return message
}

async function render(messages: UIMessage[], onEditUserMessage: (...args: unknown[]) => void) {
  const container = document.createElement("div")
  document.body.append(container)
  const root = createRoot(container)
  mounted = { root, container }
  await act(async () => root.render(createElement(QueryClientProvider, { client: queryClient, children: createElement(DenAuthProvider, { children: createElement(PlatformProvider, {
    value: createDefaultPlatform(),
    children: createElement(MessageListProvider, {
      workspaceId: "workspace_fixture", sessionId: "session_fixture",
      showThinking: true, developerMode: false, displaySuggestions: false, providerConnectedCount: 0,
      dispatchAction: () => {}, setPrompt: () => {}, onRevertToUserMessage: () => {},
      onForkAtMessage: () => {}, onEditUserMessage,
      onMcpReconnect: async () => {}, onMcpReopenAuthorization: async () => {},
      children: createElement(MessageList, { messages, status: "ready", activityStatus: "idle" }),
    }),
  }) }) })))
  return container
}

test("a reloaded user turn draws the composer's skill and agent chips, not slash text", async () => {
  const container = await render([reloadedTurn()], () => {})
  const bubble = container.querySelector('[data-message-role="user"]')
  const skill = bubble?.querySelector('[data-composer-badge="connect-skill"]')
  expect(skill?.textContent).toBe("Meeting analysis")
  expect(skill?.getAttribute("title")).toBe("Skill: Meeting analysis")
  expect(bubble?.querySelector('[data-composer-badge="agent"]')?.textContent).toBe("Eexplore")
  expect(bubble?.textContent).toContain("today's meeting")
  expect(bubble?.textContent).not.toContain("/meeting-analysis")
  expect(bubble?.textContent).not.toContain("openwork-cloud_get_skill")
})

test("Edit restores the chips as composer tokens and mentions", async () => {
  const calls: unknown[][] = []
  const container = await render([reloadedTurn()], (...args) => calls.push(args))
  const edit = container.querySelector('button[aria-label="Edit message"]')
  await act(async () => (edit as HTMLButtonElement).click())
  expect(calls[0]?.[0]).toBe("msg_1")
  expect(calls[0]?.[1]).toBe("[connect-skill meeting-analysis|Meeting analysis|OpenWork|skill:meeting-analysis] today's meeting@explore")
  expect(calls[0]?.[2]).toMatchObject({ mentions: { explore: "agent" } })
})
