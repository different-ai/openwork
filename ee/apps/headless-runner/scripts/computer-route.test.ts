import assert from "node:assert/strict"
import { test } from "node:test"
import { GatewayHealth, routeComputers, type ComputerSideApi } from "../src/computer-route.js"
import type { ComputerSide } from "../src/store.js"

class Refused extends Error {}
class Unreachable extends Error {}

function fake(name: string, calls: string[], options: { startError?: Error; runError?: Error; has?: () => boolean } = {}): ComputerSideApi {
  return {
    prompt: name, tools: [], toolNames: new Set(["bash"]), image: name,
    start: async (sessionId) => {
      calls.push(`${name}:start:${sessionId}`)
      if (options.startError) throw options.startError
    },
    has: async () => options.has?.() ?? false,
    run: async (sessionId, tool) => {
      calls.push(`${name}:run:${sessionId}:${tool}`)
      if (options.runError) throw options.runError
      return { output: name }
    },
    known: () => false,
    prewarm: () => undefined,
    release: (sessionId) => void calls.push(`${name}:release:${sessionId}`),
    delete: async (sessionId) => {
      calls.push(`${name}:delete:${sessionId}`)
      if (options.runError) throw options.runError
    },
    previewSavedFile: async () => undefined,
  }
}

function setup(options: { direct?: ComputerSideApi | null; gateway?: ComputerSideApi | null; up?: boolean[]; flagged?: (id: string) => boolean; now?: () => number } = {}) {
  const calls: string[] = []
  const logs: string[] = []
  const sides = new Map<string, ComputerSide>()
  const answers = [...(options.up ?? [true])]
  let probes = 0
  const health = new GatewayHealth(async () => {
    probes++
    const up = answers.length > 1 ? answers.shift()! : answers[0]!
    return { up, reason: up ? "healthy" : "down" }
  }, { log: (message) => void logs.push(message), ...(options.now ? { now: options.now } : {}) })
  const computer = routeComputers({
    direct: options.direct === null ? undefined : options.direct ?? fake("direct", calls),
    gateway: options.gateway === null ? undefined : options.gateway ?? fake("gateway", calls),
    health,
    viaGateway: options.flagged ?? ((id) => id.startsWith("on")),
    sides: { get: (id) => sides.get(id) ?? null, set: (id, side) => void sides.set(id, side), clear: (id) => void sides.delete(id) },
    infrastructure: (error) => error instanceof Unreachable,
    log: (message) => void logs.push(message),
  })!
  return { computer, calls, logs, sides, probes: () => probes }
}

test("conversations without the setting stay on the runner's provider and never ask the gateway", async () => {
  const { computer, calls, probes } = setup()
  assert.equal((await computer.run("off", "bash", {})).output, "direct")
  assert.deepEqual(calls, ["direct:run:off:bash"])
  assert.equal(probes(), 0)
})

test("the setting without a configured gateway keeps the runner's provider, logged once", async () => {
  const { computer, logs } = setup({ gateway: null })
  assert.equal((await computer.run("on", "bash", {})).output, "direct")
  assert.equal((await computer.run("on", "bash", {})).output, "direct")
  assert.equal(logs.length, 1)
})

test("a healthy gateway makes the computer, and the conversation stays there", async () => {
  const { computer, calls, sides } = setup()
  assert.equal((await computer.run("on", "bash", {})).output, "gateway")
  assert.equal((await computer.run("on", "bash", {})).output, "gateway")
  assert.equal(sides.get("on"), "gateway")
  assert.deepEqual(calls, ["gateway:start:on", "gateway:run:on:bash", "gateway:run:on:bash"])
})

test("an unhealthy gateway places new computers on the runner's provider, probing at most once per period", async () => {
  const { computer, calls, sides, probes, logs } = setup({ up: [false] })
  assert.equal((await computer.run("on-1", "bash", {})).output, "direct")
  assert.equal((await computer.run("on-2", "bash", {})).output, "direct")
  assert.equal(sides.get("on-1"), "direct")
  assert.equal(probes(), 1)
  assert.ok(!calls.some((call) => call.startsWith("gateway")))
  assert.equal(logs.filter((line) => line.includes("unavailable")).length, 1)
})

test("a gateway that cannot start the computer falls back for it and for the next ones", async () => {
  const gatewayCalls: string[] = []
  const { computer, calls, sides, probes } = setup({ gateway: fake("gateway", gatewayCalls, { startError: new Unreachable("connection refused") }) })
  assert.equal((await computer.run("on-1", "bash", {})).output, "direct")
  assert.equal((await computer.run("on-2", "bash", {})).output, "direct")
  assert.equal(sides.get("on-1"), "direct")
  assert.equal(probes(), 1, "the failure closes the gateway until the next probe")
  assert.deepEqual(gatewayCalls, ["gateway:start:on-1"], "never asked again while closed, and nothing ran there")
  assert.deepEqual(calls, ["direct:run:on-1:bash", "direct:run:on-2:bash"])
})

test("the gateway's refusals are errors, never a reason to go around it", async () => {
  const { computer, calls, sides } = setup({ gateway: fake("gateway", [], { startError: new Refused("quota_exceeded") }) })
  await assert.rejects(computer.run("on", "bash", {}), Refused)
  assert.equal(sides.get("on"), undefined)
  assert.deepEqual(calls, [])
})

test("a computer on the gateway stays there: its failures reach the conversation", async () => {
  const calls: string[] = []
  const { computer, sides } = setup({ gateway: fake("gateway", calls, { runError: new Unreachable("gateway down") }) })
  sides.set("on", "gateway")
  await assert.rejects(computer.run("on", "bash", {}), /gateway down/)
  assert.deepEqual(calls, ["gateway:run:on:bash"])
})

test("a fallback computer is kept while it exists; once it is gone the next goes through the gateway", async () => {
  let exists = true
  const calls: string[] = []
  const { computer, sides } = setup({ direct: fake("direct", calls, { has: () => exists }), gateway: fake("gateway", calls) })
  sides.set("on", "direct")
  assert.equal((await computer.run("on", "bash", {})).output, "direct")
  exists = false
  assert.equal((await computer.run("on", "bash", {})).output, "gateway")
  assert.equal(sides.get("on"), "gateway")
})

test("deleting removes the conversation's computer on both sides and forgets where it was", async () => {
  const calls: string[] = []
  const { computer, sides } = setup({ direct: fake("direct", calls), gateway: fake("gateway", calls, { runError: new Unreachable("down") }) })
  sides.set("on", "direct")
  await computer.delete("on")
  assert.deepEqual(calls.sort(), ["direct:delete:on", "gateway:delete:on"])
  assert.equal(sides.get("on"), undefined)
  sides.set("on", "gateway")
  await assert.rejects(computer.delete("on"), /down/)
})

test("with only a gateway, conversations without the setting have no computer", async () => {
  const { computer } = setup({ direct: null })
  assert.equal(computer.available?.("on"), true)
  assert.equal(computer.available?.("off"), false)
  await assert.rejects(computer.run("off", "bash", {}), /no computer/)
  assert.equal((await computer.run("on", "bash", {})).output, "gateway")
})

test("gateway health is probed again after its period and logs each change once", async () => {
  let now = 0
  const logs: string[] = []
  const answers = [true, false, false, true]
  const health = new GatewayHealth(async () => ({ up: answers.shift()!, reason: "probe" }), { ttlMs: 1000, now: () => now, log: (message) => void logs.push(message) })
  assert.equal(await health.up(), true)
  now = 500
  assert.equal(await health.up(), true, "cached")
  now = 1500
  assert.equal(await health.up(), false)
  now = 2600
  assert.equal(await health.up(), false)
  now = 3700
  assert.equal(await health.up(), true)
  assert.equal(logs.length, 3)
})
