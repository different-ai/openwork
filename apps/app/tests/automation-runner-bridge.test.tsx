/** @jsxImportSource react */
import { GlobalRegistrator } from "@happy-dom/global-registrator"
import { afterAll, afterEach, expect, mock, spyOn, test } from "bun:test"
import { act } from "react"
import { createRoot } from "react-dom/client"
import type { AutomationRunnerTokenResponse } from "@openwork/types/automations"

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
