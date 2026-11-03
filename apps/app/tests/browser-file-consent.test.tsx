/** @jsxImportSource react */
import { afterAll, afterEach, beforeAll, expect, spyOn, test } from "bun:test"
import { GlobalRegistrator } from "@happy-dom/global-registrator"
import { act } from "react"
import type { Root } from "react-dom/client"
import type { ComputerRequest } from "@openwork/types/desktop-ipc"

let createRoot: typeof import("react-dom/client")["createRoot"]
let ComputerRequestPanel: typeof import("../src/react-app/domains/session/computer/computer-request-panel")["ComputerRequestPanel"]
let RememberedFileSharing: typeof import("../src/react-app/domains/settings/pages/computer-use-view")["RememberedFileSharing"]
const ownedDom = !GlobalRegistrator.isRegistered && typeof document === "undefined"
let root: Root | null = null
beforeAll(async () => {
  if (ownedDom) GlobalRegistrator.register({ url: "http://localhost/" })
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true)
  createRoot = (await import("react-dom/client")).createRoot
  ComputerRequestPanel = (await import("../src/react-app/domains/session/computer/computer-request-panel")).ComputerRequestPanel
  RememberedFileSharing = (await import("../src/react-app/domains/settings/pages/computer-use-view")).RememberedFileSharing
})
afterEach(async () => {
  if (root) await act(async () => root?.unmount())
  root = null
  Reflect.deleteProperty(window, "__OPENWORK_ELECTRON__")
  document.body.innerHTML = ""
})
afterAll(async () => { if (ownedDom) await GlobalRegistrator.unregister() })
function container() {
  const element = document.createElement("div")
  document.body.append(element)
  root = createRoot(element)
  return element
}
const request: ComputerRequest = {
  id: "browser-request", reason: "files", computer: "This computer", placement: "local",
  files: { app: "https://example.com", site: "https://example.com", names: ["/Reports/annual.pdf"], canRemember: true },
}

test("remember is a distinct folder choice with origin, local scope and revocation; always stays chat-only", async () => {
  const answers: unknown[] = []
  Reflect.set(window, "__OPENWORK_ELECTRON__", { invokeDesktop: async (command: string, input: unknown) => {
    expect(command).toBe("computerAnswerRequest")
    answers.push(input)
    return {}
  } })
  const element = container()
  await act(async () => root?.render(<ComputerRequestPanel sessionId="chat" request={request} />))
  expect(element.textContent).toContain("https://example.com")
  expect(element.textContent).toContain("across chats and Slack tasks on this computer")
  expect(element.textContent).toContain("system folder picker opens next")
  expect(element.textContent).toContain("Settings → Computer use")
  expect(element.querySelector('[data-testid="session-computer-files-always"]')?.textContent).toContain("in this chat")
  await act(async () => element.querySelector<HTMLButtonElement>('[data-testid="session-computer-files-remember"]')?.click())
  expect(answers).toEqual([{ sessionId: "chat", answer: "remember", id: "browser-request" }])
})

test("remember failures never claim a folder permission was saved", async () => {
  Reflect.set(window, "__OPENWORK_ELECTRON__", { invokeDesktop: async () => { throw new Error("Folder selection was cancelled") } })
  const element = container()
  await act(async () => root?.render(<ComputerRequestPanel sessionId="chat" request={request} />))
  await act(async () => element.querySelector<HTMLButtonElement>('[data-testid="session-computer-files-remember"]')?.click())
  expect(element.querySelector('[role="alert"]')?.textContent).toContain("That wasn't saved. Folder selection was cancelled")
  expect(element.textContent).not.toContain("Permission remembered")
  expect(element.querySelector<HTMLButtonElement>('[data-testid="session-computer-files-remember"]')?.disabled).toBe(false)
})

test("managed Ask and native files do not offer remembered sharing", async () => {
  const element = container()
  await act(async () => root?.render(<ComputerRequestPanel sessionId="chat" request={{ ...request, standing: false, files: { ...request.files!, canRemember: false } }} />))
  expect(element.querySelector('[data-testid="session-computer-files-remember"]')).toBeNull()
  expect(element.querySelector('[data-testid="session-computer-files-always"]')).toBeNull()
  await act(async () => root?.render(<ComputerRequestPanel sessionId="chat" request={{ ...request, files: { app: "Editor", names: ["annual.pdf"] } }} />))
  expect(element.querySelector('[data-testid="session-computer-files-remember"]')).toBeNull()
  expect(element.querySelector('[data-testid="session-computer-files-always"]')).not.toBeNull()
})

test("remembered folders load without computerUse, revoke through IPC and refetch on focus", async () => {
  let grants = [{ id: "grant-1", origin: "https://example.com", folder: "/Reports" }]
  let reads = 0
  const calls: unknown[] = []
  Reflect.set(window, "__OPENWORK_ELECTRON__", { invokeDesktop: async (command: string, id?: string) => {
    calls.push([command, id])
    if (command === "computerListFileGrants") { reads++; return { enabled: true, grants } }
    if (command === "computerRemoveFileGrant") { grants = []; return { ok: true } }
    throw new Error("unexpected command")
  } })
  const element = container()
  await act(async () => root?.render(<RememberedFileSharing />))
  expect(element.textContent).toContain("https://example.com")
  expect(element.textContent).toContain("/Reports")
  await act(async () => element.querySelector<HTMLButtonElement>("button")?.click())
  expect(calls).toContainEqual(["computerRemoveFileGrant", "grant-1"])
  expect(element.textContent).toContain("No folders shared automatically")
  const before = reads
  await act(async () => window.dispatchEvent(new Event("focus")))
  expect(reads).toBe(before + 1)
})

test("account changes discard folders; failed reads never reuse another account's grants", async () => {
  const { denSessionUpdatedEvent } = await import("../src/app/lib/den-session-events")
  let fail = false
  Reflect.set(window, "__OPENWORK_ELECTRON__", { invokeDesktop: async () => {
    if (fail) throw new Error("Account unavailable")
    return { enabled: true, grants: [{ id: "grant-1", origin: "https://example.com", folder: "/Private" }] }
  } })
  const element = container()
  await act(async () => root?.render(<RememberedFileSharing />))
  expect(element.textContent).toContain("/Private")
  fail = true
  await act(async () => window.dispatchEvent(new Event(denSessionUpdatedEvent)))
  expect(element.textContent).not.toContain("/Private")
  expect(element.querySelector('[role="alert"]')?.textContent).toContain("Couldn't check remembered file sharing")
})

test("late list responses cannot restore another account's folders", async () => {
  const { denSessionUpdatedEvent } = await import("../src/app/lib/den-session-events")
  type Listed = { enabled: boolean; grants: Array<{ id: string; origin: string; folder: string }> }
  let finishOld: (value: Listed) => void = () => {}
  let reads = 0
  Reflect.set(window, "__OPENWORK_ELECTRON__", { invokeDesktop: async () => {
    if (++reads === 1) return new Promise<Listed>((resolve) => { finishOld = resolve })
    return { enabled: true, grants: [{ id: "new-account", origin: "https://example.org", folder: "/Current" }] }
  } })
  const element = container()
  await act(async () => root?.render(<RememberedFileSharing />))
  await act(async () => window.dispatchEvent(new Event(denSessionUpdatedEvent)))
  await act(async () => finishOld({ enabled: true, grants: [{ id: "old-account", origin: "https://example.com", folder: "/OldPrivate" }] }))
  expect(element.textContent).toContain("/Current")
  expect(element.textContent).not.toContain("/OldPrivate")
})

test("organization-blocked remembered folders remain removable", async () => {
  Reflect.set(window, "__OPENWORK_ELECTRON__", { invokeDesktop: async () => ({ enabled: true, grants: [{ id: "blocked", origin: "https://example.com", folder: "/Reports", blocked: true }] }) })
  const element = container()
  await act(async () => root?.render(<RememberedFileSharing />))
  expect(element.textContent).toContain("Blocked by your organization")
  expect(element.querySelector<HTMLButtonElement>("button")?.textContent).toBe("Remove")
  expect(element.querySelector<HTMLButtonElement>("button")?.disabled).toBe(false)
})

test("a failed refresh clears folder data and offers a retry", async () => {
  let fail = false
  Reflect.set(window, "__OPENWORK_ELECTRON__", { invokeDesktop: async () => {
    if (fail) throw new Error("Offline")
    return { enabled: true, grants: [{ id: "grant-1", origin: "https://example.com", folder: "/Reports" }] }
  } })
  const element = container()
  await act(async () => root?.render(<RememberedFileSharing />))
  fail = true
  await act(async () => window.dispatchEvent(new Event("focus")))
  expect(element.textContent).not.toContain("/Reports")
  expect(element.querySelector('[role="alert"]')?.textContent).toContain("Couldn't check remembered file sharing")
  fail = false
  await act(async () => element.querySelector<HTMLButtonElement>("button")?.click())
  expect(element.textContent).toContain("/Reports")
  expect(element.querySelector('[role="alert"]')).toBeNull()
})

test("failed revocation stays visible with retry, and disabled feature hides grants", async () => {
  let enabled = true
  Reflect.set(window, "__OPENWORK_ELECTRON__", { invokeDesktop: async (command: string) => {
    if (command === "computerRemoveFileGrant") return { ok: false }
    return { enabled, grants: [{ id: "grant-1", origin: "https://example.com", folder: "/Reports" }] }
  } })
  const element = container()
  await act(async () => root?.render(<RememberedFileSharing />))
  await act(async () => element.querySelector<HTMLButtonElement>("button")?.click())
  expect(element.querySelector('[role="alert"]')?.textContent).toContain("Couldn't remove permission")
  expect(element.querySelector<HTMLButtonElement>("button")?.disabled).toBe(false)
  expect(element.textContent).toContain("/Reports")
  enabled = false
  await act(async () => window.dispatchEvent(new Event("focus")))
  expect(element.querySelector("#remembered-file-sharing")).toBeNull()
})

test("an initial policy read failure is visible with retry instead of hiding the settings", async () => {
  Reflect.set(window, "__OPENWORK_ELECTRON__", { invokeDesktop: async () => { throw new Error("Policy unavailable"); } })
  const element = container()
  await act(async () => root?.render(<RememberedFileSharing />))
  expect(element.querySelector('[role="alert"]')?.textContent).toContain("Couldn't check remembered file sharing")
  expect(element.querySelector("button")?.textContent).toContain("Try again")
})


test("updated desktop config reads advertise upload-policy support instead of receiving legacy browsing blocks", async () => {
  const { createDenClient } = await import("../src/app/lib/den")
  const requests: Headers[] = []
  const fetch = spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
    requests.push(new Headers(init?.headers))
    return Response.json({ browserUploadPermissions: { enabled: true, organizationId: "org_fixture", memberId: "member_fixture" } })
  })
  try {
    const config = await createDenClient({ baseUrl: "https://den.example.test", token: "fixture-token" }).getDesktopConfig("org_fixture")
    expect(requests[0]?.get("X-OpenWork-Browser-Upload-Permissions")).toBe("1")
    expect(config.browserUploadPermissions?.memberId).toBe("member_fixture")
  } finally { fetch.mockRestore() }
})
