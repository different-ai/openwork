/** @jsxImportSource react */
import { afterAll, afterEach, beforeAll, expect, test } from "bun:test"
import { GlobalRegistrator } from "@happy-dom/global-registrator"
import { act } from "react"
import type { Root } from "react-dom/client"
import type { ComputerStatus } from "@openwork/types/desktop-ipc"

let createRoot: typeof import("react-dom/client")["createRoot"]
let ComputerUseSettings: typeof import("../src/react-app/domains/settings/pages/computer-use-view")["ComputerUseSettings"]
const ownedDom = !GlobalRegistrator.isRegistered && typeof document === "undefined"
let root: Root | null = null
let userAgent: PropertyDescriptor | undefined
beforeAll(async () => {
  if (ownedDom) GlobalRegistrator.register({ url: "http://localhost/" })
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true)
  // System permissions are shown only on a Mac.
  userAgent = Object.getOwnPropertyDescriptor(navigator, "userAgent")
  Object.defineProperty(navigator, "userAgent", { configurable: true, value: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)" })
  createRoot = (await import("react-dom/client")).createRoot
  ComputerUseSettings = (await import("../src/react-app/domains/settings/pages/computer-use-view")).ComputerUseSettings
})
afterEach(async () => {
  if (root) await act(async () => root?.unmount())
  root = null
  Reflect.deleteProperty(window, "__OPENWORK_ELECTRON__")
  document.body.innerHTML = ""
})
afterAll(async () => {
  if (userAgent) Object.defineProperty(navigator, "userAgent", userAgent)
  else Reflect.deleteProperty(navigator, "userAgent")
  if (ownedDom) await GlobalRegistrator.unregister()
})

const mac = { enabled: true, entry: { name: "OpenWork Computer Use", ours: true }, targetId: "local", targets: [{ id: "local", label: "This Mac", placement: "local" }], placement: "local" } satisfies Partial<ComputerStatus>

async function render(read: () => ComputerStatus | Promise<ComputerStatus>, enabled = true) {
  const calls: string[] = []
  Reflect.set(window, "__OPENWORK_ELECTRON__", { invokeDesktop: async (command: string) => {
    calls.push(command)
    if (command === "computerStatus") return read()
    if (command === "computerListFileGrants") return { enabled: false, grants: [] }
    return { setupId: "setup" }
  } })
  const element = document.createElement("div")
  document.body.append(element)
  root = createRoot(element)
  await act(async () => root?.render(<ComputerUseSettings enabled={enabled} />))
  return { element, calls }
}
const state = (element: Element, id: string) => element.querySelector(`[data-testid="settings-computer-${id}"]`)?.getAttribute("data-state")

test("setup names the one permission left, counts what is on and offers only that pane", async () => {
  const { element, calls } = await render(() => ({ ...mac, readiness: "setup-required", detail: "Open setup to review access.", permissions: { accessibility: true, screenRecording: false } }))
  expect(state(element, "status")).toBe("setup-required")
  expect(element.textContent).toContain("Turn on Screen Recording below.")
  expect(element.textContent).not.toContain("Open setup to review access.")
  expect(element.textContent).toContain("1 of 2 on")
  expect(state(element, "permission-accessibility")).toBe("done")
  expect(state(element, "permission-screenRecording")).toBe("todo")
  expect(element.querySelector('[data-testid="settings-computer-entry"]')?.textContent).toBe("OpenWork Computer Use")
  const buttons = [...element.querySelectorAll("button")].map((button) => button.textContent)
  expect(buttons).toEqual(["Open Screen Recording"])
  await act(async () => element.querySelector<HTMLButtonElement>("button")?.click())
  expect(calls).toContain("computerSetup")
  expect(state(element, "permission-screenRecording")).toBe("waiting")
  expect(element.textContent).toContain("Waiting for macOS")
})

test("ready speaks for every chat, not the helper's one-chat wording, and leaves nothing to open", async () => {
  const { element } = await render(() => ({ ...mac, readiness: "ready", detail: "Allow this chat to use supported apps.", permissions: { accessibility: true, screenRecording: true } }))
  expect(state(element, "status")).toBe("ready")
  expect(element.textContent).toContain("Every chat can use apps on this computer.")
  expect(element.textContent).not.toContain("Allow this chat")
  expect(element.textContent).toContain("2 of 2 on")
  expect(element.querySelector("button")).toBeNull()
})

test("a computer that cannot be set up shows the helper's reason and no macOS permissions", async () => {
  const { element } = await render(() => ({ ...mac, readiness: "unsupported", detail: "This Mac requires macOS 14 or later for Computer Use." }))
  expect(state(element, "status")).toBe("unsupported")
  expect(element.textContent).toContain("This Mac requires macOS 14 or later")
  expect(element.textContent).not.toContain("macOS permissions")
})

test("a failed check is reported as unavailable with its cause, never as a permission state", async () => {
  const { element } = await render(() => { throw new Error("The helper did not answer.") })
  expect(state(element, "status")).toBe("unavailable")
  expect(element.textContent).toContain("Couldn't check this computer. The helper did not answer.")
  expect(element.querySelector('[data-testid^="settings-computer-permission-"]')).toBeNull()
})

test("while the first check runs the summary holds its place without claiming a state", async () => {
  const { element } = await render(() => new Promise<ComputerStatus>(() => {}))
  expect(state(element, "status")).toBe("checking")
  expect(element.querySelector('[data-testid="settings-computer-status"]')?.textContent).toBe("Checking")
  expect(element.textContent).not.toContain("Ready")
})

test("turned off, the page says so and asks the helper nothing", async () => {
  const { element, calls } = await render(() => { throw new Error("must not be read") }, false)
  expect(element.textContent).toContain("Computer use isn't turned on in this app.")
  expect(element.querySelector('[data-testid="settings-computer-status"]')).toBeNull()
  expect(calls).not.toContain("computerStatus")
})
