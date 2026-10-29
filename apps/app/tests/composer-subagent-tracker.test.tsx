/** @jsxImportSource react */
import { afterAll, afterEach, beforeAll, expect, test } from "bun:test"
import { GlobalRegistrator } from "@happy-dom/global-registrator"
import { act } from "react"
import type { Root } from "react-dom/client"
import type { UIMessage } from "ai"

type TrackerModule = typeof import("../src/react-app/domains/session/surface/composer/composer-subagent-tracker")
type StoreModule = typeof import("../src/react-app/domains/session/status/session-activity-store")

let createRoot: typeof import("react-dom/client")["createRoot"]
let tracker: TrackerModule
let store: StoreModule["useSessionActivityStore"]
const ownedDom = !GlobalRegistrator.isRegistered && typeof document === "undefined"
beforeAll(async () => {
  if (ownedDom) GlobalRegistrator.register({ url: "http://localhost/" })
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true)
  createRoot = (await import("react-dom/client")).createRoot
  tracker = await import("../src/react-app/domains/session/surface/composer/composer-subagent-tracker")
  store = (await import("../src/react-app/domains/session/status/session-activity-store")).useSessionActivityStore
})
afterAll(async () => { if (ownedDom) await GlobalRegistrator.unregister() })
let root: Root | null = null
afterEach(async () => {
  if (root) await act(async () => root?.unmount())
  root = null
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

async function render(messages: UIMessage[], options: { parentActive?: boolean; onOpen?: (id: string) => void; onStop?: (id: string) => void } = {}) {
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
      />,
    )
  })
  return container
}

const rowKinds = (container: HTMLElement) => [...container.querySelectorAll("[data-subagent-tracker-row]")]
  .map((row) => row.getAttribute("data-subagent-tracker-kind"))

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
    .toEqual(["1 need you", "1 working", "1 with an error", "2 done"])
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
  const permissionRow = container.querySelector("[data-subagent-tracker-row='t2']")
  expect(permissionRow?.querySelector("[data-subagent-tracker-status]")?.textContent).toBe("Needs permission")
  expect(permissionRow?.querySelector("[data-subagent-tracker-review]")).not.toBeNull()
  expect(container.querySelector("[data-subagent-tracker-summary]")?.textContent).toBe("1 need you, 1 working")

  await act(async () => { container.querySelector<HTMLButtonElement>("[data-subagent-tracker-row='t1'] [data-subagent-tracker-open]")?.click() })
  await act(async () => { container.querySelector<HTMLButtonElement>("[data-subagent-tracker-row='t1'] [data-subagent-tracker-stop]")?.click() })
  expect(opened).toEqual(["ses_work"])
  expect(stopped).toEqual(["ses_work"])
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
  expect(words).toEqual(["Done", "Error", "Stopped", "Done"])
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
