import assert from "node:assert/strict"
import { test } from "node:test"
import { FreestyleApiError } from "freestyle"
import { createFreestyleProvider, freestyleError } from "./index.js"
const p = createFreestyleProvider({ apiKey: "not-used", snapshot: "freestyle/ubuntu-sm", firewall: { rules: [] } })
test("unsupported create-time configuration fails before provisioning", async () => {
  const spec = { workerId: "", idempotencyKey: "test", image: null, env: { KEY: "value" }, labels: {}, storage: [], exposePorts: [] }
  await assert.rejects(p.create(spec, { timeoutMs: 1000 }), /create-time env/)
})
test("unsupported endpoint and volume bindings fail explicitly", async () => {
  // No handles are used in the endpoint callback, and no SDK request is made.
  await assert.rejects(p.storage.ensureVolume("test", { timeoutMs: 1000 }), /volumes/)
  assert.equal(p.describe().endpoints, false)
  assert.equal(p.describe().createEnvironment, false)
})
test("stable HTTP errors are normalized without parsing prose", () => {
  for (const [status, expected] of [[404, "not_found"], [409, "conflict"], [403, "auth"], [429, "rate_limited"], [503, "transient"]]) {
    const error = freestyleError(new FreestyleApiError(Number(status), { code: "ERROR", message: "arbitrary" }))
    assert.equal(error.code, expected)
    assert.equal(error.providerId, "freestyle")
  }
})

/** A Freestyle client that records creates and serves the VM it made. */
function fakeClient() {
  const created: Record<string, unknown>[] = []
  let metadata: Record<string, string> = {}
  const vms = {
    async create(options: Record<string, unknown>) {
      created.push(options)
      metadata = { ...(options.metadata as Record<string, string>) }
      return { data: { id: "vm-1", slug: "computer", state: "running", metadata } }
    },
    async get() { return { id: "vm-1", slug: "computer", state: "running", metadata } },
  }
  return { client: { vms } as unknown as NonNullable<Parameters<typeof createFreestyleProvider>[1]>["client"], created }
}
const desktopSpec = { idempotencyKey: "computer", image: null, env: {}, labels: { kind: "headless-computer" }, storage: [], exposePorts: [6080] }

test("exposed ports publish at an unguessable host under the endpoint domain", async () => {
  const { client, created } = fakeClient()
  const provider = createFreestyleProvider({ snapshot: "desktop", firewall: { rules: [] }, endpointDomain: "style.dev" }, { client })
  const box = await provider.create(desktopSpec, { timeoutMs: 1000 })
  const rule = (created[0].tls as { rules: { domain: string; destination: { port: number }; source: { public: boolean } }[] }).rules[0]
  assert.match(rule.domain, /^[0-9a-f]{24}-6080\.style\.dev$/)
  assert.deepEqual([rule.destination.port, rule.source.public], [6080, true])
  assert.equal(provider.describe().endpoints, true)
  const endpoint = await provider.endpoint(box, 6080)
  assert.deepEqual(endpoint, { url: `https://${rule.domain}`, expiresAt: null, kind: "stable" })
  await assert.rejects(provider.endpoint(box, 9222), /without a public endpoint for port 9222/)
})

test("exposed ports need an endpoint domain", async () => {
  const { client } = fakeClient()
  const provider = createFreestyleProvider({ snapshot: "desktop", firewall: { rules: [] } }, { client })
  await assert.rejects(provider.create(desktopSpec, { timeoutMs: 1000 }), /exposed ports without an endpoint domain/)
})

test("a VM's public host is read once and reused", async () => {
  let reads = 0
  const { client } = fakeClient()
  const counting = { vms: { ...client.vms, get: async (...args: Parameters<typeof client.vms.get>) => { reads++; return client.vms.get(...args) } } } as unknown as typeof client
  const provider = createFreestyleProvider({ snapshot: "desktop", firewall: { rules: [] }, endpointDomain: "style.dev" }, { client: counting })
  const box = await provider.create(desktopSpec, { timeoutMs: 1000 })
  const first = await provider.endpoint(box, 6080)
  assert.deepEqual(await provider.endpoint(box, 6080), first)
  assert.equal(reads, 1)
})
