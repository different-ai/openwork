/** @jsxImportSource react */
import { afterAll, afterEach, beforeAll, expect, test } from "bun:test"
import { GlobalRegistrator } from "@happy-dom/global-registrator"
import { act } from "react"
import type { Root } from "react-dom/client"
import type { UIMessage } from "ai"
import type { RemoteSessionThreadStatus } from "@openwork/types/automations"
import type { RemoteThreadEntry } from "../src/react-app/domains/session/remote-threads/remote-thread-store"

type TrackerModule = typeof import("../src/react-app/domains/session/surface/composer/composer-subagent-tracker")
type StoreModule = typeof import("../src/react-app/domains/session/status/session-activity-store")

let createRoot: typeof import("react-dom/client")["createRoot"]
let tracker: TrackerModule
let store: StoreModule["useSessionActivityStore"]
let remoteStore: typeof import("../src/react-app/domains/session/remote-threads/remote-thread-store")["useRemoteThreadStore"]
const ownedDom = !GlobalRegistrator.isRegistered && typeof document === "undefined"
beforeAll(async () => {
  if (ownedDom) GlobalRegistrator.register({ url: "http://localhost/" })
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true)
  createRoot = (await import("react-dom/client")).createRoot
  tracker = await import("../src/react-app/domains/session/surface/composer/composer-subagent-tracker")
  store = (await import("../src/react-app/domains/session/status/session-activity-store")).useSessionActivityStore
  remoteStore = (await import("../src/react-app/domains/session/remote-threads/remote-thread-store")).useRemoteThreadStore
})
afterAll(async () => { if (ownedDom) await GlobalRegistrator.unregister() })
let root: Root | null = null
afterEach(async () => {
  if (root) await act(async () => root?.unmount())
  root = null
  remoteStore.setState({ threads: {} })
  document.body.innerHTML = ""
})

const WORKSPACE = "ws_tracker"

type AgentState = "working" | "done" | "error" | "stopped"

function taskPart(id: string, agent: string, description: string, state: AgentState, childSessionId: string): UIMessage["parts"][number] {
  const base = {
    type: "dynamic-tool" as const,
    toolName: "task",
    toolCallId: id,
    input: { description, prompt: description, subagent_type: agent },
    callProviderMetadata: { openwork: { childSessionId } },
  }
  if (state === "done") return { ...base, state: "output-available", output: "Finished." }
  if (state === "error") return { ...base, state: "output-error", errorText: "Task failed: 3 tests did not pass." }
  if (state === "stopped") return { ...base, state: "output-error", errorText: "The operation was aborted." }
  return { ...base, state: "input-available" }
}

function turn(parts: UIMessage["parts"], earlier: UIMessage["parts"] = []): UIMessage[] {
  return [
    { id: "u0", role: "user", parts: [{ type: "text", text: "Earlier request" }] },
    { id: "a0", role: "assistant", parts: earlier },
    { id: "u1", role: "user", parts: [{ type: "text", text: "Get the billing release ready." }] },
    { id: "a1", role: "assistant", parts },
  ]
}

async function render(messages: UIMessage[], options: {
  parentActive?: boolean
  onOpen?: (id: string) => void
  onStop?: (id: string) => void
  remote?: Parameters<TrackerModule["ComposerSubagentTracker"]>[0]["remote"]
} = {}) {
  const container = document.createElement("div")
  document.body.append(container)
  root = createRoot(container)
  await act(async () => {
    root?.render(
      <tracker.ComposerSubagentTracker
        messages={messages}
        workspaceId={WORKSPACE}
        parentActive={options.parentActive ?? true}
        syncDegraded={false}
        onOpenSubagentSession={options.onOpen}
        onStopSubagentSession={options.onStop}
        remote={options.remote}
      />,
    )
  })
  return container
}

const rowKinds = (container: HTMLElement) => [...container.querySelectorAll("[data-subagent-tracker-row]")]
  .map((row) => row.getAttribute("data-subagent-tracker-kind"))

const owner = { workspaceId: WORKSPACE, sessionId: "parent" }

function remoteEntry(id: string, state: RemoteSessionThreadStatus["state"], overrides?: Partial<RemoteSessionThreadStatus>): RemoteThreadEntry {
  const now = Date.now()
  const title = "Prepare the release checklist from the current documentation"
  const start: RemoteThreadEntry["start"] = {
    key: `command:${id}`, ref: { commandId: id }, toolCallId: `call_${id}`, title, prompt: title,
    target: "desktop", sessionId: state === "starting" ? null : id, workspaceId: "remote_ws", computerId: "computer",
  }
  return {
    start, organizationId: "org_test", version: "v1", stale: false, checkedAt: now,
    activeSince: now - 65_000, firstSeenAt: now - 65_000, followedUpAt: null,
    owners: { [`${WORKSPACE}:${owner.sessionId}`]: owner }, viewers: 0, lastViewedAt: now,
    status: {
      ref: id, changed: true, version: "v1", target: "desktop", state, waitingFor: null, title,
      computerId: "computer", computerLabel: "Office Mac Studio with a long device name", sessionId: start.sessionId,
      workspaceId: start.workspaceId, messageCount: 0, preview: null, latestStep: null, error: null, observedAt: now,
      ...overrides,
    },
  }
}

test("remote and local tasks share one tracker; remote state, elapsed, and actions use the same row anatomy", async () => {
  const entries = [
    remoteEntry("starting", "starting"),
    remoteEntry("running", "running"),
    remoteEntry("permission", "waiting", { waitingFor: "permission" }),
    remoteEntry("question", "waiting", { waitingFor: "question" }),
    remoteEntry("done", "idle"),
    remoteEntry("failed", "error", { error: { code: "failed", message: "Task failed" } }),
    remoteEntry("stopped", "error", { error: { code: "aborted", message: "Task aborted" } }),
    { ...remoteEntry("stale", "running"), stale: true },
  ]
  remoteStore.setState({ threads: Object.fromEntries(entries.map((entry) => [entry.start.key, entry])) })
  const opened: string[] = []
  const container = await render(turn([taskPart("local", "general", "Review the draft", "working", "ses_local")]), {
    remote: { owner, tasks: entries.map((entry) => ({ start: entry.start, startedAt: entry.activeSince })), onOpen: (start) => opened.push(start.key) },
  })
  const rows = [...container.querySelectorAll("[data-subagent-tracker-remote]")]
  const words = rows.map((row) => row.querySelector("[data-subagent-tracker-status]")?.textContent)
  expect(words).toEqual(["Starting", "Working", "Needs permission", "Waiting for your answer", "Done", "Failed", "Stopped", "Reconnecting"])
  expect(rowKinds(container)).toEqual(["working", "working", "working", "attention", "attention", "done", "error", "stopped", "working"])
  expect(rows[1]?.querySelector("[data-subagent-tracker-agent]")?.textContent).toBe(entries[1]?.status?.computerLabel)
  expect(rows[1]?.querySelector("[data-subagent-tracker-task]")?.textContent).toBe(entries[1]?.start.title)
  for (const row of rows) {
    const elapsed = row.querySelector("[data-subagent-tracker-elapsed]")
    expect(elapsed?.textContent).toBe("1m 5s")
    expect(elapsed?.parentElement?.classList.contains("whitespace-nowrap")).toBe(true)
  }
  expect(rows[7]?.querySelector(".ow-text-shimmer")).toBeNull()
  expect(rows[0]?.querySelector("[data-subagent-tracker-stop]")).toBeNull()
  expect(rows[1]?.querySelector("[data-subagent-tracker-stop]")?.textContent).toBe("Stop")
  await act(async () => rows[2]?.querySelector<HTMLButtonElement>("[data-subagent-tracker-review]")?.click())
  expect(opened).toEqual(["command:permission"])
  const toggle = container.querySelector<HTMLButtonElement>("[data-testid='subagent-tracker-toggle']")
  expect(toggle?.getAttribute("aria-expanded")).toBe("true")
  await act(async () => toggle?.click())
  expect(toggle?.getAttribute("aria-expanded")).toBe("false")
  await act(async () => toggle?.click())
  expect(toggle?.getAttribute("aria-expanded")).toBe("true")
})

test("a bound task can retain its terminal row during the active parent turn without listing unrelated tasks", () => {
  const done = remoteEntry("done", "idle")
  const old = remoteEntry("old", "error")
  const threads = { [done.start.key]: done, [old.start.key]: old }
  const tasks = { earlier: [], current: [], followUps: [] }
  expect(tracker.selectComposerRemoteTasks(tasks, threads, "org_test", Date.now(), owner)).toEqual([])
  expect(tracker.selectComposerRemoteTasks(tasks, threads, "org_test", Date.now(), owner, new Set([done.start.key])).map((task) => task.start.key))
    .toEqual([done.start.key])
})

test("only the current turn's sub-agents are tracked", () => {
  const messages = turn(
    [taskPart("t1", "explore", "Map the billing service", "working", "ses_a")],
    [taskPart("t0", "general", "Old task", "done", "ses_old")],
  )
  expect(tracker.currentTurnSubagentParts(messages).map((part) => part.toolCallId)).toEqual(["t1"])
  expect(tracker.currentTurnSubagentParts(messages.slice(0, 3))).toEqual([])
})

test("the header counts what needs the person first and folds finished agents together", () => {
  expect(tracker.subagentTrackerSummary(["working", "attention", "done", "stopped", "error"]).map((entry) => entry.text))
    .toEqual(["1 need you", "1 working", "1 failed", "2 done"])
})

test("no sub-agents in the turn: nothing attaches to the composer", async () => {
  const container = await render(turn([{ type: "text", text: "No helpers." }]))
  expect(container.querySelector("[data-subagent-tracker]")).toBeNull()
})

test("a sub-agent waiting on permission reads Needs permission with Review, and running ones can be stopped or opened", async () => {
  store.getState().setRunStatus(WORKSPACE, "ses_work", { type: "busy" })
  store.getState().setRunStatus(WORKSPACE, "ses_perm", { type: "busy" })
  store.getState().setWaitingRequest(WORKSPACE, "ses_perm", "permission", "per_1", true)
  const opened: string[] = []
  const stopped: string[] = []
  const container = await render(turn([
    taskPart("t1", "explore", "Map the billing service", "working", "ses_work"),
    taskPart("t2", "general", "Investigate the deployment failure", "working", "ses_perm"),
  ]), { onOpen: (id) => opened.push(id), onStop: (id) => { stopped.push(id) } })

  expect(container.querySelector("[data-subagent-tracker]")?.getAttribute("data-subagent-tracker-expanded")).toBe("true")
  expect(rowKinds(container)).toEqual(["working", "attention"])
  const workingRow = container.querySelector("[data-subagent-tracker-row='t1']")
  expect(workingRow?.querySelector(".rounded-full")).toBeNull()
  expect(workingRow?.querySelector("[data-subagent-tracker-stop]")?.textContent).toBe("Stop")
  expect(workingRow?.querySelector("[data-subagent-tracker-open]")?.textContent).toBe("Open")
  const permissionRow = container.querySelector("[data-subagent-tracker-row='t2']")
  expect(permissionRow?.querySelector("[data-subagent-tracker-status]")?.textContent).toBe("Needs permission")
  expect(permissionRow?.querySelector("[data-subagent-tracker-review]")).not.toBeNull()
  expect(container.querySelector("[data-subagent-tracker-summary]")?.textContent).toBe("1 need you, 1 working")

  await act(async () => { container.querySelector<HTMLButtonElement>("[data-subagent-tracker-row='t1'] [data-subagent-tracker-open]")?.click() })
  await act(async () => { container.querySelector<HTMLButtonElement>("[data-subagent-tracker-row='t1'] [data-subagent-tracker-stop]")?.click() })
  expect(opened).toEqual(["ses_work"])
  expect(stopped).toEqual(["ses_work"])
})

test("clicking an agent's name or task opens its chat, like Open", async () => {
  store.getState().setRunStatus(WORKSPACE, "ses_work", { type: "busy" })
  const opened: string[] = []
  const container = await render(turn([
    taskPart("t1", "explore", "Map the billing service", "working", "ses_work"),
  ]), { onOpen: (id) => opened.push(id), onStop: () => {} })

  const name = container.querySelector<HTMLButtonElement>("[data-subagent-tracker-row='t1'] [data-subagent-tracker-name-open]")
  expect(name?.textContent).toContain("Map the billing service")
  await act(async () => { name?.click() })
  expect(opened).toEqual(["ses_work"])
})

test("finished, failed and stopped agents keep distinct words; several quiet agents start collapsed", async () => {
  const container = await render(turn([
    taskPart("t1", "general", "Summarize incidents", "done", "ses_done"),
    taskPart("t2", "test-runner", "Run the invoice tests", "error", "ses_err"),
    taskPart("t3", "docs-writer", "Draft migration notes", "stopped", "ses_stop"),
    taskPart("t4", "reviewer", "Review pricing copy", "done", "ses_done2"),
  ]))
  expect(rowKinds(container)).toEqual(["done", "error", "stopped", "done"])
  const words = [...container.querySelectorAll("[data-subagent-tracker-status]")].map((node) => node.textContent)
  expect(words).toEqual(["Done", "Failed", "Stopped", "Done"])
  expect(container.querySelector("[data-subagent-tracker]")?.getAttribute("data-subagent-tracker-expanded")).toBe("false")
  await act(async () => { container.querySelector<HTMLButtonElement>("[data-subagent-tracker] > button")?.click() })
  expect(container.querySelector("[data-subagent-tracker]")?.getAttribute("data-subagent-tracker-expanded")).toBe("true")
})

test("once the turn has ended and every agent settled, the list goes away", async () => {
  const container = await render(turn([
    taskPart("t1", "general", "Summarize incidents", "done", "ses_done_idle"),
  ]), { parentActive: false })
  expect(container.querySelector("[data-subagent-tracker]")).toBeNull()
})

async function renderListed(messages: UIMessage[], keepEarlier: boolean) {
  const container = document.createElement("div")
  document.body.append(container)
  root = createRoot(container)
  function Listed(props: { messages: UIMessage[] }) {
    const parts = tracker.useComposerSubagentParts(props.messages, WORKSPACE, { enabled: true, keepEarlier })
    return <output data-listed={parts.map((part) => part.toolCallId).join(",")} />
  }
  const listed = () => container.querySelector("output")?.getAttribute("data-listed") ?? ""
  await act(async () => root?.render(<Listed messages={messages} />))
  return { listed, rerender: (next: UIMessage[]) => act(async () => root?.render(<Listed messages={next} />)) }
}

test("a follow-up keeps an earlier turn's helper listed while it still works, only with keepEarlier", async () => {
  store.getState().setRunStatus(WORKSPACE, "ses_bg_running", { type: "busy" })
  const messages = turn(
    [{ type: "text", text: "It's Thursday." }],
    [taskPart("t_bg", "general", "Review release notes", "done", "ses_bg_running"), taskPart("t_old", "general", "Old task", "done", "ses_bg_idle")],
  )
  expect(tracker.earlierTurnSubagentParts(messages).map((part) => part.toolCallId)).toEqual(["t_bg", "t_old"])
  expect((await renderListed(messages, true)).listed()).toBe("t_bg")
  await act(async () => root?.unmount())
  root = null
  expect((await renderListed(messages, false)).listed()).toBe("")
})

test("an earlier helper that finishes mid-turn stays listed until the next turn", async () => {
  store.getState().setRunStatus(WORKSPACE, "ses_bg_finishing", { type: "busy" })
  const earlier = [taskPart("t_fin", "general", "Review release notes", "done", "ses_bg_finishing")]
  const messages = turn([{ type: "text", text: "Working on it." }], earlier)
  const view = await renderListed(messages, true)
  expect(view.listed()).toBe("t_fin")
  await act(async () => store.getState().setRunStatus(WORKSPACE, "ses_bg_finishing", { type: "idle" }))
  await view.rerender([...messages])
  expect(view.listed()).toBe("t_fin")
  await view.rerender([...messages, { id: "u2", role: "user", parts: [{ type: "text", text: "Next." }] }])
  expect(view.listed()).toBe("")
})
