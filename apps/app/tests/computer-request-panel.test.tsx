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
