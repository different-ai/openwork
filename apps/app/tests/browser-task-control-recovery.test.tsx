import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test"
import { GlobalRegistrator } from "@happy-dom/global-registrator"
import { act } from "react"
import type { Root } from "react-dom/client"
import type { BrowserPanelTab } from "@openwork/browser-tabs"
import { TooltipProvider } from "../src/components/ui/tooltip"
import { BrowserPanelContent } from "../src/react-app/domains/session/panel/side-panel"

const ownedDom = typeof document === "undefined"
let root: Root | null = null
let container: HTMLDivElement
let createRoot: typeof import("react-dom/client")["createRoot"]
let previousAct: unknown
const calls: Array<{ tabId: string; action: string }> = []
let control: () => Promise<void>
const tab: BrowserPanelTab = { id: "tab_owned", type: "browser", label: "Notes", url: "https://fixture.example", favicon: null, status: "ready", canGoBack: false, canGoForward: false, ownerSessionId: "ses_owner", browserTask: { status: "running", operation: "observe" }, siteToolCount: 0, siteTools: [], siteToolActivity: [] }
beforeAll(async () => {
  if (ownedDom) GlobalRegistrator.register({ url: "http://localhost/" })
  createRoot = (await import("react-dom/client")).createRoot
})
afterAll(async () => { if (ownedDom) await GlobalRegistrator.unregister() })
beforeEach(() => {
  previousAct = Reflect.get(globalThis, "IS_REACT_ACT_ENVIRONMENT")
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true)
  calls.length = 0
  control = async () => {}
  window.__OPENWORK_ELECTRON__ = { browser: {
    hide: async () => {}, setBounds: async () => {},
    taskControl: async (tabId, action) => { calls.push({ tabId, action }); await control() },
  } }
  container = document.createElement("div"); document.body.append(container)
  root = createRoot(container)
})
afterEach(async () => {
  if (root) await act(async () => root?.unmount())
  root = null; document.body.innerHTML = ""
  delete window.__OPENWORK_ELECTRON__
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", previousAct)
})
async function render(next = tab, sessionId = "ses_owner") {
  await act(async () => root?.render(<TooltipProvider><BrowserPanelContent sessionId={sessionId} tab={next} onClose={() => {}} /></TooltipProvider>))
}
async function click(label: string) {
  const button = [...container.querySelectorAll("button")].find((item) => item.textContent === label)
  if (!button) throw new Error(`Missing ${label}`)
  await act(async () => button.click())
  return button
}

test("Take over shows pending, waits for confirmed browser state, and exposes IPC rejection in recovery", async () => {
  let reject: (error: Error) => void = () => {}
  control = () => new Promise((_, refuse) => { reject = refuse })
  await render()
  const button = await click("Take over")
  expect(button.disabled).toBe(true)
  expect(container.textContent).toContain("Requesting control")
  expect(container.textContent).not.toContain("You have control")
  await act(async () => reject(new Error("Select this conversation first.")))
  expect(container.textContent).toContain("Could not take over this browser. Try again.")
  expect(button.disabled).toBe(false)
  expect(calls).toEqual([{ tabId: "tab_owned", action: "pause" }])
  control = async () => {}
  await click("Take over")
  expect(container.textContent).toContain("Control requested · waiting for the browser")
  await render({ ...tab, browserTask: { status: "paused", operation: null } })
  expect(container.textContent).toContain("You have control")
  expect(container.textContent).toContain("Resume browser")
})

test("Resume failure leaves human control intact and recovery is scoped to its conversation", async () => {
  const paused: BrowserPanelTab = { ...tab, browserTask: { status: "paused", operation: null } }
  control = async () => { throw new Error("Fixture IPC rejected") }
  await render(paused)
  await click("Resume browser")
  expect(container.textContent).toContain("Could not resume this browser. Try again.")
  expect(container.textContent).toContain("You have control")
  await render({ ...tab, id: "tab_other", ownerSessionId: "ses_other" }, "ses_other")
  expect(container.textContent).not.toContain("Could not resume")
  expect(calls).toEqual([{ tabId: "tab_owned", action: "resume" }])
})

test("an accepted request settles while off screen but still waits for native control confirmation", async () => {
  let accept: () => void = () => {}
  control = () => new Promise((resolve) => { accept = resolve })
  await render()
  await click("Take over")
  await render({ ...tab, id: "tab_other", ownerSessionId: "ses_other" }, "ses_other")
  await act(async () => accept())
  expect(container.textContent).not.toContain("Control requested")
  await render()
  expect(container.textContent).toContain("Control requested · waiting for the browser")
  expect(container.textContent).not.toContain("You have control")
  await render({ ...tab, browserTask: { status: "paused", operation: null } })
  expect(container.textContent).toContain("You have control")
})

test("an old IPC rejection cannot replace the next conversation's status", async () => {
  let reject: (error: Error) => void = () => {}
  control = () => new Promise((_, refuse) => { reject = refuse })
  await render()
  await click("Take over")
  await render({ ...tab, id: "tab_other", ownerSessionId: "ses_other" }, "ses_other")
  await act(async () => reject(new Error("Old owner refused")))
  expect(container.textContent).not.toContain("Could not take over")
  expect(container.textContent).not.toContain("Requesting control")
  await render()
  const button = [...container.querySelectorAll("button")].find((item) => item.textContent === "Take over")
  expect(button?.disabled).toBe(false)
  expect(container.textContent).not.toContain("Requesting control")
})
