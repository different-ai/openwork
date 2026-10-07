import { afterAll, afterEach, expect, setSystemTime, test } from "bun:test"
import { GlobalRegistrator } from "@happy-dom/global-registrator"
import { act, createElement } from "react"
import { createRoot, type Root } from "react-dom/client"
import type { UIMessage } from "ai"

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
const { useSessionActivityStore } = await import("../src/react-app/domains/session/status/session-activity-store")
const { NO_NEW_ACTIVITY_AFTER_MS } = await import("../src/react-app/domains/session/status/session-progress")

const workspaceId = "workspace_fixture"
const sessionId = "session_fixture"
let mounted: { root: Root; container: HTMLElement } | null = null

afterEach(async () => {
  setSystemTime()
  if (mounted) {
    const { root, container } = mounted
    await act(async () => root.unmount())
    container.remove()
    mounted = null
  }
  useSessionActivityStore.getState().removeSession(workspaceId, sessionId)
})

/** A busy run that began `silentForMs` ago and has produced no text, reasoning or tool step since. */
async function renderBusyRun(silentForMs: number, options: { syncDegraded?: boolean } = {}) {
  const startedAt = Date.now() - silentForMs
  setSystemTime(new Date(startedAt))
  useSessionActivityStore.getState().setRunStatus(workspaceId, sessionId, { type: "busy" })
  setSystemTime()

  const messages: UIMessage[] = [{
    id: "msg_user",
    role: "user",
    parts: [{ type: "text", text: "Why did you not move them?" }],
    metadata: { opencode: { created: startedAt } },
  }]
  const container = document.createElement("div")
  document.body.append(container)
  const root = createRoot(container)
  mounted = { root, container }
  await act(async () => root.render(createElement(PlatformProvider, {
    value: createDefaultPlatform(),
    children: createElement(MessageListProvider, {
      workspaceId, sessionId,
      showThinking: false, developerMode: false, displaySuggestions: false, providerConnectedCount: 0,
      dispatchAction: () => {}, setPrompt: () => {}, onRevertToUserMessage: () => {},
      onForkAtMessage: () => {}, onEditUserMessage: () => {},
      onMcpReconnect: async () => { throw new Error("Unexpected reconnect") },
      onMcpReopenAuthorization: async () => {},
      children: createElement(MessageList, {
        messages,
        status: "streaming",
        activityStatus: "thinking",
        syncHealth: { degraded: options.syncDegraded === true, lastConfirmedAt: startedAt },
      }),
    }),
  })))
  return {
    working: container.querySelector('[data-loading-message="working"]')?.textContent ?? null,
    reconnecting: container.querySelector('[data-loading-message="reconnecting"]') !== null,
  }
}

test("the Working line shows while a busy run has not answered yet", async () => {
  expect((await renderBusyRun(5_000)).working).toMatch(/^Working \ds$/)
})

test("the Working line stays when a busy run is silent for over a minute", async () => {
  // A slow first token on a long conversation, or a quiet tool, is still a busy run.
  const { working } = await renderBusyRun(NO_NEW_ACTIVITY_AFTER_MS + 60_000)
  expect(working).toMatch(/^Working 2m \ds$/)
})

test("Reconnecting replaces the Working line when the run can no longer be confirmed", async () => {
  const { working, reconnecting } = await renderBusyRun(NO_NEW_ACTIVITY_AFTER_MS + 60_000, { syncDegraded: true })
  expect(working).toBeNull()
  expect(reconnecting).toBe(true)
})
