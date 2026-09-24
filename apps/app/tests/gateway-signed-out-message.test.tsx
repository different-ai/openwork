import { afterAll, expect, test } from "bun:test"
import { GlobalRegistrator } from "@happy-dom/global-registrator"
import type { UIMessage } from "ai"
import { act } from "react"

GlobalRegistrator.register({ url: "http://localhost" })
Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true })
afterAll(async () => { await GlobalRegistrator.unregister() })
const { createRoot } = await import("react-dom/client")
const { MessageList } = await import("../src/components/chat/message-list")
const { MessageListProvider } = await import("../src/components/chat/message-list-provider")
const { GatewayModelAccessProvider } = await import("../src/react-app/domains/connections/provider-auth/gateway-model-access")
const { createSessionErrorUIMessage } = await import("../src/react-app/domains/session/sync/usechat-adapter")
const { presentOpencodeSessionError } = await import("../src/react-app/domains/session/sync/session-error")
const { createDefaultPlatform, PlatformProvider } = await import("../src/react-app/kernel/platform")

const body = '{"error":{"code":"openwork_auth_required","message":"Connect your google-vertex account","provider_id":"ipr_google","credential_set_id":"gcs_member"}}'
const question: UIMessage = { id: "user-1", role: "user", parts: [{ type: "text", text: "Summarize the launch plan" }] }

async function render(input: { login: () => Promise<boolean>; failure?: { status: number; body: string }; gatewayProvider?: { providerId: string; providerName: string } }) {
  const resent: string[] = []
  const host = document.createElement("div")
  document.body.append(host)
  const root = createRoot(host)
  const failure = input.failure ?? { status: 401, body }
  const failed = createSessionErrorUIMessage("assistant-turn", presentOpencodeSessionError({ name: "APIError", data: { message: failure.body, statusCode: failure.status } }))
  await act(async () => root.render(
    <PlatformProvider value={createDefaultPlatform()}>
    <GatewayModelAccessProvider providers={[]} scopeKey="org/session" login={input.login}>
      <MessageListProvider
        workspaceId="workspace-1" sessionId="session-1" showThinking={false} developerMode={false} displaySuggestions={false}
        providerConnectedCount={1} dispatchAction={() => undefined} setPrompt={() => undefined}
        onRevertToUserMessage={() => undefined} onForkAtMessage={() => undefined} onEditUserMessage={() => undefined}
        onResumeInterrupted={(text) => { resent.push(text) }}
        onMcpReconnect={async () => "connected"} onMcpReopenAuthorization={async () => undefined}
        modelLabel="Gemini 2.5 Pro"
        gatewayProvider={input.gatewayProvider ?? null}
      >
        <MessageList messages={[question, failed]} status="ready" />
      </MessageListProvider>
    </GatewayModelAccessProvider>
    </PlatformProvider>,
  ))
  const click = async (text: string) => {
    const button = [...host.querySelectorAll("button")].find((node) => node.textContent === text)
    if (!button) throw new Error(`Missing ${text}; saw ${host.textContent}`)
    await act(async () => button.click())
  }
  return { host, resent, click, unmount: async () => { await act(async () => root.unmount()); host.remove() } }
}

test("the failed message names who signed the person out and which model couldn't answer", async () => {
  const view = await render({ login: async () => true })
  try {
    expect(view.host.textContent).toContain("Google signed you out, so Gemini 2.5 Pro couldn't answer.")
    expect(view.host.textContent).toContain("Your message is kept. It sends again once you're signed in.")
    expect(view.host.textContent).toContain("Sign in again")
    expect(view.host.textContent).toContain("Switch model")
    expect(view.host.textContent).not.toContain("Use Claude")
    expect(view.host.textContent).not.toContain("Choose group and credential set")
    expect(view.host.textContent).not.toContain("Connect")
  } finally { await view.unmount() }
})

test("Sign in again runs in place, then sends the failed message again", async () => {
  let release: (ready: boolean) => void = () => undefined
  const view = await render({ login: () => new Promise<boolean>((resolve) => { release = resolve }) })
  try {
    await view.click("Sign in again")
    expect(view.host.textContent).toContain("Finish signing in in your browser.")
    expect(view.resent).toEqual([])
    await act(async () => { release(true) })
    expect(view.resent).toEqual(["Summarize the launch plan"])
  } finally { await view.unmount() }
})

test("a sign-in that doesn't finish sends nothing and offers Try again; Cancel sends nothing", async () => {
  const view = await render({ login: async () => false })
  try {
    await view.click("Sign in again")
    expect(view.host.textContent).toContain("Sign-in didn't finish.")
    expect(view.resent).toEqual([])
  } finally { await view.unmount() }
  let release: (ready: boolean) => void = () => undefined
  const cancelled = await render({ login: () => new Promise<boolean>((resolve) => { release = resolve }) })
  try {
    await cancelled.click("Sign in again")
    await cancelled.click("Cancel")
    await act(async () => { release(true) })
    expect(cancelled.resent).toEqual([])
  } finally { await cancelled.unmount() }
})

test("Switch model opens the picker for this conversation and picks nothing itself", async () => {
  const opened: unknown[] = []
  const listener = (event: Event) => { opened.push((event as CustomEvent).detail) }
  window.addEventListener("openwork-open-model-picker", listener)
  const view = await render({ login: async () => true })
  try {
    await view.click("Switch model")
    expect(opened).toEqual([{ sessionId: "session-1" }])
    expect(view.resent).toEqual([])
  } finally {
    window.removeEventListener("openwork-open-model-picker", listener)
    await view.unmount()
  }
})

test("a Gateway model the person's own account can't use says so, with only Switch model", async () => {
  const view = await render({
    login: async () => true,
    failure: { status: 403, body: "Permission denied on resource project acme-studio" },
    gatewayProvider: { providerId: "ipr_google", providerName: "Google Cloud" },
  })
  try {
    expect(view.host.textContent).toContain("Your Google account can't use Gemini 2.5 Pro")
    expect(view.host.textContent).toContain("Ask your admin for access, or switch model.")
    expect(view.host.textContent).toContain("Switch model")
    expect(view.host.textContent).not.toContain("Sign in")
  } finally { await view.unmount() }
})
