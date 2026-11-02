import { afterAll, afterEach, expect, setSystemTime, test } from "bun:test"
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
// The chat refreshes the Artifacts catalog when an artifact is built, so it mounts under the app's signed-out auth.
const { DenAuthProvider } = await import("../src/react-app/domains/cloud/den-auth-provider")
const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } })
const { useSessionActivityStore } = await import("../src/react-app/domains/session/status/session-activity-store")
const { NO_NEW_ACTIVITY_AFTER_MS } = await import("../src/react-app/domains/session/status/session-progress")

const workspaceId = "workspace_fixture"
const sessionId = "session_fixture"
const helperSessionId = "session_helper"
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
  useSessionActivityStore.getState().removeSession(workspaceId, helperSessionId)
})

type RunOptions = {
  syncDegraded?: boolean
  followUp?: { sentAgoMs: number; replyCompletedAgoMs?: number }
  /** An approval the chat or its helper asked for, and when the person answered. */
  approval?: { session: string; askedAgoMs: number; answeredAgoMs: number }
  helper?: { background: boolean }
}

/** A busy run that began `silentForMs` ago and has produced no text, reasoning or tool step since. */
async function renderBusyRun(silentForMs: number, options: RunOptions = {}) {
  const startedAt = Date.now() - silentForMs
  setSystemTime(new Date(startedAt))
  useSessionActivityStore.getState().setRunStatus(workspaceId, sessionId, { type: "busy" })
  setSystemTime()
  const { approval } = options
  if (approval) {
    const askedAt = Date.now() - approval.askedAgoMs
    const answeredAt = Date.now() - approval.answeredAgoMs
    setSystemTime(new Date(askedAt))
    useSessionActivityStore.getState().setWaitingRequest(workspaceId, approval.session, "permission", "per_fixture", true)
    setSystemTime(new Date(answeredAt))
    useSessionActivityStore.getState().setWaitingRequest(workspaceId, approval.session, "permission", "per_fixture", false)
    setSystemTime()
  }

  const messages: UIMessage[] = [{
    id: "msg_user",
    role: "user",
    parts: [{ type: "text", text: "Why did you not move them?" }],
    metadata: { opencode: { created: startedAt } },
  }]
  const { followUp } = options
  if (followUp) {
    const completed = followUp.replyCompletedAgoMs === undefined ? {} : { completed: Date.now() - followUp.replyCompletedAgoMs }
    messages.push({
      id: "msg_reply",
      role: "assistant",
      parts: [{ type: "text", text: "Moving them now." }],
      metadata: { opencode: { created: startedAt + 100, ...completed } },
    }, {
      id: "msg_follow_up",
      role: "user",
      parts: [{ type: "text", text: "Only the photos." }],
      metadata: { opencode: { created: Date.now() - followUp.sentAgoMs } },
    })
  }
  if (options.helper) {
    messages.push({
      id: "msg_delegating",
      role: "assistant",
      parts: [{
        type: "dynamic-tool",
        toolName: "task",
        toolCallId: "call_task",
        state: "input-available",
        input: { description: "Sort the photos", prompt: "Sort the photos", subagent_type: "general", background: options.helper.background },
        callProviderMetadata: { openwork: { childSessionId: helperSessionId } },
      }],
      metadata: { opencode: { created: startedAt + 100 } },
    })
  }
  const container = document.createElement("div")
  document.body.append(container)
  const root = createRoot(container)
  mounted = { root, container }
  await act(async () => root.render(createElement(QueryClientProvider, { client: queryClient,
    children: createElement(DenAuthProvider, { children: createElement(PlatformProvider, {
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
  }) }) })))
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

test("a follow-up sent mid-run keeps the run's working time", async () => {
  expect((await renderBusyRun(90_000, { followUp: { sentAgoMs: 5_000 } })).working).toMatch(/^Working 1m 3\ds$/)
})

test("a message sent after the reply finished starts its own working time", async () => {
  const { working } = await renderBusyRun(90_000, { followUp: { sentAgoMs: 5_000, replyCompletedAgoMs: 30_000 } })
  expect(working).toMatch(/^Working \ds$/)
})

test("time spent waiting for the person's approval is not working time", async () => {
  const { working } = await renderBusyRun(90_000, { approval: { session: sessionId, askedAgoMs: 80_000, answeredAgoMs: 20_000 } })
  expect(working).toMatch(/^Working 3\ds$/)
})

const helperApproval = { session: helperSessionId, askedAgoMs: 80_000, answeredAgoMs: 20_000 }

test("a helper the run waits on pauses its working time while asking for approval", async () => {
  expect((await renderBusyRun(90_000, { approval: helperApproval, helper: { background: false } })).working).toMatch(/^Working 3\ds$/)
})

test("a background helper asking for approval does not pause the run", async () => {
  expect((await renderBusyRun(90_000, { approval: helperApproval, helper: { background: true } })).working).toMatch(/^Working 1m 3\ds$/)
})

test("Reconnecting replaces the Working line when the run can no longer be confirmed", async () => {
  const { working, reconnecting } = await renderBusyRun(NO_NEW_ACTIVITY_AFTER_MS + 60_000, { syncDegraded: true })
  expect(working).toBeNull()
  expect(reconnecting).toBe(true)
})
