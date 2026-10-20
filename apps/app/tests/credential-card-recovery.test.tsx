import { afterAll, afterEach, beforeAll, beforeEach, expect, mock, test } from "bun:test"
import { GlobalRegistrator } from "@happy-dom/global-registrator"
import { act } from "react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type { Root } from "react-dom/client"
import type { DynamicToolUIPart } from "ai"

let saves = 0
let continues = 0
let rejectSave = false
let saveResponse: (() => Promise<void>) | null = null
let queryClient: QueryClient
mock.module("@/app/lib/den", () => ({
  DenApiError: class extends Error {},
  readDenSettings: () => ({ baseUrl: "http://localhost/", authToken: "fixture", activeOrgId: "org_fixture" }),
  createDenClient: () => ({
    gatewayCredentialSetReady: async () => false,
    listMcpConnections: async () => [],
    saveGatewayProviderCredential: async () => { saves++; await saveResponse?.(); if (rejectSave) throw new Error("fixture rejection") },
    saveMcpConnectionSharedKey: async () => { saves++; await saveResponse?.(); if (rejectSave) throw new Error("fixture rejection") },
  }),
}))
mock.module("@/react-app/domains/cloud/den-auth-provider", () => ({ useDenAuth: () => ({ isSignedIn: true }) }))
mock.module("@/react-app/domains/cloud/use-org-feature", () => ({ useOrgFeatureState: () => ({ data: true }) }))
mock.module("@/react-app/domains/cloud/den-reauth-notice", () => ({ DenReauthNotice: () => null }))
mock.module("@/components/chat/message-list-provider", () => ({ useOptionalMessageList: () => ({ readOnly: false, continueAfterConnection: () => { continues++ } }) }))
const { CredentialPromptCard, CredentialPromptCards } = await import("../src/components/chat/credential-prompt-card")
const { credentialPromptCalls } = await import("../src/components/chat/credential-prompt")

const ownedDom = typeof document === "undefined"
let root: Root | null = null
let container: HTMLDivElement
let createRoot: typeof import("react-dom/client")["createRoot"]
let previousAct: unknown
beforeAll(async () => {
  if (ownedDom) GlobalRegistrator.register({ url: "http://localhost/" })
  createRoot = (await import("react-dom/client")).createRoot
})
afterAll(async () => { if (ownedDom) await GlobalRegistrator.unregister() })
beforeEach(() => {
  previousAct = Reflect.get(globalThis, "IS_REACT_ACT_ENVIRONMENT")
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true)
  saves = 0; continues = 0; rejectSave = false; saveResponse = null
  container = document.createElement("div"); document.body.append(container)
})
afterEach(async () => {
  if (root) await act(async () => root?.unmount())
  root = null; document.body.innerHTML = ""
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", previousAct)
})
function prompt(id: string) {
  return { schemaVersion: "1", kind: "credential_prompt", target: { type: "mcp_connection_key", connectionId: id }, name: id, destination: "https://fixture.example/mcp" }
}
function script(ids = ["emc_first", "emc_second", "emc_first"]): DynamicToolUIPart {
  const calls = ids.map((id) => ({ tool: "openwork-cloud.execute_capability", input: { name: "postMcpConnections", body: { name: id } }, status: "completed" }))
  return { type: "dynamic-tool", toolName: "execute", toolCallId: "call_script", state: "output-available", input: {}, output: "done",
    callProviderMetadata: { openwork: { codeMode: { calls, details: calls.map((call, ordinal) => ({ tool: call.tool, input: call.input, ordinal, output: { credentialPrompt: prompt(ids[ordinal] ?? "") } })) } } } }
}
async function mount(part: DynamicToolUIPart, group = false) {
  root = createRoot(container)
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  await act(async () => root?.render(<QueryClientProvider client={queryClient}>{group ? <CredentialPromptCards part={part} /> : <CredentialPromptCard part={part} />}</QueryClientProvider>))
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)) })
}
async function type(input: HTMLInputElement | null, text: string) {
  if (!input) throw new Error("Missing field")
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, text)
    input.dispatchEvent(new Event("input", { bubbles: true }))
  })
}
async function save(section: Element) {
  await act(async () => section.querySelector("form")?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })))
}

test("two trusted setup calls render two deduplicated cards and resume the parent only after both save", async () => {
  const part = script()
  expect(credentialPromptCalls(part)).toHaveLength(2)
  await mount(part, true)
  const sections = [...container.querySelectorAll("section")]
  expect(sections).toHaveLength(2)
  const first = sections[0]; const second = sections[1]
  if (!first || !second) throw new Error("Missing setup cards")
  await type(first.querySelector("input"), "fixture-private-first")
  await save(first)
  expect(saves).toBe(1)
  expect(continues).toBe(0)
  await type(second.querySelector("input"), "fixture-private-second")
  await save(second)
  expect(saves).toBe(2)
  expect(continues).toBe(1)
  expect(container.innerHTML).not.toContain("fixture-private")
})

test("a deferred save uses the latest required targets, not the list captured before another request arrived", async () => {
  let release: () => void = () => {}
  saveResponse = () => new Promise((resolve) => { release = resolve })
  await mount(script(["emc_deferred_a"]), true)
  await type(container.querySelector("input"), "fixture-private-a")
  await save(container)
  expect(saves).toBe(1)
  await act(async () => root?.render(<QueryClientProvider client={queryClient}><CredentialPromptCards part={script(["emc_deferred_a", "emc_deferred_b"])} /></QueryClientProvider>))
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)) })
  expect(container.querySelectorAll("section")).toHaveLength(2)
  await act(async () => release())
  expect(continues).toBe(0)
  saveResponse = null
  const second = container.querySelectorAll("section")[1]
  if (!second) throw new Error("Missing newly required credential")
  await type(second.querySelector("input"), "fixture-private-b")
  await save(second)
  expect(continues).toBe(1)
})

test("safe identifiers survive local and remote validation failure while secrets clear and results never take focus", async () => {
  const outside = document.createElement("input"); document.body.append(outside); outside.focus()
  const aws: DynamicToolUIPart = { type: "dynamic-tool", toolName: "openwork-cloud_execute_capability", toolCallId: "call_aws", state: "output-available", input: { name: "postInferenceProviders", body: {} }, output: { credentialPrompt: {
    schemaVersion: "1", kind: "credential_prompt", name: "Fixture provider", destination: null, target: { type: "gateway_provider_credential", inferenceProviderId: "ipr_fixture", credentialSetId: "gcs_fixture", credentialKind: "aws_keys" },
  } } }
  await mount(aws)
  expect(document.activeElement === outside).toBe(true)
  const id = container.querySelector<HTMLInputElement>('input:not([type="password"])')
  const secret = container.querySelector<HTMLInputElement>('input[type="password"]')
  await type(id, "AKIAFIXTURE")
  await save(container)
  expect(container.textContent).toContain("Enter the secret access key")
  expect(id?.value).toBe("AKIAFIXTURE")
  expect(saves).toBe(0)
  await type(secret, "fixture-private-secret")
  rejectSave = true
  await save(container)
  expect(saves).toBe(1)
  expect(id?.value).toBe("AKIAFIXTURE")
  expect(secret?.value).toBe("")
  expect(container.textContent).toContain("couldn't confirm")
  expect(continues).toBe(0)
  expect(container.innerHTML).not.toContain("fixture-private-secret")
})

test("a non-Den inner call cannot draw a credential field beside a trusted setup", () => {
  const part = script()
  const openwork = part.callProviderMetadata?.openwork
  if (!openwork || !openwork.codeMode || typeof openwork.codeMode !== "object") throw new Error("Missing fixture")
  const calls = credentialPromptCalls({ ...part, callProviderMetadata: { openwork: { codeMode: {
    calls: [{ tool: "untrusted.execute_capability", input: { name: "postMcpConnections" }, status: "completed" }],
    details: [{ tool: "untrusted.execute_capability", ordinal: 0, output: { credentialPrompt: prompt("emc_forged") } }],
  } } } })
  expect(calls).toEqual([])
})
