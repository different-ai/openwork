/** @jsxImportSource react */
import { GlobalRegistrator } from "@happy-dom/global-registrator"
import { afterAll, afterEach, beforeAll, expect, mock, spyOn, test } from "bun:test"
import { act } from "react"
import type { DenAuthStore } from "../src/react-app/domains/cloud/den-auth-provider"

// The app's stores keep themselves in the window's storage: load them once there is a window.
let den: typeof import("../src/app/lib/den")
let toast: typeof import("../src/components/ui/sonner")["toast"]
let authProvider: typeof import("../src/react-app/domains/cloud/den-auth-provider")
let connection: typeof import("../src/react-app/domains/devices/computer-connection-store")
let explainSignOutAfterDisconnect: typeof import("../src/react-app/domains/devices/disconnected-sign-out")["explainSignOutAfterDisconnect"]
let useNotificationStore: typeof import("../src/react-app/kernel/notification-store")["useNotificationStore"]
let createRoot: typeof import("react-dom/client")["createRoot"]

const ownedDom = !GlobalRegistrator.isRegistered && typeof document === "undefined"
const previousAct = Reflect.get(globalThis, "IS_REACT_ACT_ENVIRONMENT")
const cleanups: (() => Promise<void>)[] = []

beforeAll(async () => {
  if (ownedDom) GlobalRegistrator.register({ url: "http://localhost/" })
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true)
  createRoot = (await import("react-dom/client")).createRoot
  den = await import("../src/app/lib/den")
  toast = (await import("../src/components/ui/sonner")).toast
  authProvider = await import("../src/react-app/domains/cloud/den-auth-provider")
  connection = await import("../src/react-app/domains/devices/computer-connection-store")
  explainSignOutAfterDisconnect = (await import("../src/react-app/domains/devices/disconnected-sign-out")).explainSignOutAfterDisconnect
  useNotificationStore = (await import("../src/react-app/kernel/notification-store")).useNotificationStore
})
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
  connection.markThisComputerConnected()
  den.clearDenSession()
  useNotificationStore.getState().clearAll()
  mock.restore()
})
afterAll(async () => {
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", previousAct)
  if (ownedDom) await GlobalRegistrator.unregister()
})

const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)) })
const told = () => useNotificationStore.getState().notifications.map((entry) => ({ title: entry.title, count: entry.count, severity: entry.severity }))
const disconnectHere = () => connection.markThisComputerDisconnected(connection.denSignInKey(den.readDenSettings()))
const disconnectedHere = () => connection.useComputerConnectionStore.getState().disconnectedSignIn !== null
/** Every sign-in has its own session: a new token each time, as Den issues. */
let signIns = 0
const storeSignIn = (organization: string | null) => den.writeDenSettings(
  { baseUrl: "https://den.example.test", authToken: `session-${++signIns}`, activeOrgId: "org_test", activeOrgSlug: "test", activeOrgName: organization },
  { persistBootstrap: false },
)

/** The app with a stored sign-in to `organization`, whose session Den accepts until `endSession()`. */
async function signedIn(organization: string | null, session: "live" | "gone" = "live") {
  if (!den.readDenSettings().authToken) storeSignIn(organization)
  let live = session === "live"
  const client = den.createDenClient({ baseUrl: "https://den.example.test", token: den.readDenSettings().authToken ?? "" })
  const { DenAuthProvider, useDenAuth } = authProvider
  spyOn(den, "createDenClient").mockReturnValue({
    ...client,
    getSession: async () => {
      if (!live) throw new den.DenApiError(401, "unauthorized", "Sign in again.")
      return { id: "user_test", email: "ada@example.test", name: "Ada" }
    },
  })
  spyOn(den, "ensureDenActiveOrganization").mockResolvedValue(null)
  let auth: DenAuthStore | undefined
  function Probe() { auth = useDenAuth(); return null }
  const host = document.createElement("div")
  document.body.append(host)
  const root = createRoot(host)
  cleanups.push(async () => { await act(async () => root.unmount()); host.remove() })
  await act(async () => { root.render(<DenAuthProvider><Probe /></DenAuthProvider>) })
  await settle()
  return {
    status: () => auth?.status,
    endSession: () => { live = false },
    /** The sign-in check the runner bridge and the device reporter ask for. */
    async checkSignIn() {
      await act(async () => { await auth?.refresh() })
      await settle()
    },
  }
}

test("signed out because this computer was disconnected: the person is told why, once, with the organization's name", async () => {
  const info = spyOn(toast, "info")
  const app = await signedIn("Acme")
  expect(app.status()).toBe("signed_in")
  // Den refuses this computer (the runner or the device report heard `computer_disconnected`) and ended its sign-in.
  disconnectHere()
  app.endSession()
  await app.checkSignIn()
  expect(app.status()).toBe("signed_out")
  expect(den.readDenSettings().authToken ?? "").toBe("")
  expect(told()).toEqual([{ title: "This computer was disconnected from Acme. Sign in again to reconnect it.", count: 1, severity: "info" }])
  expect(info.mock.calls.map((call) => call[0])).toEqual(["This computer was disconnected from Acme. Sign in again to reconnect it."])
  expect(disconnectedHere()).toBe(false)

  // Later checks of the signed-out app say nothing more.
  await app.checkSignIn()
  await act(async () => { window.dispatchEvent(new CustomEvent("openwork-den-settings-changed")) })
  await settle()
  expect(told()).toHaveLength(1)
  expect(told()[0].count).toBe(1)
})

test("without a known organization name the message says your organization", async () => {
  storeSignIn(null)
  disconnectHere()
  const app = await signedIn(null, "gone")
  expect(app.status()).toBe("signed_out")
  expect(told().map((entry) => entry.title)).toEqual(["This computer was disconnected from your organization. Sign in again to reconnect it."])
})

test("an expired session on a connected computer signs out without that message", async () => {
  const app = await signedIn("Acme")
  app.endSession()
  await app.checkSignIn()
  expect(app.status()).toBe("signed_out")
  expect(told()).toEqual([])
})

test("signing out of a disconnected computer is an ordinary sign-out: nothing is said", async () => {
  const app = await signedIn("Acme")
  disconnectHere()
  // What the app's Sign out does: clear the session, then let the provider look again.
  await act(async () => { den.clearDenSession() })
  await app.checkSignIn()
  expect(app.status()).toBe("signed_out")
  expect(told()).toEqual([])
  expect(disconnectedHere()).toBe(false)
})

test("a disconnected computer whose sign-in still works is not signed out and nothing is said", async () => {
  const app = await signedIn("Acme")
  disconnectHere()
  await app.checkSignIn()
  expect(app.status()).toBe("signed_in")
  expect(told()).toEqual([])
  expect(disconnectedHere()).toBe(true)
})

test("two checks that find the same session gone tell the person once; a later disconnect is told again", async () => {
  storeSignIn("Acme")
  disconnectHere()
  explainSignOutAfterDisconnect()
  explainSignOutAfterDisconnect()
  expect(told()).toEqual([{ title: "This computer was disconnected from Acme. Sign in again to reconnect it.", count: 1, severity: "info" }])

  storeSignIn("Acme")
  explainSignOutAfterDisconnect()
  expect(told()[0].count).toBe(1)
  disconnectHere()
  explainSignOutAfterDisconnect()
  expect(told()).toHaveLength(1)
  expect(told()[0].count).toBe(2)
})
