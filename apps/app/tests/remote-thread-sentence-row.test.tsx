import { expect, test } from "bun:test"
import { GlobalRegistrator } from "@happy-dom/global-registrator"
import type { DynamicToolUIPart } from "ai"
import { act } from "react"
import { createRoot } from "react-dom/client"
import type { RemoteSessionThreadStatus } from "@openwork/types/automations"
import { MessageListProvider } from "../src/components/chat/message-list-provider"
import { RemoteThreadRunLine } from "../src/components/chat/remote-thread-run-line"
import type { RemoteThreadStart } from "../src/lib/remote-session-thread"
import { useRemoteThreadStore, type RemoteThreadEntry } from "../src/react-app/domains/session/remote-threads/remote-thread-store"

const desktop: RemoteThreadStart = {
  key: "command:cmd_row", ref: { commandId: "cmd_row" }, toolCallId: "call_row", title: "Record 23 demo videos",
  prompt: "Record 23 demo videos", target: "desktop", sessionId: "ses_remote", workspaceId: "ws_remote", computerId: "cmp_1",
}
const cloud: RemoteThreadStart = { ...desktop, key: "cloud:ses_cloud", ref: { sessionId: "ses_cloud" }, title: "Draft the GA changelog", target: "cloud" }
const part: DynamicToolUIPart = { type: "dynamic-tool", toolName: "remote-session:create", toolCallId: "call_row", state: "output-available", input: {}, output: {} }

function status(start: RemoteThreadStart, overrides: Partial<RemoteSessionThreadStatus>): RemoteSessionThreadStatus {
  return {
    ref: start.key.slice(start.key.indexOf(":") + 1), changed: true, version: "v1", target: start.target, state: "running", waitingFor: null,
    title: start.title, computerId: "cmp_1", computerLabel: start.target === "cloud" ? null : "Benjamin's Mac Studio",
    sessionId: start.sessionId, workspaceId: null, messageCount: 3, preview: null, latestStep: null, error: null, observedAt: Date.now(),
    ...overrides,
  }
}

function entry(start: RemoteThreadStart, value: RemoteSessionThreadStatus, activeSince: number): RemoteThreadEntry {
  return { start, organizationId: "org_1", version: value.version, status: value, stale: false, checkedAt: Date.now(), activeSince,
    firstSeenAt: activeSince, followedUpAt: null, owners: { "ws_1:session-1": { workspaceId: "ws_1", sessionId: "session-1" } }, viewers: 0, lastViewedAt: Date.now() }
}

async function withRow(input: { helperView: boolean; start: RemoteThreadStart; entry: RemoteThreadEntry; onOpenRemoteTask?: (start: RemoteThreadStart) => void },
  check: (row: HTMLElement) => Promise<void> | void) {
  const ownedDom = typeof window === "undefined"
  if (ownedDom) GlobalRegistrator.register({ url: "http://localhost/" })
  const actEnvironment = Reflect.get(globalThis, "IS_REACT_ACT_ENVIRONMENT")
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true)
  useRemoteThreadStore.setState({ helperView: input.helperView, threads: { [input.start.key]: input.entry } })
  const container = document.createElement("div")
  document.body.append(container)
  const root = createRoot(container)
  try {
    await act(async () => {
      root.render(<MessageListProvider workspaceId="ws_1" sessionId="session-1"
        showThinking={false} developerMode={false} displaySuggestions={false} providerConnectedCount={1}
        onRevertToUserMessage={() => {}} onEditUserMessage={() => {}} onOpenRemoteTask={input.onOpenRemoteTask}
        onMcpReconnect={async () => "connected"} onMcpReopenAuthorization={async () => {}}
        dispatchAction={() => {}} setPrompt={() => {}}>
        <RemoteThreadRunLine start={input.start} part={part} />
      </MessageListProvider>)
    })
    await check(container.querySelector<HTMLElement>("[data-remote-thread]")!)
  } finally {
    await act(async () => { root.unmount() })
    container.remove()
    useRemoteThreadStore.setState({ helperView: false, threads: {} })
    Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", actEnvironment)
    if (ownedDom) await GlobalRegistrator.unregister()
  }
}

const text = (row: HTMLElement, attribute: string) => row.querySelector(`[${attribute}]`)?.textContent ?? null

test("a running task reads as a sentence with how long it has worked and the step it ran last, and opens like a helper", async () => {
  const opened: string[] = []
  const since = Date.now() - 12 * 60_000
  await withRow({ helperView: true, start: desktop, entry: entry(desktop, status(desktop, { latestStep: "Ran List Daytona sandboxes" }), since),
    onOpenRemoteTask: (start) => opened.push(start.key) }, async (row) => {
    expect(row.dataset.remoteThreadSentence).toBe("running")
    expect(text(row, "data-remote-thread-lead")).toBe("Working on Benjamin's Mac Studio")
    expect(text(row, "data-remote-thread-title")).toBe("Record 23 demo videos")
    expect(text(row, "data-remote-thread-detail")).toMatch(/^12m \ds, last ran: Ran List Daytona sandboxes$/)
    expect(row.querySelector(".ow-text-shimmer")).not.toBeNull()
    await act(async () => { row.querySelector<HTMLButtonElement>("button")?.click() })
    expect(opened).toEqual(["command:cmd_row"])
  })
})

test("a task waiting on the person reads in amber and says what it needs", async () => {
  await withRow({ helperView: true, start: desktop, entry: entry(desktop, status(desktop, { state: "waiting", waitingFor: "permission" }), Date.now()) }, (row) => {
    expect(row.dataset.remoteThreadSentence).toBe("waiting")
    expect(text(row, "data-remote-thread-lead")).toBe("Waiting for you on Benjamin's Mac Studio")
    expect(row.querySelector("[data-remote-thread-lead]")?.className).toContain("text-amber-11")
    expect(text(row, "data-remote-thread-detail")).toBe("Needs your approval")
    expect(row.querySelector(".ow-text-shimmer")).toBeNull()
  })
})

test("a finished Cloud task says where it ran and how long it took, without shimmer", async () => {
  const observedAt = Date.now()
  await withRow({ helperView: true, start: cloud, entry: entry(cloud, status(cloud, { state: "idle", observedAt, preview: "Done" }), observedAt - 4 * 60_000 - 3_000) }, (row) => {
    expect(row.dataset.remoteThreadSentence).toBe("done")
    expect(text(row, "data-remote-thread-lead")).toBe("Finished in the Cloud")
    expect(text(row, "data-remote-thread-title")).toBe("Draft the GA changelog")
    expect(text(row, "data-remote-thread-detail")).toBe("4m 3s")
    expect(row.querySelector(".ow-text-shimmer")).toBeNull()
  })
})

test("with the helper view off the row is today's row", async () => {
  await withRow({ helperView: false, start: desktop, entry: entry(desktop, status(desktop, { latestStep: "Ran List Daytona sandboxes" }), Date.now()) }, (row) => {
    expect(row.dataset.remoteThreadSentence).toBeUndefined()
    expect(row.textContent).toContain("Record 23 demo videos · Benjamin's Mac Studio")
    expect(row.textContent).not.toContain("last ran")
  })
})
