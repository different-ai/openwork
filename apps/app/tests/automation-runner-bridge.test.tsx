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

const ownedDom = typeof window === "undefined"
if (ownedDom) GlobalRegistrator.register({ url: "http://localhost/" })
const previousAct = Reflect.get(globalThis, "IS_REACT_ACT_ENVIRONMENT")
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true)
const cleanups: (() => Promise<void>)[] = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
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

test("the runner registers for session access first", async () => {
  const withAutomations = await registerAgainst({ automations: true, refused: 0 })
  expect(withAutomations.attempts).toEqual([[...answerSet, "remote_session_access_v1"]])
  expect(withAutomations.configurations.at(-1)).toMatchObject({ token: "token-1" })
})

test("a session-only runner registers for session access first", async () => {
  const sessionOnly = await registerAgainst({ automations: false, refused: 0 })
  expect(sessionOnly.attempts).toEqual([[...sessionOnlySet, "remote_session_answer_v1", "remote_session_access_v1"]])
  expect(sessionOnly.configurations.at(-1)).toMatchObject({ token: "token-1" })
})

test("a released Den that refuses six capabilities still registers the runner with the sets it accepts today", async () => {
  const released = await registerAgainst({ automations: true, refused: 1 })
  expect(released.attempts).toEqual([[...answerSet, "remote_session_access_v1"], answerSet])
  expect(released.configurations.at(-1)).toMatchObject({ token: "token-2" })
})

test("an older Den steps down through every earlier capability set in order", async () => {
  const older = await registerAgainst({ automations: true, refused: 5 })
  expect(older.attempts).toEqual([
    [...answerSet, "remote_session_access_v1"],
    answerSet,
    answerSet.slice(0, 4),
    answerSet.slice(0, 3),
    answerSet.slice(0, 2),
    answerSet.slice(0, 1),
  ])
  expect(older.configurations.at(-1)).toMatchObject({ token: "token-6" })
})

test("a released Den registers a session-only runner with the sets it accepts today", async () => {
  const released = await registerAgainst({ automations: false, refused: 2 })
  expect(released.attempts).toEqual([
    [...sessionOnlySet, "remote_session_answer_v1", "remote_session_access_v1"],
    [...sessionOnlySet, "remote_session_answer_v1"],
    sessionOnlySet,
  ])
  expect(released.configurations.at(-1)).toMatchObject({ token: "token-3" })
})
