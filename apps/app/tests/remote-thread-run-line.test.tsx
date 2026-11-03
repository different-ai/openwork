import { expect, test } from "bun:test"
import { GlobalRegistrator } from "@happy-dom/global-registrator"
import type { DynamicToolUIPart } from "ai"
import { act } from "react"
import { createRoot } from "react-dom/client"
import { MessageListProvider } from "../src/components/chat/message-list-provider"
import { RemoteThreadRunLine } from "../src/components/chat/remote-thread-run-line"
import type { RemoteThreadStart } from "../src/lib/remote-session-thread"
import { usePanelTabStore } from "../src/react-app/domains/session/panel/panel-tab-store"
import { useRemoteThreadStore } from "../src/react-app/domains/session/remote-threads/remote-thread-store"

const start: RemoteThreadStart = {
  key: "command:cmd_1",
  ref: { commandId: "cmd_1" },
  toolCallId: "call_1",
  title: "Summarize the report",
  prompt: "Summarize the report",
  target: "desktop",
  sessionId: null,
  workspaceId: null,
  computerId: null,
}

const part = { type: "dynamic-tool", toolName: "remote-session:create", toolCallId: "call_1", state: "output-available", input: {}, output: {} } as unknown as DynamicToolUIPart

// The store is read on the client; server rendering only sees its initial state.
async function withRow(check: (row: HTMLElement) => Promise<void> | void) {
  const ownedDom = typeof window === "undefined"
  if (ownedDom) GlobalRegistrator.register({ url: "http://localhost/" })
  const actEnvironment = Reflect.get(globalThis, "IS_REACT_ACT_ENVIRONMENT")
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true)
  const container = document.createElement("div")
  document.body.append(container)
  const root = createRoot(container)
  try {
    await act(async () => {
      root.render(<MessageListProvider workspaceId="workspace-1" sessionId="session-1"
        showThinking={false} developerMode={false} displaySuggestions={false} providerConnectedCount={1}
        onRevertToUserMessage={() => {}} onForkAtMessage={() => {}} onEditUserMessage={() => {}}
        onMcpReconnect={async () => "connected"} onMcpReopenAuthorization={async () => {}}
        dispatchAction={() => {}} setPrompt={() => {}}>
        <RemoteThreadRunLine start={start} part={part} />
      </MessageListProvider>)
    })
    const row = container.querySelector<HTMLElement>("[data-remote-thread]")
    expect(row?.textContent).toContain("Summarize the report")
    await check(row!)
  } finally {
    await act(async () => { root.unmount() })
    container.remove()
    Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", actEnvironment)
    if (ownedDom) await GlobalRegistrator.unregister()
  }
}

test("the row opens the task's conversation beside the chat", async () => {
  await withRow(async (row) => {
    const open = row.querySelector("button")
    expect(open?.getAttribute("aria-label")).toContain("Open the task on")
    await act(async () => { open?.click() })
    const tabs = usePanelTabStore.getState().sessions["session-1"]?.tabs ?? []
    expect(tabs.map((tab) => tab.id)).toContain("remote-thread:command:cmd_1")
  })
})
