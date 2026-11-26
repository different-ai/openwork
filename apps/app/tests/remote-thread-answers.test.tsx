import { expect, test } from "bun:test"
import { GlobalRegistrator } from "@happy-dom/global-registrator"
import type { DynamicToolUIPart } from "ai"
import type { RemoteSessionAnswerInput, RemoteSessionPending, RemoteSessionPendingSummary, RemoteSessionThreadStatus } from "@openwork/types/automations"
import { act, type ReactNode } from "react"
import { createRoot } from "react-dom/client"
import { MessageListProvider } from "../src/components/chat/message-list-provider"
import { RemoteThreadRunLine } from "../src/components/chat/remote-thread-run-line"
import { rowQuestionOptions } from "../src/lib/remote-session-answers"
import type { RemoteThreadStart } from "../src/lib/remote-session-thread"
import { RemoteThreadAnswerCard } from "../src/react-app/domains/session/remote-threads/remote-thread-answer-card"
import { useRemoteThreadStore } from "../src/react-app/domains/session/remote-threads/remote-thread-store"

const question: RemoteSessionPending = {
  kind: "question", requestId: "que_1", questions: [{
    header: "", question: "Which branch should I release from?", multiple: false, custom: false,
    options: [{ label: "dev", description: "The default branch" }, { label: "main", description: "" }],
  }],
}
const permission: RemoteSessionPending = { kind: "permission", requestId: "per_1", title: "Run a command", detail: "Run the tests", command: "pnpm test" }

async function render(node: ReactNode, check: (container: HTMLElement) => Promise<void> | void) {
  const ownedDom = typeof window === "undefined"
  if (ownedDom) GlobalRegistrator.register({ url: "http://localhost/" })
  const actEnvironment = Reflect.get(globalThis, "IS_REACT_ACT_ENVIRONMENT")
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true)
  const container = document.createElement("div")
  document.body.append(container)
  const root = createRoot(container)
  try {
    await act(async () => { root.render(node) })
    await check(container)
  } finally {
    await act(async () => { root.unmount() })
    container.remove()
    Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", actEnvironment)
    if (ownedDom) await GlobalRegistrator.unregister()
  }
}

function key(target: Element, init: KeyboardEventInit) {
  target.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init }))
}

function button(container: HTMLElement, label: string) {
  const control = [...container.querySelectorAll("button")].find((candidate) => candidate.textContent?.trim() === label)
  if (!control) throw new Error(`Missing button: ${label}`)
  return control
}

test("a remote question uses the workspace question panel and submits to the remote request", async () => {
  const sent: RemoteSessionAnswerInput[] = []
  await render(<RemoteThreadAnswerCard pending={question} computer="Studio Mac" onAnswer={async (answer) => { sent.push(answer); return null }} />, async (container) => {
    expect(container.textContent).toContain("Question from Studio Mac")
    expect(container.querySelector("[data-question-variant=thread]")?.textContent).toContain("Which branch should I release from?")
    expect(container.querySelector("a")).toBeNull()
    expect(button(container, "Submit").disabled).toBe(true)
    const main = button(container, "main")
    await act(async () => { main.click() })
    expect(main.getAttribute("aria-checked")).toBe("true")
    expect(sent).toEqual([])
    await act(async () => { button(container, "Submit").click() })
    expect(sent).toEqual([{ kind: "question", requestId: "que_1", answers: [["main"]] }])
    expect(container.querySelector("[data-remote-answer]")).toBeNull()
  })
})

test("an unconfirmed permission cannot be sent again from the old card", async () => {
  let attempts = 0
  await render(<RemoteThreadAnswerCard pending={permission} computer="Studio Mac" onAnswer={async () => {
    attempts++
    return { code: "desktop_request_pending", message: "Check the task before answering again.", retryable: false }
  }} />, async (container) => {
    await act(async () => { button(container, "Allow once").click() })
    expect(container.querySelector("[data-remote-answer-error]")?.textContent).toContain("Check the task before answering again.")
    expect(container.textContent).not.toContain("Try again")
    expect(button(container, "Allow once").disabled).toBe(true)
    expect(button(container, "Deny").disabled).toBe(true)
    expect(attempts).toBe(1)
  })
})

test("a permission names its command; ⌘Enter allows once and Deny rejects, never always", async () => {
  const sent: RemoteSessionAnswerInput[] = []
  await render(<RemoteThreadAnswerCard pending={permission} computer="Studio Mac" onAnswer={async (answer) => { sent.push(answer); return { code: "x", message: "Try later", retryable: true } }} />, async (container) => {
    const card = container.querySelector("[data-remote-answer=permission]")
    expect(card?.textContent).toContain("Permission on Studio Mac")
    expect(card?.querySelector("[data-permission-approval] pre")?.textContent).toBe("pnpm test")
    expect(card?.textContent).not.toContain("Allow for this session")
    expect(card?.textContent).not.toContain("Always allow")
    await act(async () => { if (card) key(card, { key: "Enter", metaKey: true }) })
    const deny = [...container.querySelectorAll("button")].find((button) => button.textContent === "Deny")
    await act(async () => { deny?.click() })
    expect(sent).toEqual([{ kind: "permission", requestId: "per_1", decision: "once" }, { kind: "permission", requestId: "per_1", decision: "reject" }])
  })
})

test("a row offers buttons only for one single-choice question", () => {
  const summary: Extract<RemoteSessionPendingSummary, { kind: "question" }> = {
    kind: "question", requestId: "que_1", question: "Which?", options: ["a", "b", "c", "d", "e"], multiple: false, custom: false, questionCount: 1,
  }
  expect(rowQuestionOptions(summary)).toEqual({ requestId: "que_1", options: ["a", "b", "c", "d"] })
  expect(rowQuestionOptions({ ...summary, multiple: true })).toBeNull()
  expect(rowQuestionOptions({ ...summary, questionCount: 2 })).toBeNull()
  expect(rowQuestionOptions({ kind: "permission", requestId: "per_1", title: "Run a command" })).toBeNull()
})

const start: RemoteThreadStart = {
  key: "command:cmd_answers", ref: { commandId: "cmd_answers" }, toolCallId: "call_answers", title: "Release notes",
  prompt: "Release notes", target: "desktop", sessionId: "ses_1", workspaceId: "ws_1", computerId: null,
}
const part: DynamicToolUIPart = { type: "dynamic-tool", toolName: "remote-session:create", toolCallId: "call_answers", state: "output-available", input: {}, output: {} }
const waiting: RemoteSessionThreadStatus = {
  ref: "cmd_answers", changed: true, version: "v1", target: "desktop", state: "waiting", waitingFor: "question", title: "Release notes",
  computerId: null, computerLabel: "Studio Mac", sessionId: "ses_1", workspaceId: "ws_1", messageCount: 2, preview: null, error: null, observedAt: 1,
  pending: { kind: "question", requestId: "que_1", question: "Which branch?", options: ["dev", "main"], multiple: false, custom: false, questionCount: 1 },
}

async function row(check: (container: HTMLElement) => void) {
  useRemoteThreadStore.setState({
    threads: { [start.key]: { start, organizationId: "org_1", version: "v1", status: waiting, stale: false, checkedAt: 1, activeSince: null,
      firstSeenAt: Date.now(), followedUpAt: null, owners: {}, viewers: 1, lastViewedAt: Date.now() } },
  })
  try {
    await render(
      <MessageListProvider workspaceId="workspace-1" sessionId="session-1"
        showThinking={false} developerMode={false} displaySuggestions={false} providerConnectedCount={1}
        onRevertToUserMessage={() => {}} onForkAtMessage={() => {}} onEditUserMessage={() => {}}
        onMcpReconnect={async () => "connected"} onMcpReopenAuthorization={async () => {}}
        dispatchAction={() => {}} setPrompt={() => {}}>
        <RemoteThreadRunLine start={start} part={part} />
      </MessageListProvider>,
      check,
    )
  } finally {
    useRemoteThreadStore.setState({ threads: {} })
  }
}

test("a single-choice question shows its options and Other answer… on the row", async () => {
  await row((container) => {
    const buttons = [...container.querySelectorAll("[data-remote-thread-answers] button")].map((button) => button.textContent)
    expect(buttons).toEqual(["dev", "main", "Other answer…"])
  })
})
