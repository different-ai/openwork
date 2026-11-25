/** @jsxImportSource react */
import { afterAll, afterEach, beforeAll, expect, test } from "bun:test"
import { GlobalRegistrator } from "@happy-dom/global-registrator"
import { act } from "react"
import type { Root } from "react-dom/client"
import type { TaskToolPart } from "../src/lib/build-in-tools"

type RunLineModule = typeof import("../src/components/chat/subagent-run-line")
type ProviderModule = typeof import("../src/components/chat/message-list-provider")
type StoreModule = typeof import("../src/react-app/domains/session/status/session-activity-store")

let createRoot: typeof import("react-dom/client")["createRoot"]
let runLine: RunLineModule
let provider: ProviderModule
let store: StoreModule["useSessionActivityStore"]
const ownedDom = !GlobalRegistrator.isRegistered && typeof document === "undefined"
beforeAll(async () => {
  if (ownedDom) GlobalRegistrator.register({ url: "http://localhost/" })
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true)
  createRoot = (await import("react-dom/client")).createRoot
  runLine = await import("../src/components/chat/subagent-run-line")
  provider = await import("../src/components/chat/message-list-provider")
  store = (await import("../src/react-app/domains/session/status/session-activity-store")).useSessionActivityStore
})
afterAll(async () => { if (ownedDom) await GlobalRegistrator.unregister() })
let root: Root | null = null
afterEach(async () => {
  if (root) await act(async () => root?.unmount())
  root = null
  document.body.innerHTML = ""
})

const WORKSPACE = "ws_run_line"
const CHILD = "ses_child_running"

const part: TaskToolPart = {
  type: "dynamic-tool",
  toolName: "task",
  toolCallId: "t1",
  state: "input-available",
  input: { description: "Map the billing service", prompt: "Map the billing service", subagent_type: "explore" },
  callProviderMetadata: { openwork: { childSessionId: CHILD } },
}

async function render(composerSubagentToolCallIds?: ReadonlySet<string>) {
  store.getState().setRunStatus(WORKSPACE, CHILD, { type: "busy" })
  const container = document.createElement("div")
  document.body.append(container)
  root = createRoot(container)
  await act(async () => {
    root?.render(
      <provider.MessageListProvider
        workspaceId={WORKSPACE}
        sessionId="ses_parent"
        showThinking={false}
        developerMode={false}
        displaySuggestions={false}
        providerConnectedCount={0}
        dispatchAction={() => {}}
        setPrompt={() => {}}
        onRevertToUserMessage={() => {}}
        onForkAtMessage={() => {}}
        onEditUserMessage={() => {}}
        onMcpReconnect={async () => { throw new Error("Unexpected reconnect") }}
        onMcpReopenAuthorization={async () => {}}
        onOpenSubagentSession={() => {}}
        onStopSubagentSession={() => {}}
        composerSubagentToolCallIds={composerSubagentToolCallIds}
      >
        <runLine.SubagentRunLine part={part} />
      </provider.MessageListProvider>,
    )
  })
  return container
}

test("a running sub-agent row opens its chat and has its own Stop, with no extra arrow icon", async () => {
  const container = await render()
  expect(container.querySelector("button[aria-label='Map the billing service. Open sub-agent chat']")).not.toBeNull()
  expect(container.querySelector("[data-subagent-stop]")).not.toBeNull()
  expect(container.querySelector(".lucide-arrow-up-right")).toBeNull()
})

test("while the composer's Agents list shows the sub-agent, its Stop lives there, not on the chat row", async () => {
  const container = await render(new Set(["t1"]))
  expect(container.querySelector("button[aria-label='Map the billing service. Open sub-agent chat']")).not.toBeNull()
  expect(container.querySelector("[data-subagent-stop]")).toBeNull()
})

test("rows the Agents list does not show keep their Stop", async () => {
  const container = await render(new Set(["another_call"]))
  expect(container.querySelector("[data-subagent-stop]")).not.toBeNull()
})

test("running helpers are counted by the Agents list's rule: an activity record or a busy engine status", async () => {
  const { statusKey } = await import("../src/react-app/domains/session/sync/session-sync")
  const { getReactQueryClient } = await import("../src/react-app/infra/query-client")
  const queryClient = getReactQueryClient()
  // One helper is known running by its activity record, two only by the engine's status, one is idle.
  store.getState().seedSessionRun(WORKSPACE, "ses_a", { type: "busy" })
  queryClient.setQueryData(statusKey(WORKSPACE, "ses_b"), { type: "busy" })
  queryClient.setQueryData(statusKey(WORKSPACE, "ses_c"), { type: "retry", attempt: 1, message: "", next: 0 })
  queryClient.setQueryData(statusKey(WORKSPACE, "ses_d"), { type: "idle" })
  const ids = ["ses_a", "ses_b", "ses_c", "ses_d"]
  function Count() {
    return <span data-count>{runLine.useRunningSubagentIds(WORKSPACE, ids).join(",")}</span>
  }
  const container = document.createElement("div")
  document.body.append(container)
  root = createRoot(container)
  await act(async () => root?.render(<Count />))
  expect(container.querySelector("[data-count]")?.textContent).toBe("ses_a,ses_b,ses_c")

  await act(async () => { queryClient.setQueryData(statusKey(WORKSPACE, "ses_b"), { type: "idle" }) })
  expect(container.querySelector("[data-count]")?.textContent).toBe("ses_a,ses_c")
})
