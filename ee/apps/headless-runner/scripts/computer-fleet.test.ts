/**
 * The runner's list of its computers (`GET /v1/computers`): what it asks the sandbox gateway and the direct provider,
 * what it keeps of their answers, and what a failing source looks like. Record shapes are the providers' own.
 */
import assert from "node:assert/strict"
import { test } from "node:test"
import { COMPUTER_FLEET_LIMIT, computerFleetResponse, readComputerFleet, type ComputerFleetConfig } from "../src/computer-fleet.js"

const settings = { scope: "workbot-prod", idlePauseMs: 60_000, keepDays: 14, desktop: true }
const gateway = { kind: "differently" as const, url: "https://gateway.test/", apiKey: "gateway-key", template: "workbot-computer", ...settings }
const freestyle = { kind: "freestyle" as const, apiKey: "freestyle-key", snapshot: "snap", ...settings }
const now = () => new Date("2026-11-17T22:00:00.000Z")

/** A sandbox as Differently returns it (`GET /v1/sandboxes`). */
const gatewaySandbox = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  orgId: "org_1",
  projectId: "prj_1",
  status: "paused",
  statusReason: "",
  template: "workbot-computer",
  pool: "opensandbox-microvm",
  adapter: "opensandbox",
  trust: "private",
  region: "eastus",
  resources: { cpu: 2, memoryMiB: 4096, diskGiB: 8 },
  labels: { kind: "headless-computer", "openwork.sandbox.key": `hc-${id}`, "openwork.sandbox.scope": "workbot-prod", "openwork.sandbox.idle-minutes": "20160" },
  ttlSeconds: 1_209_600,
  expiresAt: "2026-11-23T18:13:26.654Z",
  pausedAt: "2026-11-09T18:48:16.987Z",
  slotReleased: true,
  lastActivityAt: "2026-11-09T18:13:26.314Z",
  attempts: 1,
  createdAt: "2026-10-29T22:36:41.964Z",
  updatedAt: "2026-11-09T18:48:16.987Z",
  startedAt: "2026-10-29T22:36:43.684Z",
  endedAt: null,
  ...extra,
})
/** A machine as Freestyle returns it (`GET /v5/vms`). */
const vm = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  state: "running",
  slug: `hc-${id}`,
  resources: { cpu: 2, memory: 4096, storage: 8192 },
  metadata: { kind: "headless-computer", "openwork.sandbox.scope": "workbot-prod" },
  createdAt: "2026-11-17T20:00:00.000Z",
  updatedAt: "2026-11-17T21:00:00.000Z",
  lastNetworkActivity: "2026-11-17T21:59:00.000Z",
  ...extra,
})

type Call = { url: URL; authorization: string | null }
function fakeFetch(answer: (url: URL) => unknown | Response) {
  const calls: Call[] = []
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url)
    calls.push({ url, authorization: new Headers(init?.headers).get("authorization") })
    const body = answer(url)
    return body instanceof Response ? body : Response.json(body)
  }
  return { fetch, calls }
}

test("lists the gateway's and the direct provider's computers, each with what its provider knows", async () => {
  const web = fakeFetch((url) => {
    if (url.host === "gateway.test" && url.pathname === "/v1/capabilities") return { items: [{ pool: "opensandbox-microvm", adapter: "opensandbox", trust: "private", region: "eastus", enabled: true, health: "healthy", capabilities: ["exec"] }, { pool: "freestyle", adapter: "freestyle", trust: "external", enabled: true, health: "degraded", capabilities: [] }] }
    if (url.host === "gateway.test") return { items: [gatewaySandbox("sbx_1"), gatewaySandbox("sbx_2", { status: "failed", statusReason: "backend rejected the sandbox", pausedAt: null, startedAt: null, endedAt: "2026-11-17T21:31:51.986Z" })] }
    return { vms: [vm("vm_1"), vm("vm_2", { state: "paused" })], totalCount: 2, runningCount: 1 }
  })
  const fleet = await readComputerFleet({ computerGateway: gateway, computer: freestyle }, { fetch: web.fetch, now })
  assert.equal(fleet.generatedAt, "2026-11-17T22:00:00.000Z")
  assert.deepEqual(fleet.sources.map((source) => [source.source, source.provider, source.status, source.error, source.truncated]), [["gateway", "differently", "ok", null, false], ["direct", "freestyle", "ok", null, false]])
  assert.deepEqual(fleet.sources[0]?.pools, [{ name: "opensandbox-microvm", backend: "opensandbox", region: "eastus", enabled: true, health: "healthy" }, { name: "freestyle", backend: "freestyle", region: null, enabled: true, health: "degraded" }])
  assert.deepEqual(fleet.sandboxes.map((sandbox) => [sandbox.source, sandbox.id, sandbox.status]), [["gateway", "sbx_1", "paused"], ["gateway", "sbx_2", "failed"], ["direct", "vm_1", "running"], ["direct", "vm_2", "paused"]])
  assert.deepEqual(fleet.sandboxes[0], {
    id: "sbx_1", key: "hc-sbx_1", source: "gateway", provider: "differently", status: "paused", statusReason: null, pool: "opensandbox-microvm", backend: "opensandbox", region: "eastus",
    cpu: 2, memoryMb: 4096, diskGb: 8, createdAt: "2026-10-29T22:36:41.964Z", updatedAt: "2026-11-09T18:48:16.987Z", startedAt: "2026-10-29T22:36:43.684Z", pausedAt: "2026-11-09T18:48:16.987Z", lastActivityAt: "2026-11-09T18:13:26.314Z",
    expiresAt: "2026-11-23T18:13:26.654Z", endedAt: null, attempts: 1,
  })
  assert.equal(fleet.sandboxes[1]?.statusReason, "backend rejected the sandbox")
  assert.deepEqual(fleet.sandboxes[2], {
    id: "vm_1", key: "hc-vm_1", source: "direct", provider: "freestyle", status: "running", statusReason: null, pool: null, backend: null, region: null,
    cpu: 2, memoryMb: 4096, diskGb: 8, createdAt: "2026-11-17T20:00:00.000Z", updatedAt: "2026-11-17T21:00:00.000Z", startedAt: null, pausedAt: null, lastActivityAt: "2026-11-17T21:59:00.000Z", expiresAt: null, endedAt: null, attempts: null,
  })
  // Each provider is asked only for this runner's computers, with its own key, and nothing is written.
  const sandboxes = web.calls.find((call) => call.url.pathname === "/v1/sandboxes")
  assert.deepEqual(sandboxes?.url.searchParams.getAll("label"), ["kind=headless-computer", "openwork.sandbox.scope=workbot-prod"])
  assert.equal(sandboxes?.authorization, "Bearer gateway-key")
  const vms = web.calls.find((call) => call.url.host === "api.freestyle.sh")
  assert.equal(vms?.url.pathname, "/v5/vms")
  assert.equal(vms?.url.searchParams.get("metadata"), "kind:headless-computer,openwork.sandbox.scope:workbot-prod")
  assert.equal(vms?.authorization, "Bearer freestyle-key")
})

test("follows the gateway's pages and the provider's, and never returns another account's machine", async () => {
  const web = fakeFetch((url) => {
    if (url.pathname === "/v1/capabilities") return { items: [] }
    if (url.host === "gateway.test") return url.searchParams.get("cursor") === "next" ? { items: [gatewaySandbox("sbx_2")] } : { items: [gatewaySandbox("sbx_1"), { nonsense: true }], nextCursor: "next" }
    const offset = Number(url.searchParams.get("offset"))
    // A provider that ignored the filter: a snapshot builder and another runner's computer come back too.
    const page = offset === 0 ? [...Array.from({ length: 98 }, (_, index) => vm(`vm_${index}`)), vm("builder", { metadata: {} }), vm("other", { metadata: { kind: "headless-computer", "openwork.sandbox.scope": "staging" } })] : [vm("vm_last")]
    return { vms: page, totalCount: 101 }
  })
  const fleet = await readComputerFleet({ computerGateway: gateway, computer: freestyle }, { fetch: web.fetch, now })
  assert.deepEqual(fleet.sandboxes.filter((sandbox) => sandbox.source === "gateway").map((sandbox) => sandbox.id), ["sbx_1", "sbx_2"], "an unreadable record is skipped, the rest kept")
  const direct = fleet.sandboxes.filter((sandbox) => sandbox.source === "direct").map((sandbox) => sandbox.id)
  assert.equal(direct.length, 99)
  assert.equal(direct.includes("builder") || direct.includes("other"), false)
  assert.equal(direct.at(-1), "vm_last")
})

test("a source that fails is named with a code and the other is still returned", async () => {
  const web = fakeFetch((url) => {
    if (url.host === "gateway.test") return new Response("upstream said gateway-key is wrong", { status: 503 })
    return { vms: [vm("vm_1")], totalCount: 1 }
  })
  const fleet = await readComputerFleet({ computerGateway: gateway, computer: freestyle }, { fetch: web.fetch, now })
  assert.deepEqual(fleet.sources.map((source) => [source.source, source.status, source.error]), [["gateway", "unreachable", "http_503"], ["direct", "ok", null]])
  assert.deepEqual(fleet.sandboxes.map((sandbox) => sandbox.id), ["vm_1"])
  assert.equal(JSON.stringify(fleet).includes("gateway-key"), false, "no key and no provider message leaves the runner")

  const dropped = await readComputerFleet({ computer: freestyle }, { fetch: async () => { throw new TypeError("fetch failed") }, now })
  assert.deepEqual(dropped.sources.map((source) => [source.status, source.error]), [["unreachable", "unreachable"]])
  const garbled = await readComputerFleet({ computerGateway: gateway }, { fetch: fakeFetch(() => ({ items: "no" })).fetch, now })
  assert.deepEqual(garbled.sources.map((source) => [source.status, source.error]), [["unreachable", "invalid_response"]])
})

test("a fleet past the limit is cut and says so", async () => {
  const web = fakeFetch((url) => {
    if (url.pathname === "/v1/capabilities") return { items: [] }
    const page = Number(url.searchParams.get("cursor") ?? "0")
    return { items: Array.from({ length: 500 }, (_, index) => gatewaySandbox(`sbx_${page}_${index}`)), nextCursor: String(page + 1) }
  })
  const fleet = await readComputerFleet({ computerGateway: gateway }, { fetch: web.fetch, now })
  assert.equal(fleet.sandboxes.length, COMPUTER_FLEET_LIMIT)
  assert.equal(fleet.sources[0]?.truncated, true)
  assert.ok(web.calls.length <= 6, "it stops asking once it has enough")
})

test("no computers configured is an empty fleet, and Daytona is named but not read", async () => {
  const none = await computerFleetResponse(undefined, { fetch: async () => { throw new Error("must not call") }, now })
  assert.equal(none.headers.get("cache-control"), "no-store")
  assert.deepEqual(await none.json(), { version: 1, generatedAt: "2026-11-17T22:00:00.000Z", sources: [], sandboxes: [] })
  const config: ComputerFleetConfig = { computer: { kind: "daytona", apiKey: "daytona-key", snapshot: "snap", ...settings } }
  const daytona = await readComputerFleet(config, { fetch: async () => { throw new Error("must not call") }, now })
  assert.deepEqual(daytona.sources, [{ source: "direct", provider: "daytona", status: "unsupported", error: null, truncated: false, pools: [] }])
})
