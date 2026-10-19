import assert from "node:assert/strict"
import { test } from "node:test"
import { FreestyleApiError } from "freestyle"
import { withBlocks } from "@openwork/sandbox"
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
test("routes issues a VM-scoped SSH identity and deletes it on release", async () => {
  const calls: string[] = []
  const grantee = {
    permissions: { vm: { grant: async (options: { vmId: string; allowedLinuxUsers?: string[] | null }) => { calls.push(`grant ${options.vmId} ${JSON.stringify(options.allowedLinuxUsers)}`) } } },
    tokens: { create: async () => ({ id: "t", token: "fs-token" }) },
    delete: async () => { calls.push("delete") },
  }
  const client = { vms: {}, identities: { create: async () => ({ identity: grantee }) } }
  // @ts-expect-error: a minimal stand-in for the SDK slices routes uses.
  const provider = createFreestyleProvider({ snapshot: "s", firewall: { rules: [] }, linuxUser: "root" }, { client })
  const handle = { ref: { providerId: "freestyle", ref: { vmId: "vm123" } }, state: "running" as const, region: null, observedAt: 0 }
  const routes = await withBlocks(provider, ["routes"]).routes(handle, 8081, { timeoutMs: 1000 })
  assert.equal(routes.length, 1)
  const ssh = routes[0]
  assert.ok(ssh?.kind === "ssh")
  assert.deepEqual({ label: ssh.label, host: ssh.host, user: ssh.user, target: ssh.target }, { label: "freestyle-ssh", host: "beta-ssh.freestyle.sh", user: "vm123+root:fs-token", target: { port: 8081 } })
  await ssh.release?.()
  assert.deepEqual(calls, ['grant vm123 ["root"]', "delete"])
})
