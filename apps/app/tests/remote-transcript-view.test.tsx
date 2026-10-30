import { afterAll, expect, test } from "bun:test"
import { GlobalRegistrator } from "@happy-dom/global-registrator"
import { act, type ReactNode } from "react"
import { createRoot } from "react-dom/client"

GlobalRegistrator.register({ url: "http://localhost/" })
const previousAct = Reflect.get(globalThis, "IS_REACT_ACT_ENVIRONMENT")
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true)
afterAll(() => {
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", previousAct)
  GlobalRegistrator.unregister()
})

const { PlatformProvider, createDefaultPlatform } = await import("../src/react-app/kernel/platform")
const { parseRemoteRead } = await import("../src/lib/remote-session-thread")
const { remoteTranscriptToUIMessages } = await import("../src/lib/remote-transcript-messages")
const { RemoteFollowUpComposer } = await import("../src/react-app/domains/session/remote-threads/remote-follow-up-composer")
const { RemoteTranscriptView } = await import("../src/react-app/domains/session/remote-threads/remote-transcript-view")

const payload = {
  messages: [
    { id: "msg_user", role: "user", createdAt: 1_000, text: "Check the repo", toolCalls: [] },
    {
      id: "msg_reply", role: "assistant", createdAt: 1_100, completedAt: 44_000, text: "The repo has two files.", toolCalls: [],
      parts: [
        { type: "tool", id: "prt_ls", name: "bash", status: "completed", input: "{\"command\":\"ls\",\"description\":\"List files\"}", output: "a\nb", error: null, truncated: false },
        { type: "text", text: "The repo has two files." },
      ],
    },
    { id: "msg_user_2", role: "user", createdAt: 50_000, text: "Read the notes", toolCalls: [] },
    {
      id: "msg_reply_2", role: "assistant", createdAt: 50_100, completedAt: 52_000, text: "There are no notes.", toolCalls: [],
      parts: [
        { type: "tool", id: "prt_read", name: "read", status: "error", input: "{\"filePath\":\"/repo/missing-notes.md\"}", output: null, error: "ENOENT: no such file", truncated: false },
        { type: "text", text: "There are no notes." },
      ],
    },
  ],
}

async function render(node: ReactNode, check: (container: HTMLElement) => Promise<void> | void) {
  const container = document.createElement("div")
  document.body.append(container)
  const root = createRoot(container)
  try {
    await act(async () => { root.render(<PlatformProvider value={createDefaultPlatform()}>{node}</PlatformProvider>) })
    await check(container)
  } finally {
    await act(async () => { root.unmount() })
    container.remove()
  }
}

function messages() {
  const outcome = parseRemoteRead(payload)
  if (outcome.kind !== "page") throw new Error("expected a page")
  return remoteTranscriptToUIMessages(outcome.page.messages, { running: false })
}

test("a finished remote turn renders through the chat renderer, folded to Worked for", async () => {
  await render(<RemoteTranscriptView threadKey="command:cmd_1" messages={messages()} running={false} showThinking={false} developerMode={false} />, async (container) => {
    const fold = container.querySelector<HTMLElement>("[data-testid='completed-work-rail']")
    // The finished turn folds; the one with a failed step stays open with it in view (T2).
    const folds = container.querySelectorAll<HTMLElement>("[data-testid='completed-work-rail']")
    expect(folds.length).toBe(1)
    expect(fold?.textContent).toContain("Worked for 43s")
    expect(container.textContent).toContain("The repo has two files.")
    expect(container.textContent).toContain("missing-notes.md")
    expect(container.textContent).toContain("There are no notes.")
    // Read only: the turns carry no branch action.
    expect(container.textContent).not.toContain("Branch in new chat")
  })
})

test("the follow-up composer sends with Enter and becomes Stop while the task runs", async () => {
  const sent: string[] = []
  let stopped = 0
  await render(
    <RemoteFollowUpComposer draft="Also count lines" onDraftChange={() => {}} onSend={() => sent.push("send")} onStop={() => { stopped += 1 }}
      computer="Studio Mac" running disabled={false} sending={false} stopping={false} error={null} />,
    async (container) => {
      const box = container.querySelector("textarea")
      await act(async () => { box?.focus() })
      await act(async () => { box?.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })) })
      expect(sent).toEqual(["send"])
      const button = container.querySelector<HTMLButtonElement>("button[aria-label='Stop']")
      expect(button).not.toBeNull()
      await act(async () => { button?.click() })
      expect(stopped).toBe(1)
      expect(container.textContent).toContain("Studio Mac")
    },
  )
})
