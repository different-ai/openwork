/** @jsxImportSource react */
import { afterAll, afterEach, beforeAll, expect, spyOn, test } from "bun:test"
import { GlobalRegistrator } from "@happy-dom/global-registrator"
import { act } from "react"
import { z } from "zod"
import type { Root } from "react-dom/client"
import type { BrowserSecretSummary } from "@openwork/types/desktop-ipc"

const ownedDom = !GlobalRegistrator.isRegistered && typeof document === "undefined"
if (ownedDom) GlobalRegistrator.register({ url: "http://localhost/" })
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true)
// Imported after the DOM exists: the query client decides once whether it runs in a browser.
const { createRoot } = await import("react-dom/client")
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query")
const { BrowserSecretsDialog } = await import("../src/react-app/domains/session/panel/browser-secrets-dialog")
const { isBrowserSecretsDialogTarget, parseAllowedSites } = await import("../src/react-app/domains/session/panel/browser-secrets")
const { useBrowserSecretsReport } = await import("../src/react-app/domains/session/panel/use-browser-secrets")

// An obviously fake value: it must reach the bridge once and appear nowhere else.
const FAKE_VALUE = "fixture-not-a-real-secret-0001"
const SESSION = "chat_1"

type Call = { command: string; args: unknown[] }
type Bridge = {
  calls: Call[]
  saved: BrowserSecretSummary[]
  /** What the next add answers; a function is called when the add arrives. */
  add: (input: { label: string; kind: BrowserSecretSummary["kind"]; origins: string[] }) => Promise<{ ok: true; secret: BrowserSecretSummary } | { ok: false; error: string }>
}

let root: Root | null = null
let bridge: Bridge
const logged: string[] = []
const spies = (["log", "info", "warn", "error", "debug"] as const).map((level) =>
  spyOn(console, level).mockImplementation((...parts: unknown[]) => { logged.push(parts.map(String).join(" ")) }))

beforeAll(() => { document.body.innerHTML = "" })
afterEach(async () => {
  if (root) await act(async () => root?.unmount())
  root = null
  Reflect.deleteProperty(window, "__OPENWORK_ELECTRON__")
  document.body.innerHTML = ""
  logged.length = 0
})
afterAll(async () => {
  for (const spy of spies) spy.mockRestore()
  if (ownedDom) await GlobalRegistrator.unregister()
})

function installBridge(saved: BrowserSecretSummary[] = []): Bridge {
  const state: Bridge = {
    calls: [],
    saved: [...saved],
    add: async (input) => {
      const secret = { secretRef: `sec_fixture${state.saved.length}`, label: input.label, kind: input.kind, origins: input.origins }
      state.saved.push(secret)
      return { ok: true, secret }
    },
  }
  Reflect.set(window, "__OPENWORK_ELECTRON__", { invokeDesktop: async (command: string, ...args: unknown[]) => {
    state.calls.push({ command, args })
    if (command === "browserSecretsList") return [...state.saved]
    if (command === "browserSecretsAdd") {
      const input = z.object({ label: z.string(), kind: z.enum(["password", "code", "token"]), origins: z.array(z.string()) }).parse(args[0])
      return state.add(input)
    }
    if (command === "browserSecretsRemove") {
      const { secretRef } = z.object({ secretRef: z.string() }).parse(args[0])
      const before = state.saved.length
      state.saved = state.saved.filter((secret) => secret.secretRef !== secretRef)
      return state.saved.length < before
    }
    throw new Error(`Unexpected desktop command in this test: ${command}`)
  } })
  return state
}

async function open(options: { pageUrl?: string; saved?: BrowserSecretSummary[]; onOpenChange?: (open: boolean) => void } = {}) {
  bridge = installBridge(options.saved)
  const container = document.createElement("div")
  document.body.append(container)
  root = createRoot(container)
  const client = new QueryClient()
  await act(async () => root?.render(
    <QueryClientProvider client={client}>
      <BrowserSecretsDialog open onOpenChange={options.onOpenChange ?? (() => {})} sessionId={SESSION} pageUrl={options.pageUrl ?? "https://app.example/sign-in?next=%2Fhome"} />
    </QueryClientProvider>,
  ))
  await settle()
  const dialog = document.querySelector<HTMLElement>('[data-testid="browser-secrets-dialog"]')
  if (!dialog) throw new Error("The secrets dialog did not open.")
  return dialog
}

const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
const find = <T extends HTMLElement>(dialog: HTMLElement, id: string) => {
  const element = dialog.querySelector<T>(`[data-testid="${id}"]`)
  if (!element) throw new Error(`Missing ${id}`)
  return element
}
async function type(element: HTMLInputElement | HTMLTextAreaElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), "value")?.set?.call(element, value)
    element.dispatchEvent(new Event("input", { bubbles: true }))
  })
}
const press = (dialog: HTMLElement, id: string) => act(async () => find<HTMLButtonElement>(dialog, id).click())
const adds = () => bridge.calls.filter((call) => call.command === "browserSecretsAdd")

test("allowed sites are exact https origins, one per line", () => {
  expect(parseAllowedSites("https://app.example\n\n  https://api.example:8443  ")).toEqual({ ok: true, origins: ["https://app.example", "https://api.example:8443"] })
  expect(parseAllowedSites("https://App.Example/\nhttps://app.example")).toEqual({ ok: true, origins: ["https://app.example"] })
  for (const entry of ["https://app.example/sign-in", "https://app.example/?next=home", "https://app.example/#top", "https://someone@app.example"]) {
    const result = parseAllowedSites(entry)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain("Use https://app.example")
  }
  for (const entry of ["http://app.example", "app.example", "ftp://app.example", "https://*.example", "not a site"]) {
    expect(parseAllowedSites(entry).ok).toBe(false)
  }
  expect(parseAllowedSites("  \n ").ok).toBe(false)
  expect(parseAllowedSites(Array.from({ length: 11 }, (_, index) => `https://site-${index}.example`).join("\n")).ok).toBe(false)
  expect(parseAllowedSites(Array.from({ length: 10 }, (_, index) => `https://site-${index}.example`).join("\n")).ok).toBe(true)
})

test("an empty chat says what a secret is for and starts from the page's own site", async () => {
  const dialog = await open()
  expect(find(dialog, "browser-secrets-empty").textContent).toContain("without seeing it")
  expect(find<HTMLTextAreaElement>(dialog, "browser-secret-sites").value).toBe("https://app.example")
  const value = find<HTMLInputElement>(dialog, "browser-secret-value")
  expect(value.type).toBe("password")
  expect(value.getAttribute("autocomplete")).toBe("off")
  expect(bridge.calls).toEqual([{ command: "browserSecretsList", args: [SESSION] }])
})

test("a page that is not https offers no site to start from", async () => {
  const dialog = await open({ pageUrl: "http://app.example/sign-in" })
  expect(find<HTMLTextAreaElement>(dialog, "browser-secret-sites").value).toBe("")
})

test("this chat's secrets are listed with their kind and sites, and Remove forgets one", async () => {
  const dialog = await open({ saved: [
    { secretRef: "sec_fixtureA", label: "Billing sign-in", kind: "password", origins: ["https://app.example", "https://id.example"] },
    { secretRef: "sec_fixtureB", label: "Service key", kind: "token", origins: ["https://api.example"] },
  ] })
  const rows = [...dialog.querySelectorAll<HTMLElement>('[data-testid="browser-secret"]')]
  expect(rows.map((row) => row.textContent)).toEqual([
    "Billing sign-inPassword for app.example, id.exampleRemove",
    "Service keyAPI key or token for api.exampleRemove",
  ])
  expect(dialog.textContent).not.toContain("sec_fixtureA")
  await act(async () => rows[0]?.querySelector<HTMLButtonElement>('[data-testid="browser-secret-remove"]')?.click())
  await settle()
  expect(bridge.calls).toContainEqual({ command: "browserSecretsRemove", args: [{ sessionId: SESSION, secretRef: "sec_fixtureA" }] })
  expect([...dialog.querySelectorAll('[data-testid="browser-secret"]')].map((row) => row.textContent)).toEqual(["Service keyAPI key or token for api.exampleRemove"])
})

test("nothing is sent until the name, the sites and the secret are all there", async () => {
  const dialog = await open()
  const value = find<HTMLInputElement>(dialog, "browser-secret-value")
  await type(value, FAKE_VALUE)

  await press(dialog, "browser-secret-save")
  expect(find(dialog, "browser-secret-name-error").textContent).toContain("Give this secret a name")
  expect(value.value).toBe(FAKE_VALUE)

  await type(find<HTMLInputElement>(dialog, "browser-secret-name"), "Billing sign-in")
  await type(find<HTMLTextAreaElement>(dialog, "browser-secret-sites"), "https://app.example/sign-in")
  await press(dialog, "browser-secret-save")
  expect(find(dialog, "browser-secret-sites-error").textContent).toContain("Use https://app.example")

  await type(find<HTMLTextAreaElement>(dialog, "browser-secret-sites"), "http://app.example")
  await press(dialog, "browser-secret-save")
  expect(find(dialog, "browser-secret-sites-error").textContent).toContain("needs to start with https://")

  await type(find<HTMLTextAreaElement>(dialog, "browser-secret-sites"), "https://app.example")
  await type(value, "")
  await press(dialog, "browser-secret-save")
  expect(dialog.textContent).toContain("Enter the password to save.")
  expect(adds()).toEqual([])
})

test("saving sends the secret once, and the field is empty before the answer comes back", async () => {
  const dialog = await open()
  let answer: (() => void) | undefined
  const stored = bridge.add
  bridge.add = (input) => new Promise((resolve) => { answer = () => resolve(stored(input)) })

  await type(find<HTMLInputElement>(dialog, "browser-secret-name"), "  Sign-in code  ")
  await press(dialog, "browser-secret-kind-code")
  await type(find<HTMLTextAreaElement>(dialog, "browser-secret-sites"), "https://app.example/\nhttps://id.example")
  const value = find<HTMLInputElement>(dialog, "browser-secret-value")
  await type(value, FAKE_VALUE)
  await press(dialog, "browser-secret-save")

  expect(value.value).toBe("")
  expect(find<HTMLButtonElement>(dialog, "browser-secret-save").disabled).toBe(true)
  expect(adds()).toEqual([{ command: "browserSecretsAdd", args: [{ sessionId: SESSION, label: "Sign-in code", kind: "code", origins: ["https://app.example", "https://id.example"], value: FAKE_VALUE }] }])

  await act(async () => answer?.())
  await settle()
  expect(find<HTMLButtonElement>(dialog, "browser-secret-save").disabled).toBe(false)
  expect([...dialog.querySelectorAll('[data-testid="browser-secret"]')].map((row) => row.textContent)).toEqual(["Sign-in codeOne-time code for app.example, id.exampleRemove"])
  expect(find<HTMLInputElement>(dialog, "browser-secret-name").value).toBe("")
  expect(value.value).toBe("")
  expect(adds()).toHaveLength(1)

  // The value went to the bridge and nowhere else a person or a log could read it.
  expect(document.body.innerHTML).not.toContain(FAKE_VALUE)
  expect(window.location.href).not.toContain(FAKE_VALUE)
  expect(logged.join("\n")).not.toContain(FAKE_VALUE)
})

test("a refusal shows the reason it gives and still clears the secret", async () => {
  const dialog = await open()
  bridge.add = async () => ({ ok: false, error: "Use a secret between 6 and 4096 characters long." })
  await type(find<HTMLInputElement>(dialog, "browser-secret-name"), "Billing sign-in")
  const value = find<HTMLInputElement>(dialog, "browser-secret-value")
  await type(value, FAKE_VALUE)
  await press(dialog, "browser-secret-save")
  await settle()
  expect(find(dialog, "browser-secret-save-error").textContent).toBe("Use a secret between 6 and 4096 characters long.")
  expect(value.value).toBe("")
  expect(find<HTMLInputElement>(dialog, "browser-secret-name").value).toBe("Billing sign-in")
  expect(dialog.querySelector('[data-testid="browser-secret"]')).toBeNull()
})

test("a save that fails outright says so without repeating what failed, and clears the secret", async () => {
  const dialog = await open()
  bridge.add = async () => { throw new Error(`could not store ${FAKE_VALUE}`) }
  await type(find<HTMLInputElement>(dialog, "browser-secret-name"), "Billing sign-in")
  const value = find<HTMLInputElement>(dialog, "browser-secret-value")
  await type(value, FAKE_VALUE)
  await press(dialog, "browser-secret-save")
  await settle()
  expect(find(dialog, "browser-secret-save-error").textContent).toBe("That wasn't saved. Enter it again and save once more.")
  expect(value.value).toBe("")
  expect(document.body.innerHTML).not.toContain(FAKE_VALUE)
  expect(logged.join("\n")).not.toContain(FAKE_VALUE)
})

test("closing the dialog clears a secret that was typed but not saved", async () => {
  const changes: boolean[] = []
  const dialog = await open({ onOpenChange: (next) => changes.push(next) })
  const value = find<HTMLInputElement>(dialog, "browser-secret-value")
  await type(value, FAKE_VALUE)
  await act(async () => dialog.querySelector<HTMLButtonElement>('[data-slot="dialog-close"]')?.click())
  expect(changes).toEqual([false])
  expect(value.value).toBe("")
  expect(adds()).toEqual([])
})

test("the dialog marks its own keys so the panel behind it leaves Escape alone", async () => {
  const dialog = await open()
  expect(dialog.getAttribute("role")).toBe("dialog")
  expect(isBrowserSecretsDialogTarget(find(dialog, "browser-secret-name"))).toBe(true)
  expect(isBrowserSecretsDialogTarget(document.body)).toBe(false)
  expect(isBrowserSecretsDialogTarget(null)).toBe(false)
})

test("the feature is reported to the desktop, and counts as on only once the desktop confirms it", async () => {
  const reports: unknown[] = []
  let confirm = false
  Reflect.set(window, "__OPENWORK_ELECTRON__", { invokeDesktop: async (command: string, enabled: unknown) => {
    if (command !== "browserSecretsSetEnabled") throw new Error(`Unexpected desktop command in this test: ${command}`)
    reports.push(enabled)
    return enabled === true && confirm
  } })
  const seen: boolean[] = []
  function Probe({ requested }: { requested: boolean }) {
    seen.push(useBrowserSecretsReport(requested))
    return null
  }
  const client = new QueryClient()
  root = createRoot(document.createElement("div"))
  const show = async (requested: boolean) => {
    await act(async () => root?.render(<QueryClientProvider client={client}><Probe requested={requested} /></QueryClientProvider>))
    await settle()
  }

  await show(false)
  expect(reports).toEqual([false])
  expect(seen.at(-1)).toBe(false)

  await show(true)
  expect(reports).toEqual([false, true])
  expect(seen.at(-1)).toBe(false)

  confirm = true
  await show(false)
  await show(true)
  expect(reports).toEqual([false, true, false, true])
  expect(seen.at(-1)).toBe(true)

  await show(false)
  expect(reports).toEqual([false, true, false, true, false])
  expect(seen.at(-1)).toBe(false)
  expect(seen.filter(Boolean).length).toBeGreaterThan(0)
})
