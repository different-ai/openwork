import { afterAll, afterEach, expect, test } from "bun:test"
import { GlobalRegistrator } from "@happy-dom/global-registrator"
import { act } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { BackgroundTaskNotice, BackgroundTasksLabel } from "../src/components/chat/background-tasks"
import { useBackgroundShellStore } from "../src/react-app/domains/session/status/background-shell-store"

afterEach(() => useBackgroundShellStore.getState().setEnabled(false))

test("an uncertain count says last known with its age and overrides an enclosing live shimmer", () => {
  const html = renderToStaticMarkup(<span className="ow-text-shimmer"><BackgroundTasksLabel shimmer={false} shells={[{
    id: "sh_fixture", sessionId: "ses_fixture", command: "export-report", startedAt: Date.now() - 60_000, observedAt: Date.now() - 60_000, checkedAt: Date.now() - 30_000, stale: true,
  }]} /></span>)
  expect(html).toContain("1 background task last known running")
  expect(html).toContain("checked")
  expect(html).toContain("couldn&#x27;t verify")
  expect(html).toContain("text-muted-foreground")
  expect(html.match(/ow-text-shimmer/g)).toHaveLength(1)
})

const ownedDom = typeof document === "undefined"
if (ownedDom) GlobalRegistrator.register({ url: "http://localhost/" })
afterAll(async () => { if (ownedDom) await GlobalRegistrator.unregister() })

test("failed commands give output-review direction while the raw exit code stays disclosed", async () => {
  const { createRoot } = await import("react-dom/client")
  const container = document.createElement("div")
  document.body.append(container)
  const root = createRoot(container)
  const previousAct = Reflect.get(globalThis, "IS_REACT_ACT_ENVIRONMENT")
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true)
  try {
    useBackgroundShellStore.getState().setEnabled(true)
    await act(async () => root.render(<BackgroundTaskNotice message={{ id: "msg_fixture", role: "system", parts: [] }} notice={{ shellId: "sh_fixture", command: "export-report", outcome: "failed", exit: 2 }} />))
    const html = container.innerHTML
    expect(html).toContain("Background task failed")
    expect(html).toContain("review the command")
    expect(html).toContain("Technical details")
    expect(html).not.toContain("Exit code: 2")
    expect(html).not.toContain("exit 2")
  } finally {
    await act(async () => root.unmount())
    container.remove()
    Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", previousAct)
  }
})
