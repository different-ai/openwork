/** @jsxImportSource react */
import { afterAll, afterEach, beforeAll, expect, test } from "bun:test"
import { GlobalRegistrator } from "@happy-dom/global-registrator"
import { act } from "react"
import type { Root } from "react-dom/client"
import type { UIMessage } from "ai"
import type { RemoteSessionThreadStatus } from "@openwork/types/automations"
import type { RemoteThreadStart } from "../src/lib/remote-session-thread"
import type { RemoteThreadEntry } from "../src/react-app/domains/session/remote-threads/remote-thread-store"

type TrackerModule = typeof import("../src/react-app/domains/session/surface/composer/composer-subagent-tracker")
type StoreModule = typeof import("../src/react-app/domains/session/remote-threads/remote-thread-store")

let createRoot: typeof import("react-dom/client")["createRoot"]
let tracker: TrackerModule
let store: StoreModule["useRemoteThreadStore"]
const ownedDom = !GlobalRegistrator.isRegistered && typeof document === "undefined"
beforeAll(async () => {
  if (ownedDom) GlobalRegistrator.register({ url: "http://localhost/" })
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true)
  createRoot = (await import("react-dom/client")).createRoot
  tracker = await import("../src/react-app/domains/session/surface/composer/composer-subagent-tracker")
  store = (await import("../src/react-app/domains/session/remote-threads/remote-thread-store")).useRemoteThreadStore
})
afterAll(async () => { if (ownedDom) await GlobalRegistrator.unregister() })
let root: Root | null = null
afterEach(async () => {
  if (root) await act(async () => root?.unmount())
  root = null
  document.body.innerHTML = ""
  store.setState({ enabled: false, threadView: false, helperView: false, threads: {} })
})

function createCall(id: string, commandId: string, title: string): UIMessage["parts"][number] {
  return {
    type: "dynamic-tool",
    toolName: "openwork_execute_capability",
    toolCallId: id,
    state: "output-available",
    input: { name: "remote-session:create", body: { target: "registered", computerId: "cmp_1", title, prompt: title } },
    output: { commandId, target: "registered" },
  }
}

function turn(parts: UIMessage["parts"], earlier: UIMessage["parts"] = []): UIMessage[] {
  return [
    { id: "u0", role: "user", parts: [{ type: "text", text: "Earlier request" }] },
    { id: "a0", role: "assistant", parts: earlier },
    { id: "u1", role: "user", parts: [{ type: "text", text: "Record the launch videos." }] },
    { id: "a1", role: "assistant", parts },
  ]
}

function entry(start: RemoteThreadStart, overrides: Partial<RemoteSessionThreadStatus>): RemoteThreadEntry {
  const status: RemoteSessionThreadStatus = {
    ref: start.key.slice(start.key.indexOf(":") + 1), changed: true, version: "v1", target: "desktop", state: "running", waitingFor: null,
    title: start.title, computerId: "cmp_1", computerLabel: "Studio computer", sessionId: "ses_remote", workspaceId: "ws_remote",
    messageCount: 2, preview: null, latestStep: null, error: null, observedAt: Date.now(), ...overrides,
  }
  return { start, organizationId: "org_1", version: "v1", status, stale: false, checkedAt: Date.now(), activeSince: Date.now(), firstSeenAt: Date.now(),
    followedUpAt: null, owners: {}, viewers: 0, lastViewedAt: Date.now() }
}

test("only the current turn's tasks on other computers are tracked, once each", () => {
  const messages = turn([createCall("c1", "rsc_1", "Record the demo videos"), createCall("c1b", "rsc_1", "Record the demo videos")], [createCall("c0", "rsc_0", "Old task")])
  expect(tracker.currentTurnRemoteTasks(messages).map((task) => task.start.key)).toEqual(["command:rsc_1"])
  expect(tracker.currentTurnRemoteTasks(messages.slice(0, 3))).toEqual([])
})

test("remote tasks list with where they run, a status word, Open and Stop, and count in the summary", async () => {
  const tasks = tracker.currentTurnRemoteTasks(turn([createCall("c1", "rsc_1", "Record the demo videos"), createCall("c2", "rsc_2", "Draft the changelog")]))
  const [first, second] = tasks
  if (!first || !second) throw new Error("expected two tasks")
  store.setState({ enabled: true, threadView: true, helperView: true, threads: {
    [first.start.key]: entry(first.start, { state: "running" }),
    [second.start.key]: entry(second.start, { state: "waiting", waitingFor: "question" }),
  } })
  const opened: string[] = []
  const container = document.createElement("div")
  document.body.append(container)
  root = createRoot(container)
  await act(async () => {
    root?.render(
      <tracker.ComposerSubagentTracker messages={[]} workspaceId="ws_1" parentActive={false} syncDegraded={false} includeLocal={false}
        remote={{ tasks, owner: { workspaceId: "ws_1", sessionId: "ses_parent" }, onOpen: (start) => opened.push(start.key) }} />,
    )
  })
  const rows = [...container.querySelectorAll<HTMLElement>("[data-subagent-tracker-remote]")]
  expect(rows.map((row) => row.dataset.subagentTrackerKind)).toEqual(["working", "attention"])
  expect(rows[0]?.querySelector("[data-subagent-tracker-agent]")?.textContent).toBe("Studio computer")
  expect(rows[0]?.querySelector("[data-subagent-tracker-task]")?.textContent).toBe("Record the demo videos")
  expect(rows.map((row) => row.querySelector("[data-subagent-tracker-status]")?.textContent)).toEqual(["Working", "Needs you"])
  expect(container.querySelector("[data-subagent-tracker-summary]")?.textContent).toBe("1 need you, 1 working")
  expect(rows[0]?.querySelector("[data-subagent-tracker-stop]")?.textContent).toBe("Stop")
  await act(async () => { rows[1]?.querySelector<HTMLButtonElement>("[data-subagent-tracker-open]")?.click() })
  expect(opened).toEqual(["command:rsc_2"])
})

test("a stopped task and one that failed read differently, and a settled list goes away once the turn ends", async () => {
  const tasks = tracker.currentTurnRemoteTasks(turn([createCall("c1", "rsc_1", "Record the demo videos"), createCall("c2", "rsc_2", "Draft the changelog")]))
  const [first, second] = tasks
  if (!first || !second) throw new Error("expected two tasks")
  store.setState({ enabled: true, threadView: true, helperView: true, threads: {
    [first.start.key]: entry(first.start, { state: "error", error: { code: "MessageAbortedError", message: "The task was stopped." } }),
    [second.start.key]: entry(second.start, { state: "error", error: { code: "session_error", message: "Disk full" } }),
  } })
  const container = document.createElement("div")
  document.body.append(container)
  root = createRoot(container)
  const render = async (parentActive: boolean) => act(async () => {
    root?.render(
      <tracker.ComposerSubagentTracker messages={[]} workspaceId="ws_1" parentActive={parentActive} syncDegraded={false} includeLocal={false}
        remote={{ tasks, owner: { workspaceId: "ws_1", sessionId: "ses_parent" } }} />,
    )
  })
  await render(true)
  const words = [...container.querySelectorAll("[data-subagent-tracker-remote] [data-subagent-tracker-status]")].map((node) => node.textContent)
  expect(words).toEqual(["Stopped", "Couldn't finish"])
  expect(container.querySelector("[data-subagent-tracker-open]")).toBeNull()
  await render(false)
  expect(container.querySelector("[data-subagent-tracker]")).toBeNull()
})

test("text-first rail: remote rows drop the status dot like local rows, the word carries the state", async () => {
  const { useTextActivityRailStore } = await import("../src/components/chat/text-activity-rail-store")
  const tasks = tracker.currentTurnRemoteTasks(turn([createCall("c1", "rsc_1", "Record the demo videos")]))
  const [first] = tasks
  if (!first) throw new Error("expected a task")
  store.setState({ enabled: true, threadView: true, helperView: true, threads: { [first.start.key]: entry(first.start, { state: "running" }) } })
  useTextActivityRailStore.getState().setEnabled(true)
  try {
    const container = document.createElement("div")
    document.body.append(container)
    root = createRoot(container)
    await act(async () => {
      root?.render(
        <tracker.ComposerSubagentTracker messages={[]} workspaceId="ws_1" parentActive syncDegraded={false} includeLocal={false}
          remote={{ tasks, owner: { workspaceId: "ws_1", sessionId: "ses_parent" }, onOpen: () => {} }} />,
      )
    })
    const row = container.querySelector<HTMLElement>("[data-subagent-tracker-remote]")
    expect(row?.querySelector(".rounded-full")).toBeNull()
    expect(row?.firstElementChild?.querySelector("[data-subagent-tracker-agent]")?.textContent).toBe("Studio computer")
    expect(row?.querySelector("[data-subagent-tracker-status]")?.textContent).toBe("Working")
  } finally {
    useTextActivityRailStore.getState().setEnabled(false)
  }
})
