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

test("a question reads as text with numbered options; a number key chooses and Enter sends", async () => {
  const sent: RemoteSessionAnswerInput[] = []
  await render(<RemoteThreadAnswerCard pending={question} computer="Studio Mac" onAnswer={async (answer) => { sent.push(answer); return null }} />, async (container) => {
    const card = container.querySelector("[data-remote-answer=question]")
    expect(card?.textContent).toContain("Question from Studio Mac")
    expect(card?.textContent).toContain("Which branch should I release from?")
    expect(card?.querySelectorAll("svg").length).toBe(0)
    expect(card?.querySelector("a")).toBeNull()
    const send = [...(card?.querySelectorAll("button") ?? [])].find((button) => button.textContent === "Send answer")
    expect(send?.hasAttribute("disabled")).toBe(true)
    await act(async () => { if (card) key(card, { key: "2" }) })
    expect(card?.querySelector("[data-remote-answer-option=main]")?.getAttribute("aria-checked")).toBe("true")
    await act(async () => { if (card) key(card, { key: "Enter" }) })
    expect(sent).toEqual([{ kind: "question", requestId: "que_1", answers: [["main"]] }])
    expect(container.querySelector("[data-remote-answer]")).toBeNull()
  })
})

test("a failed answer stays on the card with the reason and a retry", async () => {
  let attempts = 0
  await render(<RemoteThreadAnswerCard pending={question} computer="Studio Mac" onAnswer={async () => {
    attempts++
    return attempts === 1 ? { code: "stale_request", message: "That question is no longer pending.", retryable: false } : null
  }} />, async (container) => {
    const card = container.querySelector("[data-remote-answer=question]")
    await act(async () => { container.querySelector<HTMLButtonElement>("[data-remote-answer-option=dev]")?.click() })
    await act(async () => { if (card) key(card, { key: "Enter" }) })
    expect(container.querySelector("[data-remote-answer-error]")?.textContent).toContain("Couldn't send your answer: That question is no longer pending.")
    const retry = [...container.querySelectorAll("button")].find((button) => button.textContent === "Try again")
    await act(async () => { retry?.click() })
    expect(attempts).toBe(2)
    expect(container.querySelector("[data-remote-answer]")).toBeNull()
  })
})

test("a permission names its command; ⌘Enter allows once and Deny rejects, never always", async () => {
  const sent: RemoteSessionAnswerInput[] = []
  await render(<RemoteThreadAnswerCard pending={permission} computer="Studio Mac" onAnswer={async (answer) => { sent.push(answer); return { code: "x", message: "Try later", retryable: true } }} />, async (container) => {
    const card = container.querySelector("[data-remote-answer=permission]")
    expect(card?.textContent).toContain("Permission on Studio Mac")
    expect(card?.querySelector("pre")?.textContent).toBe("pnpm test")
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

async function row(answers: boolean, check: (container: HTMLElement) => void) {
  useRemoteThreadStore.setState({
    enabled: true, threadView: true, answers,
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
    useRemoteThreadStore.setState({ enabled: false, threadView: false, answers: false, threads: {} })
  }
}

test("flag off: a waiting row looks exactly as before, with no answer buttons", async () => {
  await row(false, (container) => {
    expect(container.querySelector("[data-remote-thread=\"command:cmd_answers\"]")?.textContent).toContain("Waiting for your answer on Studio Mac")
    expect(container.querySelector("[data-remote-thread-answers]")).toBeNull()
    expect(container.firstElementChild?.getAttribute("data-remote-thread")).toBe("command:cmd_answers")
  })
})

test("flag on: a single-choice question shows its options and Other answer… on the row", async () => {
  await row(true, (container) => {
    const buttons = [...container.querySelectorAll("[data-remote-thread-answers] button")].map((button) => button.textContent)
    expect(buttons).toEqual(["dev", "main", "Other answer…"])
  })
})
