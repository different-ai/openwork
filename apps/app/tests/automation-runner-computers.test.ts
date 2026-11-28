import { afterEach, expect, test } from "bun:test"
import { COMPUTER_SHELL_RUNNER_CAPABILITY } from "@openwork/types/automations"
import { createOpenworkServerClient } from "../src/app/lib/openwork-server"
import { automationRunnerCapabilitySets } from "../src/react-app/domains/automations/automation-runner-capabilities"
import { createComputerRunnerDelivery } from "../src/react-app/domains/automations/computer-runner-delivery"

for (const deploymentEnabled of [true, false]) {
  test(`registration tries shell first with legacy fallbacks (automations enabled: ${deploymentEnabled})`, () => {
    const available = { state: "available" } satisfies Parameters<typeof automationRunnerCapabilitySets>[2]
    const base = automationRunnerCapabilitySets(deploymentEnabled, false, available)
    expect(base.flat()).not.toContain(COMPUTER_SHELL_RUNNER_CAPABILITY)
    expect(automationRunnerCapabilitySets(deploymentEnabled, true)).toEqual(base)
    expect(automationRunnerCapabilitySets(deploymentEnabled, true, { state: "unavailable", reason: "unsupported_platform", message: "Not supported." })).toEqual(base)
    const sets = automationRunnerCapabilitySets(deploymentEnabled, true, available)
    expect(sets.slice(base.length)).toEqual(base)
    expect(sets.slice(0, base.length)).toEqual(base.map(set => [COMPUTER_SHELL_RUNNER_CAPABILITY, ...set]))
    expect(Math.max(...sets.map(set => set.length))).toBe(8)
  })
}

const realFetch = globalThis.fetch
afterEach(() => { globalThis.fetch = realFetch })

const credential = { baseUrl: "https://den.example.test", token: "fake-runner-token" }
const server = (identity: string, port = 4567) => ({
  identity,
  client: createOpenworkServerClient({ baseUrl: `http://127.0.0.1:${port}`, token: "unused-client", hostToken: "fake-host" }),
})

function recordRequests(beforeWrite?: () => Promise<void>) {
  const requests: { method: string; port: string; body: unknown }[] = []
  globalThis.fetch = Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init)
    const url = new URL(request.url)
    expect(url.pathname).toBe("/computers/runner")
    expect(request.headers.get("X-OpenWork-Host-Token")).toBe("fake-host")
    expect(request.headers.has("Authorization")).toBe(false)
    requests.push({ method: request.method, port: url.port, body: request.body ? await request.json() : null })
    if (request.method === "PUT") await beforeWrite?.()
    return new Response(null, { status: 204 })
  }, { preconnect: realFetch.preconnect })
  return requests
}

test("pushes once per local server generation and clears on disconnect", async () => {
  const requests = recordRequests()
  const delivery = createComputerRunnerDelivery()
  await delivery.setServer(server("generation 1"))
  await delivery.setCredential(null)
  expect(requests).toEqual([])
  await delivery.setCredential(credential)
  await delivery.setServer(server("generation 1"))
  await delivery.setServer(server("generation 2"))
  await delivery.setServer(server("generation 3", 4568))
  await delivery.setCredential(null)
  await delivery.setServer(server("generation 3", 4568))
  expect(requests).toEqual([
    { method: "PUT", port: "4567", body: credential },
    { method: "DELETE", port: "4567", body: null },
    { method: "PUT", port: "4567", body: credential },
    { method: "DELETE", port: "4567", body: null },
    { method: "PUT", port: "4568", body: credential },
    { method: "DELETE", port: "4568", body: null },
  ])
})

test("clear follows an in-flight push rather than leaving a late credential behind", async () => {
  const started = Promise.withResolvers<void>()
  const complete = Promise.withResolvers<void>()
  const requests = recordRequests(() => { started.resolve(); return complete.promise })
  const delivery = createComputerRunnerDelivery()
  await delivery.setServer(server("generation 1"))
  const putting = delivery.setCredential(credential)
  await started.promise
  const clearing = delivery.setCredential(null)
  complete.resolve()
  await Promise.all([putting, clearing])
  expect(requests.map(({ method }) => method)).toEqual(["PUT", "DELETE"])
})
