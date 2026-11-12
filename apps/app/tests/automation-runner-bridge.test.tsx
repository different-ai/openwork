/** @jsxImportSource react */
import { GlobalRegistrator } from "@happy-dom/global-registrator"
import { afterAll, afterEach, expect, mock, spyOn, test } from "bun:test"
import { act } from "react"
import { createRoot } from "react-dom/client"
import type { AutomationDesktopRunnerRegistration, AutomationRunnerTokenResponse } from "@openwork/types/automations"

import * as den from "../src/app/lib/den"
import * as auth from "../src/react-app/domains/cloud/den-auth-provider"
import * as activation from "../src/react-app/domains/cloud/enterprise-activation-gate"
import * as availability from "../src/react-app/domains/automations/automation-availability"
import { AutomationRunnerBridge } from "../src/react-app/domains/automations/automation-runner-bridge"
import { markThisComputerConnected, useComputerConnectionStore } from "../src/react-app/domains/devices/computer-connection-store"

const ownedDom = typeof window === "undefined"
if (ownedDom) GlobalRegistrator.register({ url: "http://localhost/" })
const previousAct = Reflect.get(globalThis, "IS_REACT_ACT_ENVIRONMENT")
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true)
const cleanups: (() => Promise<void>)[] = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
  markThisComputerConnected()
  mock.restore()
})
afterAll(async () => {
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", previousAct)
  if (ownedDom) await GlobalRegistrator.unregister()
})

test("a stale session-runner 404 cannot disconnect the replacement Automation runner", async () => {
  const previousBridge = window.__OPENWORK_ELECTRON__
  const previousRunnerId = localStorage.getItem("openwork.automations.desktop-runner-id")
  const configurations: unknown[] = []
  Reflect.set(window, "__OPENWORK_ELECTRON__", {
    invokeDesktop: async (command: string, configuration: unknown) => {
      if (command === "appBuildInfo") return { version: "test" }
      if (command === "automationRunnerConfigure") configurations.push(configuration)
    },
  })
  cleanups.push(async () => {
    Reflect.set(window, "__OPENWORK_ELECTRON__", previousBridge)
    if (previousRunnerId === null) localStorage.removeItem("openwork.automations.desktop-runner-id")
    else localStorage.setItem("openwork.automations.desktop-runner-id", previousRunnerId)
  })

  spyOn(activation, "useEnterpriseActivationRequired").mockReturnValue(false)
  spyOn(auth, "useDenAuth").mockReturnValue({
    status: "signed_in", user: null, verifiedIdentity: null,
    error: null, isSignedIn: true, refresh: async () => {},
  })
  const deployment = spyOn(availability, "useDesktopAutomationsEnabled").mockReturnValue(false)
  const settings = den.readDenSettings()
  spyOn(den, "readDenSettings").mockReturnValue({ ...settings, authToken: "test-token", activeOrgId: "org_test" })
  const client = den.createDenClient({ baseUrl: "https://den.example.test", token: "test-token" })
  const request = Promise.withResolvers<AutomationRunnerTokenResponse>()
  let sessionRequests = 0
  spyOn(den, "createDenClient").mockReturnValue({
    ...client,
    mintSessionRunnerToken: async () => { sessionRequests += 1; return request.promise },
    mintAutomationRunnerToken: async () => ({
      token: "replacement-token", expiresAt: "2026-10-12T23:00:00Z", eventsPath: "/v1/automation-runners/events",
    }),
  })

  const host = document.createElement("div")
  document.body.append(host)
  const root = createRoot(host)
  cleanups.push(async () => { await act(async () => root.unmount()); host.remove() })
  await act(async () => { root.render(<AutomationRunnerBridge />) })
  expect(sessionRequests).toBe(1)

  deployment.mockReturnValue(true)
  await act(async () => { root.render(<AutomationRunnerBridge />) })
  expect(configurations.at(-1)).toMatchObject({ token: "replacement-token" })
  const count = configurations.length

  await act(async () => {
    request.reject(new den.DenApiError(404, "feature_disabled", "Old Den has no session runner route"))
  })
  expect(configurations).toHaveLength(count)
  expect(configurations.at(-1)).toMatchObject({ token: "replacement-token" })
})

const answerSet = ["model_attention_v1", "remote_session_v1", "remote_session_control_v1", "remote_session_recovery_v1", "remote_session_answer_v1"]
const sessionOnlySet = ["remote_session_v1", "remote_session_control_v1", "remote_session_recovery_v1", "remote_session_only_v1"]

/** Mounts the bridge against a Den that refuses the first `refused` registrations with a 400. */
async function registerAgainst(input: { automations: boolean; refused: number }) {
  const previousBridge = window.__OPENWORK_ELECTRON__
  const configurations: unknown[] = []
  Reflect.set(window, "__OPENWORK_ELECTRON__", {
    invokeDesktop: async (command: string, configuration: unknown) => {
      if (command === "appBuildInfo") return { version: "test" }
      if (command === "automationRunnerConfigure") configurations.push(configuration)
    },
  })
  const previousRunnerId = localStorage.getItem("openwork.automations.desktop-runner-id")
  cleanups.push(async () => {
    Reflect.set(window, "__OPENWORK_ELECTRON__", previousBridge)
    if (previousRunnerId === null) localStorage.removeItem("openwork.automations.desktop-runner-id")
    else localStorage.setItem("openwork.automations.desktop-runner-id", previousRunnerId)
  })
  spyOn(activation, "useEnterpriseActivationRequired").mockReturnValue(false)
  spyOn(auth, "useDenAuth").mockReturnValue({
    status: "signed_in", user: null, verifiedIdentity: null,
    error: null, isSignedIn: true, refresh: async () => {},
  })
  spyOn(availability, "useDesktopAutomationsEnabled").mockReturnValue(input.automations)
  const settings = den.readDenSettings()
  spyOn(den, "readDenSettings").mockReturnValue({ ...settings, authToken: "test-token", activeOrgId: "org_test" })
  const client = den.createDenClient({ baseUrl: "https://den.example.test", token: "test-token" })
  const attempts: string[][] = []
  const mint = async (_organizationId: string, registration: AutomationDesktopRunnerRegistration) => {
    attempts.push(registration.capabilities)
    if (attempts.length <= input.refused) throw new den.DenApiError(400, "invalid_request", "Too many capabilities")
    return { token: `token-${attempts.length}`, expiresAt: "2026-11-10T23:00:00Z", eventsPath: "/v1/automation-runners/events" }
  }
  spyOn(den, "createDenClient").mockReturnValue({ ...client, mintAutomationRunnerToken: mint, mintSessionRunnerToken: mint })
  const host = document.createElement("div")
  document.body.append(host)
  const root = createRoot(host)
  cleanups.push(async () => { await act(async () => root.unmount()); host.remove() })
  await act(async () => { root.render(<AutomationRunnerBridge />) })
  return { attempts, configurations }
}

const accessAndChoice = ["remote_session_access_v1", "remote_session_choice_v1"]

test("the runner registers for the owner's choice and session access first, within the capability limit", async () => {
  const withAutomations = await registerAgainst({ automations: true, refused: 0 })
  expect(withAutomations.attempts).toEqual([[...answerSet, ...accessAndChoice]])
  expect(withAutomations.attempts[0]).toHaveLength(7)
  expect(withAutomations.configurations.at(-1)).toMatchObject({ token: "token-1" })
})

test("a session-only runner registers for the owner's choice and session access first, within the capability limit", async () => {
  const sessionOnly = await registerAgainst({ automations: false, refused: 0 })
  expect(sessionOnly.attempts).toEqual([[...sessionOnlySet, "remote_session_answer_v1", ...accessAndChoice]])
  expect(sessionOnly.attempts[0]).toHaveLength(7)
  expect(sessionOnly.configurations.at(-1)).toMatchObject({ token: "token-1" })
})

test("a Den from before the owner's choice still registers the runner for session access", async () => {
  const before = await registerAgainst({ automations: true, refused: 1 })
  expect(before.attempts).toEqual([[...answerSet, ...accessAndChoice], [...answerSet, "remote_session_access_v1"]])
  expect(before.configurations.at(-1)).toMatchObject({ token: "token-2" })
})

test("a released Den that refuses six capabilities still registers the runner with the sets it accepts today", async () => {
  const released = await registerAgainst({ automations: true, refused: 2 })
  expect(released.attempts).toEqual([[...answerSet, ...accessAndChoice], [...answerSet, "remote_session_access_v1"], answerSet])
  expect(released.configurations.at(-1)).toMatchObject({ token: "token-3" })
})

test("an older Den steps down through every earlier capability set in order", async () => {
  const older = await registerAgainst({ automations: true, refused: 6 })
  expect(older.attempts).toEqual([
    [...answerSet, ...accessAndChoice],
    [...answerSet, "remote_session_access_v1"],
    answerSet,
    answerSet.slice(0, 4),
    answerSet.slice(0, 3),
    answerSet.slice(0, 2),
    answerSet.slice(0, 1),
  ])
  expect(older.configurations.at(-1)).toMatchObject({ token: "token-7" })
})

test("a released Den registers a session-only runner with the sets it accepts today", async () => {
  const released = await registerAgainst({ automations: false, refused: 3 })
  expect(released.attempts).toEqual([
    [...sessionOnlySet, "remote_session_answer_v1", ...accessAndChoice],
    [...sessionOnlySet, "remote_session_answer_v1", "remote_session_access_v1"],
    [...sessionOnlySet, "remote_session_answer_v1"],
    sessionOnlySet,
  ])
  expect(released.configurations.at(-1)).toMatchObject({ token: "token-4" })
})

const DISCONNECTED_RETRY_MS = 5 * 60_000
const disconnectedError = () => new den.DenApiError(403, "computer_disconnected", "This computer was disconnected from the organization.")
const thisComputerDisconnected = () => useComputerConnectionStore.getState().disconnectedSignIn !== null
const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)) })

/**
 * Mounts the bridge on a signed-in desktop whose runner token requests are
 * answered by `mint`. Waits of a second or more are held instead of run, so a
 * test sees every retry the bridge plans and lets one come due with `elapse`.
 */
async function mountSignedIn(mint: (attempt: number) => AutomationRunnerTokenResponse | Promise<AutomationRunnerTokenResponse>) {
  const previousBridge = window.__OPENWORK_ELECTRON__
  const previousRunnerId = localStorage.getItem("openwork.automations.desktop-runner-id")
  const configurations: unknown[] = []
  let rejected: ((rejection?: { reason: "computer_disconnected" | "credential_rejected" }) => void) | undefined
  Reflect.set(window, "__OPENWORK_ELECTRON__", {
    invokeDesktop: async (command: string, configuration: unknown) => {
      if (command === "appBuildInfo") return { version: "test" }
      if (command === "automationRunnerConfigure") configurations.push(configuration)
    },
    automationRunner: { onCredentialRejected: (callback: typeof rejected) => { rejected = callback; return () => { rejected = undefined } } },
  })
  cleanups.push(async () => {
    Reflect.set(window, "__OPENWORK_ELECTRON__", previousBridge)
    if (previousRunnerId === null) localStorage.removeItem("openwork.automations.desktop-runner-id")
    else localStorage.setItem("openwork.automations.desktop-runner-id", previousRunnerId)
  })
  const held: Array<{ run: () => void; ms: number; live: boolean }> = []
  const realSetTimeout = globalThis.setTimeout
  const realClearTimeout = globalThis.clearTimeout
  spyOn(globalThis, "setTimeout").mockImplementation(((run: () => void, ms?: number) => {
    if (!ms || ms < 1_000) return realSetTimeout(run, ms)
    const timer = { run, ms, live: true }
    held.push(timer)
    return timer
  }) as typeof setTimeout)
  spyOn(globalThis, "clearTimeout").mockImplementation(((timer?: unknown) => {
    const entry = held.find((candidate) => candidate === timer)
    if (entry) entry.live = false
    else realClearTimeout(timer as Parameters<typeof clearTimeout>[0])
  }) as typeof clearTimeout)

  let signInChecks = 0
  spyOn(activation, "useEnterpriseActivationRequired").mockReturnValue(false)
  spyOn(auth, "useDenAuth").mockReturnValue({
    status: "signed_in", user: null, verifiedIdentity: null,
    error: null, isSignedIn: true, refresh: async () => { signInChecks += 1 },
  })
  spyOn(availability, "useDesktopAutomationsEnabled").mockReturnValue(true)
  const settings = den.readDenSettings()
  let authToken = "first-sign-in"
  spyOn(den, "readDenSettings").mockImplementation(() => ({ ...settings, authToken, activeOrgId: "org_test" }))
  const client = den.createDenClient({ baseUrl: "https://den.example.test", token: authToken })
  let mints = 0
  const mintToken = async () => mint(++mints)
  spyOn(den, "createDenClient").mockReturnValue({ ...client, mintAutomationRunnerToken: mintToken, mintSessionRunnerToken: mintToken })
  const host = document.createElement("div")
  document.body.append(host)
  const root = createRoot(host)
  cleanups.push(async () => { await act(async () => root.unmount()); host.remove() })
  await act(async () => { root.render(<AutomationRunnerBridge />) })
  await settle()
  const settingsChanged = async () => {
    await act(async () => { window.dispatchEvent(new CustomEvent("openwork-den-settings-changed")) })
    await settle()
  }
  return {
    configurations,
    mints: () => mints,
    signInChecks: () => signInChecks,
    /** Waits the bridge has planned, in milliseconds. */
    waiting: () => held.filter((timer) => timer.live).map((timer) => timer.ms),
    /** Lets the one planned wait come due. */
    async elapse() {
      const due = held.filter((timer) => timer.live)
      expect(due).toHaveLength(1)
      due[0].live = false
      await act(async () => { due[0].run() })
      await settle()
    },
    /** What the main process says when Den refuses the running runner's credential. */
    async runnerRejected(rejection?: { reason: "computer_disconnected" | "credential_rejected" }) {
      await act(async () => { rejected?.(rejection) })
      await settle()
    },
    /** Den settings changed without a new sign-in, e.g. the app wrote the same values again. */
    settingsChanged,
    async signInAgain() {
      authToken = "second-sign-in"
      await settingsChanged()
    },
  }
}
const runnerToken = (attempt: number): AutomationRunnerTokenResponse => ({
  token: `token-${attempt}`, expiresAt: "2026-11-11T23:00:00Z", eventsPath: "/v1/automation-runners/events",
})

test("a disconnected computer is not minted for again until five minutes pass", async () => {
  const bridge = await mountSignedIn((attempt) => { if (attempt <= 2) throw disconnectedError(); return runnerToken(attempt) })
  expect(bridge.mints()).toBe(1)
  expect(thisComputerDisconnected()).toBe(true)
  expect(bridge.configurations).toEqual([null])
  expect(bridge.signInChecks()).toBe(0)
  // No immediate retry and no backoff loop: one wait, the long one.
  expect(bridge.waiting()).toEqual([DISCONNECTED_RETRY_MS])

  // The same sign-in, or coming back online, is not a reason to ask again.
  await bridge.settingsChanged()
  await act(async () => { window.dispatchEvent(new Event("online")) })
  await settle()
  expect(bridge.mints()).toBe(1)
  expect(bridge.waiting()).toEqual([DISCONNECTED_RETRY_MS])

  await bridge.elapse()
  expect(bridge.mints()).toBe(2)
  expect(thisComputerDisconnected()).toBe(true)
  expect(bridge.waiting()).toEqual([DISCONNECTED_RETRY_MS])

  await bridge.elapse()
  expect(bridge.mints()).toBe(3)
  expect(thisComputerDisconnected()).toBe(false)
  expect(bridge.configurations.at(-1)).toMatchObject({ token: "token-3" })
})

test("signing in again reconnects a disconnected computer at once", async () => {
  const bridge = await mountSignedIn((attempt) => { if (attempt === 1) throw disconnectedError(); return runnerToken(attempt) })
  expect(bridge.mints()).toBe(1)
  expect(thisComputerDisconnected()).toBe(true)
  await bridge.signInAgain()
  expect(bridge.mints()).toBe(2)
  expect(thisComputerDisconnected()).toBe(false)
  expect(bridge.configurations.at(-1)).toMatchObject({ token: "token-2" })
  expect(bridge.waiting()).toEqual([30 * 60_000])
})

test("a new sign-in clears the disconnect even before a runner token is issued", async () => {
  const bridge = await mountSignedIn(() => { throw disconnectedError() })
  expect(thisComputerDisconnected()).toBe(true)
  await bridge.signInAgain()
  // Den refuses the new sign-in too (another organization's disconnect): the state follows what Den said last.
  expect(bridge.mints()).toBe(2)
  expect(thisComputerDisconnected()).toBe(true)
  expect(bridge.waiting()).toEqual([DISCONNECTED_RETRY_MS])
})

test("a refused sign-in on the mint has the sign-in checked instead of being retried", async () => {
  const bridge = await mountSignedIn(() => { throw new den.DenApiError(401, "unauthorized", "Sign in again.") })
  expect(bridge.mints()).toBe(1)
  expect(bridge.signInChecks()).toBe(1)
  expect(thisComputerDisconnected()).toBe(false)
  expect(bridge.configurations).toEqual([])
  // No backoff loop against a sign-in Den refuses; the usual refresh is all that is planned.
  expect(bridge.waiting()).toEqual([30 * 60_000])
})

test("a 401 that is not Den's verdict on the sign-in keeps the ordinary retry", async () => {
  const bridge = await mountSignedIn((attempt) => { if (attempt === 1) throw new den.DenApiError(401, "request_failed", "Proxy sign-in required"); return runnerToken(attempt) })
  expect(bridge.mints()).toBe(1)
  expect(bridge.signInChecks()).toBe(0)
  expect(bridge.waiting()).toEqual([1_000])
  await bridge.elapse()
  expect(bridge.mints()).toBe(2)
  expect(bridge.configurations.at(-1)).toMatchObject({ token: "token-2" })
})

test("a disconnect reported by the runner waits for a new sign-in; an ordinary rejection re-mints at once", async () => {
  const bridge = await mountSignedIn(runnerToken)
  expect(bridge.mints()).toBe(1)
  expect(bridge.configurations.at(-1)).toMatchObject({ token: "token-1" })

  await bridge.runnerRejected({ reason: "credential_rejected" })
  expect(bridge.mints()).toBe(2)
  expect(bridge.configurations.at(-1)).toMatchObject({ token: "token-2" })
  expect(thisComputerDisconnected()).toBe(false)
  expect(bridge.signInChecks()).toBe(0)

  await bridge.runnerRejected({ reason: "computer_disconnected" })
  expect(bridge.mints()).toBe(2)
  expect(thisComputerDisconnected()).toBe(true)
  // The disconnect usually ended the sign-in as well: it is checked now.
  expect(bridge.signInChecks()).toBe(1)
  expect(bridge.waiting()).toEqual([DISCONNECTED_RETRY_MS])
  await bridge.settingsChanged()
  expect(bridge.mints()).toBe(2)

  await bridge.signInAgain()
  expect(bridge.mints()).toBe(3)
  expect(thisComputerDisconnected()).toBe(false)
  expect(bridge.configurations.at(-1)).toMatchObject({ token: "token-3" })
})
