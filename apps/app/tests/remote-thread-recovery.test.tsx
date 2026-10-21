import { afterAll, afterEach, beforeAll, beforeEach, expect, mock, spyOn, test } from "bun:test"
import { GlobalRegistrator } from "@happy-dom/global-registrator"
import { act } from "react"
import type { Root } from "react-dom/client"
import type { RemoteThreadStart } from "../src/lib/remote-session-thread"

let response: (action: string, input: Record<string, unknown>) => Promise<unknown>
const calls: string[] = []
mock.module("@/app/lib/den", () => ({
  readDenSettings: () => ({ authToken: "fixture", activeOrgId: "org_fixture" }),
  createDenClient: () => ({
    remoteSessionAction: (org: string, action: string, input: Record<string, unknown>) => { calls.push(action); return response(action, input) },
    getRemoteSessionStatus: () => new Promise(() => {}),
  }),
  DenApiError: class extends Error { constructor(public status: number, public code: string, message: string) { super(message) } },
}))
mock.module("@/components/markdown/markdown", () => ({ MarkdownBlock: ({ text }: { text: string }) => <p>{text}</p> }))
mock.module("@/components/chat/message-list-provider", () => ({ useMessageList: () => ({ workspaceId: "ws_owner", sessionId: "ses_owner", readOnly: false }) }))
const { RemoteThreadRunLine } = await import("../src/components/chat/remote-thread-run-line")
const { DenApiError } = await import("../src/app/lib/den")
const { useRemoteThreadStore } = await import("../src/react-app/domains/session/remote-threads/remote-thread-store")
const { RemoteThreadPanel } = await import("../src/react-app/domains/session/remote-threads/remote-thread-panel")
const { sendRemoteFollowUp, stopRemoteThread, checkRemoteThreadAction } = await import("../src/react-app/domains/session/remote-threads/remote-thread-actions")
const { remoteThreadView } = await import("../src/react-app/domains/session/remote-threads/remote-thread-view")

const start: RemoteThreadStart = { key: "cloud:ses_remote", ref: { sessionId: "ses_remote" }, toolCallId: "call_remote", title: "Review notes", prompt: "Review the notes", target: "cloud", sessionId: "ses_remote", workspaceId: null, computerId: null }
const owner = { workspaceId: "ws_owner", sessionId: "ses_owner" }
const tab = { type: "remote-thread", id: "tab_remote", label: "Review notes", threadKey: start.key, owner } as const
const ownedDom = typeof document === "undefined"
let root: Root | null = null
let container: HTMLDivElement
let createRoot: typeof import("react-dom/client")["createRoot"]
let previousAct: unknown
beforeAll(async () => {
  if (ownedDom) GlobalRegistrator.register({ url: "http://localhost/" })
  createRoot = (await import("react-dom/client")).createRoot
})
afterAll(async () => { if (ownedDom) await GlobalRegistrator.unregister() })
beforeEach(() => {
  previousAct = Reflect.get(globalThis, "IS_REACT_ACT_ENVIRONMENT")
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true)
  calls.length = 0
  useRemoteThreadStore.setState({ enabled: false, threads: {} })
  useRemoteThreadStore.getState().watch(start, { owner, organizationId: "org_fixture", startedAt: Date.now() })
  useRemoteThreadStore.setState({ enabled: true })
  response = async () => ({ messages: [{ id: "msg_original", role: "user", text: "Review the notes" }], nextCursor: null })
  container = document.createElement("div")
  document.body.append(container)
})
afterEach(async () => {
  if (root) await act(async () => root?.unmount())
  root = null
  document.body.innerHTML = ""
  useRemoteThreadStore.setState({ enabled: false, threads: {} })
  mock.restore()
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", previousAct)
})
const entry = () => {
  const found = useRemoteThreadStore.getState().threads[start.key]
  if (!found) throw new Error("Missing thread")
  return found
}
async function mount(withRow = false) {
  root = createRoot(container)
  await act(async () => root?.render(<>{withRow ? <RemoteThreadRunLine start={start} part={{ type: "dynamic-tool", toolName: "openwork-cloud_execute_capability", toolCallId: "call_remote", state: "output-available", input: {}, output: {} }} /> : null}<RemoteThreadPanel tab={tab} /></>))
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)) })
}
async function type(text: string) {
  const input = container.querySelector("textarea")
  if (!input) throw new Error("Missing follow-up")
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(input, text)
    input.dispatchEvent(new Event("input", { bubbles: true }))
  })
  return input
}

test("a slow follow-up keeps the next editable draft on success and retains the submitted message", async () => {
  let accept: (payload: unknown) => void = () => {}
  response = async (action) => action === "send" ? new Promise((resolve) => { accept = resolve }) : { messages: [] }
  await mount()
  await type("First follow-up")
  await act(async () => { container.querySelector("form")?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })) })
  expect(container.querySelector("textarea")?.value).toBe("")
  expect(container.querySelector('[data-remote-follow-up="requesting"]')?.textContent).toContain("First follow-up")
  const input = await type("Next draft stays here")
  await act(async () => accept({ state: "accepted" }))
  expect(input.value).toBe("Next draft stays here")
  expect(container.textContent).toContain("First follow-up")
  expect(entry().followUps[0]?.phase).toBe("accepted")
})

test("a receipt never clears text typed after the follow-up was submitted", async () => {
  let accept: (payload: unknown) => void = () => {}
  response = async (action) => action === "send" ? new Promise((resolve) => { accept = resolve }) : { messages: [] }
  await mount()
  await type("Submitted follow-up")
  await act(async () => { container.querySelector("form")?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })) })
  const input = await type("Text written during the wait")
  await act(async () => accept({ state: "accepted" }))
  expect(input.value).toBe("Text written during the wait")
})

test("a next draft survives switching away, a failed pending send, and reopening its own conversation", async () => {
  let reject: (payload: unknown) => void = () => {}
  response = async (action) => action === "send" ? new Promise((resolve) => { reject = resolve }) : { messages: [] }
  await mount()
  await type("Submitted before switching")
  await act(async () => container.querySelector("form")?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })))
  await type("Keep my next draft on reopen")
  await act(async () => root?.render(<p>Another tab</p>))
  await act(async () => reject({ error: "refused", message: "The computer refused the follow-up." }))
  await act(async () => root?.render(<RemoteThreadPanel tab={{ ...tab, owner: { ...owner, sessionId: "ses_other" } }} />))
  expect(container.querySelector("textarea")?.value).toBe("")
  await type("Another conversation's draft")
  await act(async () => root?.render(<RemoteThreadPanel tab={tab} />))
  expect(container.querySelector("textarea")?.value).toBe("Keep my next draft on reopen")
  expect(container.textContent).toContain("Submitted before switching")
  expect(container.textContent).toContain("The computer refused the follow-up")
})

test("a late send acknowledgement cannot erase the Stop submitted while it was in flight", async () => {
  let acceptSend: (payload: unknown) => void = () => {}
  let acceptStop: (payload: unknown) => void = () => {}
  response = async (action) => new Promise((resolve) => { if (action === "send") acceptSend = resolve; else acceptStop = resolve })
  const sending = sendRemoteFollowUp(entry(), "Follow up before Stop")
  const stopping = stopRemoteThread(entry(), "msg_original")
  const stopId = entry().stop?.id
  acceptSend({ state: "accepted" })
  await sending
  expect(entry().stop?.id).toBe(stopId)
  expect(entry().stop?.phase).toBe("requesting")
  await stopRemoteThread(entry(), "msg_original")
  expect(calls.filter((action) => action === "stop")).toHaveLength(1)
  acceptStop({ stopped: true })
  await stopping
  expect(entry().stop?.id).toBe(stopId)
  expect(entry().stop?.phase).toBe("accepted")
})

test("agent follow-ups retire only a Stop older than that turn, never a newer Stop acknowledged late", async () => {
  let accept: (payload: unknown) => void = () => {}
  response = async () => new Promise((resolve) => { accept = resolve })
  const stopping = stopRemoteThread(entry(), "msg_original")
  const stoppedTurn = entry().stop
  if (!stoppedTurn?.requestedAt) throw new Error("Missing owned Stop request time")
  useRemoteThreadStore.getState().revive("ses_remote", stoppedTurn.requestedAt - 1)
  expect(entry().stop?.id).toBe(stoppedTurn.id)
  accept({ stopped: true })
  await stopping
  expect(entry().stop?.requestedAt).toBe(stoppedTurn.requestedAt)
  useRemoteThreadStore.getState().revive("ses_remote", stoppedTurn.requestedAt + 1)
  expect(entry().stop).toBeNull()
  expect(calls.filter((kind) => kind === "stop")).toHaveLength(1)
})

for (const action of ["send", "stop"]) test(`a known ${action} receipt survives transport failure and recovery only reads it`, async () => {
  response = async (kind) => kind === "read" ? Promise.reject(new Error("fixture connection lost")) : { state: "pending", requestId: "receipt_known" }
  if (action === "send") await sendRemoteFollowUp(entry(), "Retain this submitted message")
  else await stopRemoteThread(entry(), "msg_original")
  const followUpId = action === "send" ? entry().followUps[0]?.id : undefined
  const pending = action === "send" ? entry().followUps[0] : entry().stop
  expect(pending).toMatchObject({ phase: "unconfirmed", requestId: "receipt_known" })
  await checkRemoteThreadAction(entry(), followUpId)
  const stillPending = action === "send" ? entry().followUps[0] : entry().stop
  expect(stillPending?.requestId).toBe("receipt_known")
  response = async (kind, input) => {
    expect(kind).toBe("read")
    expect(input).toEqual({ requestId: "receipt_known" })
    return action === "send" ? { state: "accepted" } : { stopped: true }
  }
  await checkRemoteThreadAction(entry(), followUpId)
  expect(calls.filter((kind) => kind === action)).toHaveLength(1)
  expect((action === "send" ? entry().followUps[0] : entry().stop)?.phase).toBe("accepted")
}, 10_000)

test("failed sends preserve submitted text separately from the next draft", async () => {
  response = async (action) => action === "send" ? { error: "rejected", message: "The computer refused this follow-up." } : { messages: [] }
  await sendRemoteFollowUp(entry(), "Keep the submitted text")
  expect(entry().followUps[0]).toMatchObject({ phase: "failed", text: "Keep the submitted text" })
})

test("Stop rejection remains shared on the thread and never says Stopped", async () => {
  response = async (action) => action === "stop" ? { error: "offline", message: "The computer is offline. Try again when it reconnects." } : { messages: [] }
  await mount(true)
  await act(async () => container.querySelector<HTMLButtonElement>("[data-remote-thread-stop]")?.click())
  expect(container.querySelector("[data-remote-thread]")?.textContent).toContain("The computer is offline")
  expect(container.querySelector("[data-remote-thread-panel]")?.textContent).toContain("The computer is offline")
  expect(entry().stop).toMatchObject({ phase: "failed", message: "The computer is offline. Try again when it reconnects." })
  expect(remoteThreadView(start, entry(), Date.now()).stopped).toBe(false)
})

test("an exhausted Stop receipt is unconfirmed; Check again reads the receipt without repeating Stop", async () => {
  let now = 1_000
  spyOn(Date, "now").mockImplementation(() => now += 50_000)
  response = async () => ({ state: "pending", requestId: "request_stop" })
  await stopRemoteThread(entry(), "msg_original")
  expect(entry().stop?.phase).toBe("unconfirmed")
  expect(remoteThreadView(start, entry(), Date.now()).status).toContain("Stop not confirmed")
  expect(calls).toEqual(["stop"])
  response = async () => ({ stopped: true })
  await checkRemoteThreadAction(entry())
  expect(calls).toEqual(["stop", "read"])
  expect(entry().stop?.phase).toBe("accepted")
  expect(remoteThreadView(start, entry(), Date.now()).status).toContain("Stop requested")
  expect(remoteThreadView(start, entry(), Date.now()).stopped).toBe(false)
})

test("a guard refusing Stop for a different turn is not acknowledged as accepted", async () => {
  response = async () => ({ stopped: false, reason: "different_turn" })
  await stopRemoteThread(entry(), "msg_original")
  expect(entry().stop?.phase).toBe("failed")
  expect(entry().stop?.message).toContain("different turn")
  expect(remoteThreadView(start, entry(), Date.now()).stopped).toBe(false)
})

test("a paused or bounded follower shows old live state as last known without stopping the task", () => {
  useRemoteThreadStore.getState().update(start.key, (thread) => ({ ...thread, activeSince: 1_000, checkedAt: 11_000, stale: false }))
  const old = remoteThreadView(start, entry(), 200_000)
  expect(old.lastChecked).toContain("Couldn't verify")
  expect(old.status).toBe("Working 10s")
  expect(old.active).toBe(true)
  expect(old.stopped).toBe(false)
  useRemoteThreadStore.getState().update(start.key, (thread) => ({ ...thread, checkedAt: 200_000 }))
  expect(remoteThreadView(start, entry(), 200_000).lastChecked).toBeNull()
})

test("a definitive sign-in rejection before a receipt is a failed action, not a permanently disabled Stop", async () => {
  response = async () => { throw new DenApiError(401, "unauthorized", "Sign in to check this task.") }
  await stopRemoteThread(entry(), "msg_original")
  expect(entry().stop).toMatchObject({ phase: "failed", requestId: null })
  await stopRemoteThread(entry(), "msg_original")
  expect(calls.filter((kind) => kind === "stop")).toHaveLength(2)
})

test("a timeout without a receipt is still unconfirmed, not a proven rejection", async () => {
  response = async () => { throw new DenApiError(408, "request_timeout", "The request timed out.") }
  await sendRemoteFollowUp(entry(), "Do not replay an uncertain timeout")
  expect(entry().followUps[0]).toMatchObject({ phase: "unconfirmed", requestId: null })
})

test("sign-in loss while reading a known receipt keeps that receipt for read-only recovery", async () => {
  response = async (kind) => { if (kind === "read") throw new DenApiError(401, "unauthorized", "Sign in to check this task."); return { state: "pending", requestId: "receipt_auth" } }
  await stopRemoteThread(entry(), "msg_original")
  expect(entry().stop).toMatchObject({ phase: "unconfirmed", requestId: "receipt_auth" })
  response = async (kind, input) => { expect(kind).toBe("read"); expect(input).toEqual({ requestId: "receipt_auth" }); return { stopped: true } }
  await checkRemoteThreadAction(entry())
  expect(calls.filter((kind) => kind === "stop")).toHaveLength(1)
}, 10_000)

test("an unconfirmed transcript ends the skeleton and offers checking the same receipt", async () => {
  let now = 1_000
  spyOn(Date, "now").mockImplementation(() => now += 50_000)
  response = async () => ({ state: "pending", requestId: "request_read" })
  await mount()
  expect(container.textContent).toContain("Conversation not confirmed yet")
  expect(container.textContent).toContain("Check again")
})
