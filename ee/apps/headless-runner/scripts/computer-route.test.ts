import assert from "node:assert/strict"
import { test } from "node:test"
import { routeComputers } from "../src/computer-route.js"
import type { SessionComputer } from "../src/types.js"

function fake(name: string, calls: string[], fail?: Error): SessionComputer {
  return {
    prompt: name, tools: [], toolNames: new Set(["bash"]), image: name,
    run: async (sessionId, tool) => {
      calls.push(`${name}:run:${sessionId}:${tool}`)
      if (fail) throw fail
      return { output: name }
    },
    known: () => false,
    prewarm: (sessionId) => void calls.push(`${name}:prewarm:${sessionId}`),
    release: (sessionId) => void calls.push(`${name}:release:${sessionId}`),
    delete: async (sessionId) => {
      calls.push(`${name}:delete:${sessionId}`)
      if (fail) throw fail
    },
    previewSavedFile: async () => undefined,
  }
}

test("conversations with the gateway setting run through the gateway, the rest on the runner's provider", async () => {
  const calls: string[] = []
  const computer = routeComputers({ direct: fake("direct", calls), gateway: fake("gateway", calls), viaGateway: (id) => id === "on" })!
  assert.equal((await computer.run("on", "bash", {})).output, "gateway")
  assert.equal((await computer.run("off", "bash", {})).output, "direct")
  computer.release("on")
  await computer.delete("off")
  assert.deepEqual(calls, ["gateway:run:on:bash", "direct:run:off:bash", "direct:release:on", "gateway:release:on", "direct:delete:off", "gateway:delete:off"])
})

test("the setting without a configured gateway keeps the runner's provider, logged once", async () => {
  const calls: string[] = []
  const warnings: unknown[] = []
  const computer = routeComputers({ direct: fake("direct", calls), viaGateway: () => true, warn: (_, detail) => void warnings.push(detail) })!
  assert.equal((await computer.run("on", "bash", {})).output, "direct")
  assert.equal((await computer.run("on", "bash", {})).output, "direct")
  assert.deepEqual(warnings, [{ sessionId: "on" }])
})

test("a failing gateway fails the conversation's computer instead of falling back", async () => {
  const calls: string[] = []
  const computer = routeComputers({ direct: fake("direct", calls), gateway: fake("gateway", calls, new Error("gateway down")), viaGateway: () => true })!
  await assert.rejects(computer.run("on", "bash", {}), /gateway down/)
  await assert.rejects(computer.delete("on"), /gateway down/)
  assert.deepEqual(calls, ["gateway:run:on:bash", "gateway:delete:on", "direct:delete:on"])
})

test("with only a gateway, conversations without the setting have no computer", async () => {
  const calls: string[] = []
  const computer = routeComputers({ gateway: fake("gateway", calls), viaGateway: (id) => id === "on" })!
  assert.equal(computer.available?.("on"), true)
  assert.equal(computer.available?.("off"), false)
  await assert.rejects(computer.run("off", "bash", {}), /no computer/)
  assert.equal(routeComputers({ viaGateway: () => true }), undefined)
})
