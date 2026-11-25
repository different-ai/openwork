/** @jsxImportSource react */
import { afterAll, afterEach, beforeAll, expect, test } from "bun:test"
import { GlobalRegistrator } from "@happy-dom/global-registrator"
import { act } from "react"
import type { Root } from "react-dom/client"
import { MemoryRouter, Route, Routes, useLocation } from "react-router"
import type { ComputerRequest } from "@openwork/types/desktop-ipc"

let createRoot: typeof import("react-dom/client")["createRoot"]
let ComputerRequestPanel: typeof import("../src/react-app/domains/session/computer/computer-request-panel")["ComputerRequestPanel"]
const ownedDom = !GlobalRegistrator.isRegistered && typeof document === "undefined"
beforeAll(async () => {
  if (ownedDom) GlobalRegistrator.register({ url: "http://localhost/" })
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true)
  createRoot = (await import("react-dom/client")).createRoot
  ComputerRequestPanel = (await import("../src/react-app/domains/session/computer/computer-request-panel")).ComputerRequestPanel
})
afterAll(async () => { if (ownedDom) await GlobalRegistrator.unregister() })
let root: Root | null = null
afterEach(async () => {
  if (root) await act(async () => root?.unmount())
  root = null
  document.body.innerHTML = ""
})

function SettingsProbe() {
  const location = useLocation()
  return <div data-testid="settings" data-path={location.pathname} data-state={JSON.stringify(location.state)} />
}

async function openSetupFrom(request: ComputerRequest) {
  const container = document.createElement("div")
  document.body.append(container)
  root = createRoot(container)
  await act(async () => root?.render(
    <MemoryRouter initialEntries={["/workspace/ws_1/session/chat_1"]}>
      <Routes>
        <Route path="/workspace/:workspaceId/session/:sessionId" element={<ComputerRequestPanel sessionId="chat_1" request={request} />} />
        <Route path="/workspace/:workspaceId/settings/*" element={<SettingsProbe />} />
      </Routes>
    </MemoryRouter>,
  ))
  const button = container.querySelector<HTMLButtonElement>('[data-testid="session-computer-request-setup"]')
  expect(button?.textContent).toBe("Set up")
  await act(async () => button?.click())
  return container.querySelector<HTMLElement>('[data-testid="settings"]')
}

test("the agent's setup request opens Settings > Computer use and keeps the chat to return to", async () => {
  const settings = await openSetupFrom({ id: "req_1", reason: "setup", computer: "This Mac", placement: "local", appId: "com.apple.TextEdit" })
  expect(settings?.dataset.path).toBe("/workspace/ws_1/settings/computer")
  expect(JSON.parse(settings?.dataset.state ?? "null")).toEqual({ workspaceId: "ws_1", sessionId: "chat_1" })
})

test("a remote computer that needs setup also opens Settings, where the computer is chosen", async () => {
  const settings = await openSetupFrom({ id: "req_2", reason: "setup", computer: "Test VM", placement: "remote", detail: "Test VM needs a desktop connection." })
  expect(settings?.dataset.path).toBe("/workspace/ws_1/settings/computer")
})

async function render(request: ComputerRequest) {
  const container = document.createElement("div")
  document.body.append(container)
  root = createRoot(container)
  await act(async () => root?.render(<MemoryRouter><ComputerRequestPanel sessionId="chat_1" request={request} /></MemoryRouter>))
  return container
}

test("a save reads as where the app will save the file, not as a file handed to it", async () => {
  const container = await render({ id: "req_3", reason: "files", computer: "This Mac", placement: "local", standing: false,
    files: { app: "Preview", names: ["/Users/me/Desktop/report.pdf"], save: true } })
  const heading = [...container.querySelectorAll<HTMLElement>("[title]")].find(item => item.title === "/Users/me/Desktop/report.pdf")
  expect(heading?.textContent).toBe("Save report.pdf to Desktop from Preview?")
  expect(container.querySelector('[data-testid="session-computer-files-allow"]')?.textContent).toBe("Save")
  expect(container.querySelector('[data-testid="session-computer-files-dismiss"]')?.textContent).toBe("Don't save")
  expect(container.querySelector('[data-testid="session-computer-files-always"]')).toBeNull()
  expect(container.querySelector('[data-testid="session-computer-files"]')?.textContent).toBe("/Users/me/Desktop/report.pdf")
})

test("handing a file over still reads as giving it to the app", async () => {
  const container = await render({ id: "req_4", reason: "files", computer: "This Mac", placement: "local",
    files: { app: "Preview", names: ["/Users/me/Desktop/photo.png"] } })
  expect(container.textContent).toContain("Give this file to Preview?")
  expect(container.querySelector('[data-testid="session-computer-files-allow"]')?.textContent).toBe("Give file")
})

const savedSecret = (label: string, extra: Partial<NonNullable<NonNullable<ComputerRequest["credential"]>["secret"]>> = {}): ComputerRequest => ({
  id: "req_5", reason: "credential", computer: "This Mac", placement: "local", standing: false,
  credential: { site: "https://app.example", secret: { label, kind: "password", field: "password", ...extra } },
})

function answersFrom(container: HTMLElement) {
  const answers: unknown[] = []
  Reflect.set(window, "__OPENWORK_ELECTRON__", { invokeDesktop: async (command: string, input: unknown) => {
    if (command === "computerAnswerRequest") answers.push(input)
    return {}
  } })
  const press = async (id: string) => act(async () => container.querySelector<HTMLButtonElement>(`[data-testid="session-computer-credential-${id}"]`)?.click())
  return { answers, press }
}

test("a saved secret asks to fill it by name on the exact site, into the kind of field it is", async () => {
  const container = await render(savedSecret("Billing sign-in"))
  expect(container.querySelector('[data-testid="session-computer-request"]')?.getAttribute("data-credential")).toBe("secret")
  expect(container.querySelector('[data-testid="session-computer-credential-secret-label"]')?.textContent).toBe("Billing sign-in")
  expect(container.querySelector('[data-testid="session-computer-credential-site"]')?.textContent).toBe("https://app.example")
  expect(container.textContent).toContain("Fill “Billing sign-in” on https://app.example?")
  expect(container.querySelector('[data-testid="session-computer-credential-field"]')?.textContent).toBe("Password, into a password field.")
  expect(container.textContent).toContain("without showing it to the agent")
  expect(container.textContent).not.toContain("types what you gave it")
  expect(container.querySelector('[data-testid="session-computer-credential-hidden"]')).toBeNull()
  expect(container.querySelector('[data-testid="session-computer-credential-allow"]')?.textContent).toBe("Fill")
  expect(container.querySelector('[data-testid="session-computer-credential-dismiss"]')?.textContent).toBe("Don't fill")
})

test("a saved secret never offers always, even when the request does not say it is one-time", async () => {
  const container = await render({ ...savedSecret("Billing sign-in"), standing: undefined })
  expect(container.querySelector('[data-testid="session-computer-credential-always"]')).toBeNull()
  expect([...container.querySelectorAll("button")].map((button) => button.textContent)).toEqual(["Don't fill", "Fill"])
})

test("hidden characters in a saved secret's name are shown and warned about", async () => {
  const container = await render(savedSecret("Billing\u202Esign-in\u200B"))
  expect(container.querySelector('[data-testid="session-computer-credential-secret-label"]')?.textContent).toBe("Billing<U+202E>sign-in<U+200B>")
  expect(container.querySelector('[data-testid="session-computer-credential-hidden"]')?.textContent).toContain("2 hidden characters")
})

test("a one-time code going into a phone number field is named as that", async () => {
  const container = await render(savedSecret("Sign-in code", { kind: "code", field: "tel" }))
  expect(container.querySelector('[data-testid="session-computer-credential-field"]')?.textContent).toBe("One-time code, into a phone number field.")
})

test("a field type the card does not know is not echoed", async () => {
  const container = await render(savedSecret("Service key", { kind: "token", field: "toString" }))
  expect(container.querySelector('[data-testid="session-computer-credential-field"]')?.textContent).toBe("API key or token, into a field on this page.")
})

test("Fill and Don't fill answer the exact request", async () => {
  const container = await render(savedSecret("Billing sign-in"))
  const { answers, press } = answersFrom(container)
  try {
    await press("allow")
    await press("dismiss")
  } finally {
    Reflect.deleteProperty(window, "__OPENWORK_ELECTRON__")
  }
  expect(answers).toEqual([{ sessionId: "chat_1", answer: "allow", id: "req_5" }, { sessionId: "chat_1", answer: "dismiss", id: "req_5" }])
})

test("a saved secret with no site cannot be filled", async () => {
  const request = savedSecret("Billing sign-in")
  const container = await render({ ...request, credential: { secret: request.credential?.secret } })
  expect(container.querySelector('[data-testid="session-computer-credential-allow"]')).toBeNull()
  expect(container.querySelector('[data-testid="session-computer-credential-dismiss"]')?.textContent).toBe("Don't fill")
  expect(container.textContent).toContain("can't tell which site")
})

test("a typed credential keeps its own card and its always choice", async () => {
  const container = await render({ id: "req_6", reason: "credential", computer: "This Mac", placement: "local", credential: { site: "https://app.example" } })
  expect(container.querySelector('[data-testid="session-computer-request"]')?.getAttribute("data-credential")).toBeNull()
  expect(container.textContent).toContain("Enter your password or code on app.example?")
  expect(container.querySelector('[data-testid="session-computer-credential-always"]')?.textContent).toBe("Always for this site in this chat")
  expect(container.querySelector('[data-testid="session-computer-credential-secret-label"]')).toBeNull()
})

const READ_PASSWORD = { field: "password", command: ["op", "read", "op://Private/Example/password"] }
const READ_CODE = { field: "number", command: ["/opt/homebrew/bin/bw", "get", "totp", "example site"] }
const ASKED = { field: "password", ask: "Example password" }
const values = (fills: NonNullable<NonNullable<ComputerRequest["credential"]>["fills"]>, extra: Partial<ComputerRequest> = {}): ComputerRequest => ({
  id: "req_7", reason: "credential", computer: "This Mac", placement: "local", ...extra, credential: { site: "https://app.example", fills },
})
const rows = (container: HTMLElement) => [...container.querySelectorAll<HTMLElement>('[data-testid="session-computer-credential-fill"]')]
const pasteFields = (container: HTMLElement) => [...container.querySelectorAll<HTMLInputElement>('[data-testid="session-computer-credential-paste"]')]
const button = (container: HTMLElement, id: string) => container.querySelector<HTMLButtonElement>(`[data-testid="session-computer-credential-${id}"]`)
async function paste(element: HTMLInputElement | undefined, value: string) {
  if (!element) throw new Error("No paste field")
  await act(async () => {
    Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), "value")?.set?.call(element, value)
    element.dispatchEvent(new Event("input", { bubbles: true }))
  })
}

test("commands are listed whole with their fields, and can be run once or always", async () => {
  const container = await render(values([READ_PASSWORD, READ_CODE]))
  expect(container.querySelector('[data-testid="session-computer-request"]')?.getAttribute("data-credential")).toBe("values")
  expect(button(container, "title")?.textContent ?? container.querySelector('[data-testid="session-computer-credential-title"]')?.textContent)
    .toBe("Run these 2 commands and fill what they print on app.example?")
  expect(rows(container).map((row) => [row.dataset.source, row.querySelector('[data-testid="session-computer-credential-command"]')?.textContent, row.querySelector('[data-testid="session-computer-credential-field"]')?.textContent]))
    .toEqual([["command", "op read op://Private/Example/password", "Into a password field"], ["command", "/opt/homebrew/bin/bw get totp 'example site'", "Into a number field"]])
  expect(pasteFields(container)).toEqual([])
  expect([button(container, "dismiss")?.textContent, button(container, "always")?.textContent, button(container, "allow")?.textContent])
    .toEqual(["Don't run", "Always for this site in this chat", "Run and fill"])
  const { answers, press } = answersFrom(container)
  try {
    await press("allow")
    await press("always")
  } finally {
    Reflect.deleteProperty(window, "__OPENWORK_ELECTRON__")
  }
  expect(answers).toEqual([{ sessionId: "chat_1", answer: "allow", id: "req_7" }, { sessionId: "chat_1", answer: "always", id: "req_7" }])
})

test("a value the agent asks for is pasted into a private field, and Fill waits for it", async () => {
  const container = await render(values([ASKED], { standing: false }))
  expect(container.querySelector('[data-testid="session-computer-credential-title"]')?.textContent).toBe("Fill this field on app.example?")
  expect(container.querySelector('[data-testid="session-computer-credential-unseen"]')?.textContent).toBe("The model never sees this value.")
  expect(rows(container).map((row) => row.dataset.source)).toEqual(["paste"])
  expect(container.querySelector('[data-testid="session-computer-credential-ask"]')?.textContent).toBe("Example password")
  const [field] = pasteFields(container)
  expect([field?.type, field?.getAttribute("autocomplete")]).toEqual(["password", "off"])
  expect(button(container, "always")).toBeNull()
  expect(button(container, "switch")).toBeNull()
  expect([button(container, "dismiss")?.textContent, button(container, "allow")?.textContent, button(container, "allow")?.disabled]).toEqual(["Don't fill", "Fill", true])
  const { answers, press } = answersFrom(container)
  try {
    await press("allow")
    expect(answers).toEqual([])
    await paste(field, "hunter2-pasted")
    expect(button(container, "allow")?.disabled).toBe(false)
    await press("allow")
  } finally {
    Reflect.deleteProperty(window, "__OPENWORK_ELECTRON__")
  }
  expect(answers).toEqual([{ sessionId: "chat_1", answer: "allow", id: "req_7", values: ["hunter2-pasted"], keep: [false] }])
  // The field gives its value up once: nothing of it is left in the page.
  expect(field?.value).toBe("")
  expect(container.innerHTML).not.toContain("hunter2-pasted")
})

test("keeping a pasted value for the chat is the person's choice, per value", async () => {
  const container = await render(values([READ_CODE, ASKED, { field: "text", ask: "Account number" }], { standing: false }))
  expect(container.querySelector('[data-testid="session-computer-credential-title"]')?.textContent).toBe("Fill these 3 fields on app.example?")
  expect(rows(container).map((row) => row.dataset.source)).toEqual(["command", "paste", "paste"])
  expect(button(container, "allow")?.textContent).toBe("Run and fill")
  const [password, account] = pasteFields(container)
  const keeps = [...container.querySelectorAll<HTMLButtonElement>('[data-testid="session-computer-credential-keep"]')]
  expect(keeps.length).toBe(2)
  const { answers, press } = answersFrom(container)
  try {
    await paste(password, "hunter2-pasted")
    expect(button(container, "allow")?.disabled).toBe(true)
    await paste(account, "0042-7781")
    await act(async () => keeps[1]?.closest("label")?.click())
    expect(keeps.map((keep) => keep.getAttribute("aria-checked"))).toEqual(["false", "true"])
    await press("allow")
  } finally {
    Reflect.deleteProperty(window, "__OPENWORK_ELECTRON__")
  }
  expect(answers).toEqual([{ sessionId: "chat_1", answer: "allow", id: "req_7", values: [null, "hunter2-pasted", "0042-7781"], keep: [false, false, true] }])
})

test("a command can be swapped for a pasted value, which is used once and never kept or made standing", async () => {
  const container = await render(values([READ_PASSWORD]))
  expect(button(container, "switch")?.textContent).toBe("Paste it instead")
  await act(async () => button(container, "switch")?.click())
  expect(rows(container).map((row) => row.dataset.source)).toEqual(["paste"])
  expect(container.querySelector('[data-testid="session-computer-credential-title"]')?.textContent).toBe("Fill this field on app.example?")
  expect([button(container, "always"), container.querySelector('[data-testid="session-computer-credential-keep"]')]).toEqual([null, null])
  expect([button(container, "switch")?.textContent, button(container, "allow")?.textContent, button(container, "allow")?.disabled]).toEqual(["Run the command instead", "Fill", true])
  const { answers, press } = answersFrom(container)
  try {
    await paste(pasteFields(container)[0], "hunter2-pasted")
    await press("allow")
    // Back to the command: nothing pasted is sent, and always is offered again.
    await act(async () => button(container, "switch")?.click())
    expect(button(container, "always")?.textContent).toBe("Always for this site in this chat")
    await press("allow")
  } finally {
    Reflect.deleteProperty(window, "__OPENWORK_ELECTRON__")
  }
  expect(answers).toEqual([{ sessionId: "chat_1", answer: "allow", id: "req_7", values: ["hunter2-pasted"], keep: [false] }, { sessionId: "chat_1", answer: "allow", id: "req_7" }])
})

test("a value kept for the chat fills with one click, or a different one can be pasted", async () => {
  const container = await render(values([{ ...ASKED, kept: true }], { standing: false }))
  expect(rows(container).map((row) => row.dataset.source)).toEqual(["kept"])
  expect(container.querySelector('[data-testid="session-computer-credential-field"]')?.textContent).toBe("Into a password field, from what you kept for this chat")
  expect(container.textContent).toContain("what you kept for this chat")
  expect(pasteFields(container)).toEqual([])
  expect([button(container, "always"), button(container, "switch")?.textContent, button(container, "allow")?.textContent, button(container, "allow")?.disabled])
    .toEqual([null, "Paste a different one", "Fill", false])
  const { answers, press } = answersFrom(container)
  try {
    await press("allow")
    await act(async () => button(container, "switch")?.click())
    expect([rows(container)[0]?.dataset.source, button(container, "switch")?.textContent, button(container, "allow")?.disabled]).toEqual(["paste", "Use the one you kept", true])
    await paste(pasteFields(container)[0], "another-pasted")
    await press("allow")
  } finally {
    Reflect.deleteProperty(window, "__OPENWORK_ELECTRON__")
  }
  expect(answers).toEqual([{ sessionId: "chat_1", answer: "allow", id: "req_7" }, { sessionId: "chat_1", answer: "allow", id: "req_7", values: ["another-pasted"], keep: [false] }])
})

const keptKey = { field: "$GEMINI_API_KEY", ask: "Gemini API key", kept: true } as const
const used = (use: NonNullable<NonNullable<ComputerRequest["credential"]>["use"]>, fills: NonNullable<NonNullable<ComputerRequest["credential"]>["fills"]>, extra: Partial<ComputerRequest> = {}): ComputerRequest => ({
  id: "req_7", reason: "credential", computer: "This Mac", placement: "local", ...extra, credential: { use, fills },
})

test("a program run with a value kept for the chat says the model never sees it, and Always names the program it covers", async () => {
  const container = await render(used({ kind: "run", command: ["/usr/local/bin/node", "/tmp/probe-history.mjs"] }, [keptKey]))
  expect(container.querySelector('[data-testid="session-computer-credential-title"]')?.textContent).toBe("Run this command with a private value?")
  expect(container.querySelector('[data-testid="session-computer-credential-field"]')?.textContent).toBe("As $GEMINI_API_KEY, from what you kept for this chat")
  expect(container.querySelector('[data-testid="session-computer-credential-unseen"]')?.textContent)
    .toBe("The model never sees this value. Always covers any command that starts with node with this value in this chat.")
  expect([button(container, "dismiss")?.textContent, button(container, "always")?.textContent, button(container, "allow")?.textContent])
    .toEqual(["Don't run", "Always for this program in this chat", "Run"])
  const { answers, press } = answersFrom(container)
  try {
    await press("always")
    await act(async () => button(container, "switch")?.click())
    expect(button(container, "always")).toBeNull()
    expect(container.querySelector('[data-testid="session-computer-credential-unseen"]')?.textContent).toBe("The model never sees this value.")
  } finally {
    Reflect.deleteProperty(window, "__OPENWORK_ELECTRON__")
  }
  expect(answers).toEqual([{ sessionId: "chat_1", answer: "always", id: "req_7" }])
})

test("a request sent with a kept value offers Always for its site, and a value to paste or an organization that asks every time offers none", async () => {
  const request = { kind: "request", method: "GET", url: "https://api.example/v1/models", origin: "https://api.example" } as const
  const kept = await render(used(request, [{ field: "header Authorization", ask: "Example token", kept: true }]))
  expect(button(kept, "always")?.textContent).toBe("Always for this site in this chat")
  expect(kept.querySelector('[data-testid="session-computer-credential-covered"]')?.textContent).toBe("api.example")
  const pasted = await render(used({ kind: "run", command: ["node", "probe.mjs"] }, [{ field: "$GEMINI_API_KEY", ask: "Gemini API key" }], { standing: false }))
  expect([button(pasted, "always"), pasted.querySelector('[data-testid="session-computer-credential-covered"]')]).toEqual([null, null])
  expect(pasted.querySelector('[data-testid="session-computer-credential-unseen"]')?.textContent).toBe("The model never sees this value.")
  const everyTime = await render(used({ kind: "run", command: ["node", "probe.mjs"] }, [keptKey], { standing: false }))
  expect([button(everyTime, "always"), everyTime.querySelector('[data-testid="session-computer-credential-covered"]')]).toEqual([null, null])
  const command = await render(used({ kind: "run", command: ["gh", "api", "user"] }, [{ field: "$GH_TOKEN", command: ["op", "read", "op://Private/GitHub/token"] }]))
  expect(button(command, "always")?.textContent).toBe("Always for this command in this chat")
  expect(command.querySelector('[data-testid="session-computer-credential-covered"]')).toBeNull()
})

test("hidden characters in a command or a name are shown and warned about, and a card with no site fills nothing", async () => {
  const container = await render(values([{ field: "password", ask: "Example‮password" }, { field: "text", command: ["op", "read​"] }], { standing: false }))
  expect(container.querySelector('[data-testid="session-computer-credential-ask"]')?.textContent).toBe("Example<U+202E>password")
  expect(container.querySelector('[data-testid="session-computer-credential-command"]')?.textContent).toBe("op 'read<U+200B>'")
  expect(container.querySelector('[data-testid="session-computer-credential-hidden"]')?.textContent).toContain("2 hidden characters")
  if (root) await act(async () => root?.unmount())
  root = null
  document.body.innerHTML = ""
  const nowhere = await render({ id: "req_8", reason: "credential", computer: "This Mac", placement: "local", standing: false, credential: { fills: [ASKED] } })
  expect(nowhere.textContent).toContain("can't tell which site")
  expect([button(nowhere, "allow"), pasteFields(nowhere).length, button(nowhere, "dismiss")?.textContent]).toEqual([null, 0, "Don't fill"])
})

test("a refused answer is said on the card, and the card stays", async () => {
  const container = await render(values([ASKED], { standing: false }))
  Reflect.set(window, "__OPENWORK_ELECTRON__", { invokeDesktop: async () => { throw new Error("A pasted value must be 4 to 4096 characters long.") } })
  try {
    await paste(pasteFields(container)[0], "abc")
    await act(async () => button(container, "allow")?.click())
  } finally {
    Reflect.deleteProperty(window, "__OPENWORK_ELECTRON__")
  }
  expect(container.querySelector('[role="alert"]')?.textContent).toContain("4 to 4096 characters")
  expect(container.innerHTML).not.toContain(">abc<")
  expect(button(container, "allow")?.disabled).toBe(true)
})

const LOCKED = { field: "password", command: ["/opt/homebrew/bin/bw", "get", "password", "example.com"], needs: "BW_SESSION" }
const KEY = { unlock: "BW_SESSION", program: "/opt/homebrew/bin/bw", ask: "Bitwarden session key" }
const text = (row: HTMLElement | undefined, id: string) => row?.querySelector(`[data-testid="session-computer-credential-${id}"]`)?.textContent

test("a command that needs a key shows the key as its own row, pasted once and kept only when chosen", async () => {
  const container = await render(values([LOCKED, READ_CODE, KEY], { standing: false }))
  expect(container.querySelector('[data-testid="session-computer-credential-title"]')?.textContent).toBe("Run these 2 commands and fill what they print on app.example?")
  expect(rows(container).map((row) => [row.dataset.row, row.dataset.source])).toEqual([["field", "command"], ["field", "command"], ["key", "paste"]])
  expect(text(rows(container)[0], "field")).toBe("Into a password field, with BW_SESSION set")
  expect(text(rows(container)[1], "field")).toBe("Into a number field")
  expect([text(rows(container)[2], "ask"), text(rows(container)[2], "field")]).toEqual(["Bitwarden session key", "Given to /opt/homebrew/bin/bw as BW_SESSION, for this run only"])
  expect(container.textContent).toContain("with the key you paste here")
  expect(container.querySelector('[data-testid="session-computer-credential-unseen"]')?.textContent).toBe("The model never sees these values.")
  expect(pasteFields(container).map((field) => field.getAttribute("placeholder"))).toEqual(["Paste the key here"])
  expect([button(container, "always"), button(container, "dismiss")?.textContent, button(container, "allow")?.textContent, button(container, "allow")?.disabled]).toEqual([null, "Don't run", "Run and fill", true])
  const keep = container.querySelector<HTMLButtonElement>('[data-testid="session-computer-credential-keep"]')
  const { answers, press } = answersFrom(container)
  try {
    await press("allow")
    expect(answers).toEqual([])
    await paste(pasteFields(container)[0], "made-up-session-key")
    await act(async () => keep?.closest("label")?.click())
    expect(keep?.getAttribute("aria-checked")).toBe("true")
    await press("allow")
  } finally {
    Reflect.deleteProperty(window, "__OPENWORK_ELECTRON__")
  }
  expect(answers).toEqual([{ sessionId: "chat_1", answer: "allow", id: "req_7", values: [null, null, "made-up-session-key"], keep: [false, false, true] }])
  expect(container.innerHTML).not.toContain("made-up-session-key")
})

test("a key kept for the chat runs with one click, or a different one can be pasted", async () => {
  const container = await render(values([LOCKED, { ...KEY, kept: true }], { standing: false }))
  expect(rows(container).map((row) => [row.dataset.row, row.dataset.source])).toEqual([["field", "command"], ["key", "kept"]])
  expect(text(rows(container)[1], "field")).toBe("Given to /opt/homebrew/bin/bw as BW_SESSION, for this run only, from what you kept for this chat")
  expect(container.textContent).toContain("with the key you kept for this chat")
  expect(container.querySelector('[data-testid="session-computer-credential-title"]')?.textContent).toBe("Run this command and fill what it prints on app.example?")
  expect([pasteFields(container).length, button(container, "always"), button(container, "allow")?.textContent, button(container, "allow")?.disabled]).toEqual([0, null, "Run and fill", false])
  const change = rows(container)[1]?.querySelector<HTMLButtonElement>('[data-testid="session-computer-credential-switch"]')
  expect(change?.textContent).toBe("Paste a different one")
  const { answers, press } = answersFrom(container)
  try {
    await press("allow")
    await act(async () => change?.click())
    expect([rows(container)[1]?.dataset.source, button(container, "allow")?.disabled]).toEqual(["paste", true])
    await paste(pasteFields(container)[0], "another-session-key")
    await press("allow")
  } finally {
    Reflect.deleteProperty(window, "__OPENWORK_ELECTRON__")
  }
  expect(answers).toEqual([{ sessionId: "chat_1", answer: "allow", id: "req_7" }, { sessionId: "chat_1", answer: "allow", id: "req_7", values: [null, "another-session-key"], keep: [false, false] }])
})

test("pasting the value in place of the command leaves no key to give", async () => {
  const container = await render(values([LOCKED, KEY], { standing: false }))
  await act(async () => rows(container)[0]?.querySelector<HTMLButtonElement>('[data-testid="session-computer-credential-switch"]')?.click())
  expect(rows(container).map((row) => [row.dataset.row, row.dataset.source])).toEqual([["field", "paste"]])
  expect(text(rows(container)[0], "field")).toBe("Into a password field")
  expect(container.querySelector('[data-testid="session-computer-credential-title"]')?.textContent).toBe("Fill this field on app.example?")
  expect([button(container, "dismiss")?.textContent, button(container, "allow")?.textContent]).toEqual(["Don't fill", "Fill"])
  const { answers, press } = answersFrom(container)
  try {
    await paste(pasteFields(container)[0], "hunter2-pasted")
    await press("allow")
  } finally {
    Reflect.deleteProperty(window, "__OPENWORK_ELECTRON__")
  }
  expect(answers).toEqual([{ sessionId: "chat_1", answer: "allow", id: "req_7", values: ["hunter2-pasted", null], keep: [false, false] }])
  // Back to the command, and the key is asked for again.
  await act(async () => rows(container)[0]?.querySelector<HTMLButtonElement>('[data-testid="session-computer-credential-switch"]')?.click())
  expect(rows(container).map((row) => [row.dataset.row, row.dataset.source])).toEqual([["field", "command"], ["key", "paste"]])
  expect(button(container, "allow")?.disabled).toBe(true)
})

test("with pasting turned off, a command cannot be swapped for a pasted value", async () => {
  const container = await render({ ...values([READ_PASSWORD, READ_CODE]), credential: { site: "https://app.example", fills: [READ_PASSWORD, READ_CODE], paste: false } })
  expect(rows(container).length).toBe(2)
  expect(container.querySelector('[data-testid="session-computer-credential-switch"]')).toBeNull()
  expect(pasteFields(container)).toEqual([])
  expect(button(container, "always")).not.toBeNull()
  // The same card with nothing turned off offers the swap on every command.
  await act(async () => root?.unmount())
  const open = await render(values([READ_PASSWORD, READ_CODE]))
  expect(open.querySelectorAll('[data-testid="session-computer-credential-switch"]').length).toBe(2)
})

test("with keeping turned off, a pasted value is never offered to be kept for the chat", async () => {
  const container = await render({ ...values([ASKED]), credential: { site: "https://app.example", fills: [ASKED], keep: false } })
  await paste(pasteFields(container)[0], "hunter2-pasted")
  expect(container.querySelector('[data-testid="session-computer-credential-keep"]')).toBeNull()
  await act(async () => root?.unmount())
  const open = await render(values([ASKED]))
  await paste(pasteFields(open)[0], "hunter2-pasted")
  expect(open.querySelector('[data-testid="session-computer-credential-keep"]')).not.toBeNull()
})
