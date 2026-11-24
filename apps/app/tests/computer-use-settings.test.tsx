/** @jsxImportSource react */
import { afterAll, afterEach, beforeAll, expect, test } from "bun:test"
import { GlobalRegistrator } from "@happy-dom/global-registrator"
import { act } from "react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type { Root } from "react-dom/client"
import type { ComputerStatus, PrivateValueSettings } from "@openwork/types/desktop-ipc"

let createRoot: typeof import("react-dom/client")["createRoot"]
let ComputerUseSettings: typeof import("../src/react-app/domains/settings/pages/computer-use-view")["ComputerUseSettings"]
let PrivateValues: typeof import("../src/react-app/domains/settings/pages/computer-use-view")["PrivateValues"]
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
  ;({ ComputerUseSettings, PrivateValues } = await import("../src/react-app/domains/settings/pages/computer-use-view"))
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
  await act(async () => root?.render(<QueryClientProvider client={new QueryClient()}><ComputerUseSettings enabled={enabled} /></QueryClientProvider>))
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

const NOTHING_SET: PrivateValueSettings = { enabled: true, switches: { commands: true, paste: true, keep: true }, organization: { fills: null, commands: null, paste: null }, always: [], kept: [], recent: [] }

/** The list is read through the query cache, which tells React on a later tick than the click that caused it. */
async function settled(action: () => void) {
  await act(async () => action())
  for (let tick = 0; tick < 5; tick++) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
}

async function renderValues(initial: PrivateValueSettings | Error) {
  let current = initial
  const calls: unknown[][] = []
  Reflect.set(window, "__OPENWORK_ELECTRON__", { invokeDesktop: async (command: string, ...args: unknown[]) => {
    calls.push([command, ...args])
    if (current instanceof Error) throw current
    if (command === "computerSetPrivateValueSwitch") current = { ...current, switches: { ...current.switches, [String(args[0])]: args[1] === true } }
    if (command === "computerRemovePrivateValue") current = { ...current, always: current.always.filter((entry) => entry.id !== args[1]), kept: current.kept.filter((entry) => entry.id !== args[1]) }
    return command === "computerListPrivateValues" ? current : { ok: true }
  } })
  const element = document.createElement("div")
  document.body.append(element)
  root = createRoot(element)
  await settled(() => root?.render(<QueryClientProvider client={new QueryClient()}><PrivateValues /></QueryClientProvider>))
  const row = (name: string) => element.querySelector<HTMLElement>(`[data-testid="settings-private-values-${name}"]`)
  const toggle = (name: string) => row(name)?.querySelector<HTMLButtonElement>('[role="switch"]') ?? null
  const locked = (name: string) => toggle(name)?.hasAttribute("data-disabled") ?? null
  return { element, calls, row, toggle, locked, set: (next: PrivateValueSettings | Error) => { current = next } }
}

test("private values are not shown until the app is told they are on, or when it cannot tell", async () => {
  for (const state of [{ ...NOTHING_SET, enabled: false }, new Error("offline")]) {
    const { element } = await renderValues(state)
    expect(element.textContent).not.toContain("Private values")
    expect(element.querySelector('[role="switch"]')).toBeNull()
    await act(async () => root?.unmount())
  }
})

test("the three switches show what is on, and turning one off tells the app and reads the answer back", async () => {
  const { element, calls, toggle, locked } = await renderValues(NOTHING_SET)
  expect(element.textContent).toContain("You approve every fill on a card in the chat.")
  expect(["commands", "paste", "keep"].map((name) => toggle(name)?.getAttribute("aria-checked"))).toEqual(["true", "true", "true"])
  expect(element.querySelector('[data-testid="settings-private-values-organization"]')).toBeNull()
  expect(element.textContent).not.toContain("Set by your organization")
  await settled(() => toggle("paste")?.click())
  expect(calls).toContainEqual(["computerSetPrivateValueSwitch", "paste", false])
  // Nothing pasted is kept once pasting is off, so that switch is off and cannot be turned on.
  expect(["paste", "keep"].map((name) => toggle(name)?.getAttribute("aria-checked"))).toEqual(["false", "false"])
  expect(locked("keep")).toBe(true)
  expect(locked("commands")).toBe(false)
})

test("what the organization set is locked and says so, and what it blocks reads as off", async () => {
  const { element, toggle, locked, row, calls } = await renderValues({ ...NOTHING_SET, organization: { fills: "ask", commands: "limited", paste: "blocked" },
    always: [{ id: "g1", sessionId: "chat-1", site: "https://ops.example.com", field: "password", command: "security find-generic-password -s ops -w", blocked: true }] })
  expect(element.querySelector('[data-testid="settings-private-values-organization"]')?.textContent).toBe("Your organization asks you before every fill, so Always isn't offered.")
  expect([locked("commands"), locked("paste"), locked("keep")]).toEqual([false, true, true])
  expect(["paste", "keep"].map((name) => toggle(name)?.getAttribute("aria-checked"))).toEqual(["false", "false"])
  expect(row("commands")?.textContent).toContain("Some commands are set by your organization")
  expect(row("paste")?.textContent).toContain("Set by your organization")
  expect(row("always")?.textContent).toContain("Blocked by your organization")
  await settled(() => toggle("paste")?.click())
  expect(calls.filter(([command]) => command === "computerSetPrivateValueSwitch")).toEqual([])
})

test("with fills blocked by the organization, every switch is off and locked", async () => {
  const { element, toggle, locked } = await renderValues({ ...NOTHING_SET, organization: { fills: "blocked", commands: null, paste: null } })
  expect(element.querySelector('[data-testid="settings-private-values-organization"]')?.textContent).toBe("Your organization blocks filling private values on websites.")
  expect(["commands", "paste", "keep"].map((name) => [toggle(name)?.getAttribute("aria-checked"), locked(name)])).toEqual([["false", true], ["false", true], ["false", true]])
})

test("every Always, kept value and recent fill is listed without a value, and one can be removed", async () => {
  const { element, calls } = await renderValues({ ...NOTHING_SET,
    always: [{ id: "g1", sessionId: "chat-1", site: "https://bank.example.com", field: "password", command: "bw get password bank.example.com", blocked: false }],
    kept: [{ id: "k1", sessionId: "chat-1", site: "https://bank.example.com", label: "Sign-in code" }, { id: "k2", sessionId: "chat-1", program: "bw", label: "Bitwarden session key" }],
    recent: [{ at: Date.UTC(2026, 0, 5, 17, 4), sessionId: "chat-1", site: "https://bank.example.com", field: "password", source: "command", program: "bw", result: "filled" },
      { at: Date.UTC(2026, 0, 5, 17, 2), sessionId: "chat-1", site: "https://bank.example.com", field: "text", source: "paste", result: "value_mismatch" },
      { at: Date.UTC(2026, 0, 5, 17, 1), sessionId: "chat-2", site: "https://ops.example.com", field: "password", source: "command", program: "op", result: "blocked" }] })
  const all = (name: string) => [...element.querySelectorAll<HTMLElement>(`[data-testid="settings-private-values-${name}"]`)]
  expect(all("always").map((row) => row.textContent)).toEqual(["https://bank.example.comThe password field, from bw get password bank.example.comRemove"])
  expect(all("kept").map((row) => row.textContent)).toEqual(["Sign-in codehttps://bank.example.comForget", "Bitwarden session keyA key for bwForget"])
  expect(all("recent").map((row) => row.getAttribute("data-result"))).toEqual(["filled", "value_mismatch", "blocked"])
  expect(all("recent")[0]?.textContent).toContain("The password field, from a command (bw)")
  expect(all("recent")[0]?.textContent).toContain("Filled")
  expect(all("recent")[1]?.textContent).toContain("Not filled")
  expect(all("recent")[2]?.textContent).toContain("Blocked by your organization")
  await settled(() => all("kept")[1]?.querySelector("button")?.click())
  expect(calls).toContainEqual(["computerRemovePrivateValue", "kept", "k2"])
  expect(all("kept").map((row) => row.textContent)).toEqual(["Sign-in codehttps://bank.example.comForget"])
  await settled(() => all("always")[0]?.querySelector("button")?.click())
  expect(calls).toContainEqual(["computerRemovePrivateValue", "always", "g1"])
  expect(all("always")).toEqual([])
})

test("a switch that could not be changed says so and stays as it was", async () => {
  const { element, toggle, set } = await renderValues(NOTHING_SET)
  set(new Error("The settings file is locked."))
  await settled(() => toggle("commands")?.click())
  expect(element.querySelector('[role="alert"]')?.textContent).toBe("Couldn't change the setting. Try again. The settings file is locked.")
  expect(toggle("commands")?.getAttribute("aria-checked")).toBe("true")
})
