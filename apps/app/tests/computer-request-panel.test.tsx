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
