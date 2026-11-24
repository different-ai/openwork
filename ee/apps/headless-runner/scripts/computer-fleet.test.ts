/**
 * The runner's list of its computers (`GET /v1/computers`): what it asks its own provider, what it keeps of the
 * answer, and what a failing source looks like. Record shapes are the provider's own.
 */
import assert from "node:assert/strict"
import { test } from "node:test"
import { COMPUTER_FLEET_LIMIT, computerDetailResponse, computerFleetResponse, readComputer, readComputerFleet, type ComputerFleetConfig } from "../src/computer-fleet.js"

const settings = { scope: "workbot-prod", idlePauseMs: 60_000, keepDays: 14, desktop: true }
const freestyle = { kind: "freestyle" as const, apiKey: "freestyle-key", snapshot: "snap", ...settings }
const now = () => new Date("2026-11-17T22:00:00.000Z")

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

test("lists the provider's computers with what it knows", async () => {
  const web = fakeFetch(() => ({ vms: [vm("vm_1"), vm("vm_2", { state: "paused" })], totalCount: 2, runningCount: 1 }))
  const fleet = await readComputerFleet({ computer: freestyle }, { fetch: web.fetch, now })
  assert.equal(fleet.generatedAt, "2026-11-17T22:00:00.000Z")
  assert.deepEqual(fleet.sources.map((source) => [source.source, source.provider, source.status, source.error, source.truncated]), [["direct", "freestyle", "ok", null, false]])
  assert.deepEqual(fleet.sandboxes.map((sandbox) => [sandbox.source, sandbox.id, sandbox.status]), [["direct", "vm_1", "running"], ["direct", "vm_2", "paused"]])
  assert.deepEqual(fleet.sandboxes[0], {
    id: "vm_1", key: "hc-vm_1", source: "direct", provider: "freestyle", status: "running", statusReason: null, pool: null, backend: null, region: null,
    cpu: 2, memoryMb: 4096, diskGb: 8, createdAt: "2026-11-17T20:00:00.000Z", updatedAt: "2026-11-17T21:00:00.000Z", startedAt: null, pausedAt: null, lastActivityAt: "2026-11-17T21:59:00.000Z", expiresAt: null, endedAt: null, attempts: null,
    image: null, imageCurrent: null, idleTimeoutSeconds: null, idledAt: null, resumeRequestedAt: null, slotReleased: null, trust: null, runSeconds: null,
  })
  // How the runner treats its computers rides along, so a reader can tell an older image and a late pause.
  assert.deepEqual(fleet.sources.map((source) => source.settings), [{ image: "snap", idlePauseSeconds: 60, keepDays: 14, persistent: false }])
  // The provider is asked only for this runner's computers, with its own key, and nothing is written.
  const vms = web.calls.find((call) => call.url.host === "api.freestyle.sh")
  assert.equal(vms?.url.pathname, "/v5/vms")
  assert.equal(vms?.url.searchParams.get("metadata"), "kind:headless-computer,openwork.sandbox.scope:workbot-prod")
  assert.equal(vms?.authorization, "Bearer freestyle-key")
})

test("follows the provider's pages, and never returns another account's machine", async () => {
  const web = fakeFetch((url) => {
    const offset = Number(url.searchParams.get("offset"))
    // A provider that ignored the filter: a snapshot builder and another runner's computer come back too.
    const page = offset === 0 ? [...Array.from({ length: 97 }, (_, index) => vm(`vm_${index}`)), { nonsense: true }, vm("builder", { metadata: {} }), vm("other", { metadata: { kind: "headless-computer", "openwork.sandbox.scope": "staging" } })] : [vm("vm_last")]
    return { vms: page, totalCount: 101 }
  })
  const fleet = await readComputerFleet({ computer: freestyle }, { fetch: web.fetch, now })
  const direct = fleet.sandboxes.map((sandbox) => sandbox.id)
  assert.equal(direct.length, 98, "an unreadable record is skipped, the rest kept")
  assert.equal(direct.includes("builder") || direct.includes("other"), false)
  assert.equal(direct.at(-1), "vm_last")
})

test("a source that fails is named with a code", async () => {
  const refused = await readComputerFleet({ computer: freestyle }, { fetch: fakeFetch(() => new Response("upstream said freestyle-key is wrong", { status: 503 })).fetch, now })
  assert.deepEqual(refused.sources.map((source) => [source.source, source.status, source.error]), [["direct", "unreachable", "http_503"]])
  assert.deepEqual(refused.sandboxes, [])
  assert.equal(JSON.stringify(refused).includes("freestyle-key"), false, "no key and no provider message leaves the runner")

  const dropped = await readComputerFleet({ computer: freestyle }, { fetch: async () => { throw new TypeError("fetch failed") }, now })
  assert.deepEqual(dropped.sources.map((source) => [source.status, source.error]), [["unreachable", "unreachable"]])
  const garbled = await readComputerFleet({ computer: freestyle }, { fetch: fakeFetch(() => ({ vms: "no" })).fetch, now })
  assert.deepEqual(garbled.sources.map((source) => [source.status, source.error]), [["unreachable", "invalid_response"]])
})

test("a fleet past the limit is cut and says so", async () => {
  const web = fakeFetch((url) => {
    const offset = Number(url.searchParams.get("offset"))
    return { vms: Array.from({ length: 100 }, (_, index) => vm(`vm_${offset}_${index}`)), totalCount: 10_000 }
  })
  const fleet = await readComputerFleet({ computer: freestyle }, { fetch: web.fetch, now })
  assert.equal(fleet.sandboxes.length, COMPUTER_FLEET_LIMIT)
  assert.equal(fleet.sources[0]?.truncated, true)
  assert.ok(web.calls.length <= 21, "it stops asking once it has enough")
})

test("no computers configured is an empty fleet, and Daytona is named but not read", async () => {
  const none = await computerFleetResponse(undefined, { fetch: async () => { throw new Error("must not call") }, now })
  assert.equal(none.headers.get("cache-control"), "no-store")
  assert.deepEqual(await none.json(), { version: 1, generatedAt: "2026-11-17T22:00:00.000Z", sources: [], sandboxes: [] })
  const config: ComputerFleetConfig = { computer: { kind: "daytona", apiKey: "daytona-key", snapshot: "snap", ...settings } }
  const daytona = await readComputerFleet(config, { fetch: async () => { throw new Error("must not call") }, now })
  assert.deepEqual(daytona.sources, [{ source: "direct", provider: "daytona", status: "unsupported", error: null, truncated: false, pools: [], settings: { image: "snap", idlePauseSeconds: 60, keepDays: 14, persistent: false } }])
})

test("one direct computer in full, with the snapshot it was built from", async () => {
  const web = fakeFetch((url) => (url.pathname === "/v5/vms/vm_1"
    ? vm("vm_1", { snapshotId: "snp_8f2", sourceSnapshotSlug: "workbot-desktop-freestyle-aaaa-bbbb", idleTimeoutSeconds: 3600, autoDeleteSeconds: 1_209_600, totalRunSeconds: 5400, maxRunSeconds: null, publicIpv6: "2001:db8::1" })
    : new Response("{}", { status: 404 })))
  const result = await readComputer({ computer: freestyle }, { fetch: web.fetch, now }, "direct", "vm_1")
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.deepEqual([result.detail.computer.source, result.detail.computer.image, result.detail.computer.idleTimeoutSeconds, result.detail.computer.lastActivityAt], ["direct", "workbot-desktop-freestyle-aaaa-bbbb", 3600, "2026-11-17T21:59:00.000Z"])
  // Built from another snapshot than the runner's `snap`: an older image. The runner's setting may name the snapshot by id or by name.
  assert.equal(result.detail.computer.imageCurrent, false)
  assert.equal(result.detail.computer.runSeconds, 5400)
  const current = await readComputer({ computer: { ...freestyle, snapshot: "snp_8f2" } }, { fetch: web.fetch, now }, "direct", "vm_1")
  assert.equal(current.ok && current.detail.computer.imageCurrent, true)
  assert.deepEqual(result.detail.limits, { profile: null, classification: null, capabilities: [], preemptible: null, ttlSeconds: null, maxRunSeconds: null, maxPausedSeconds: null, autoDeleteSeconds: 1_209_600, totalRunSeconds: 5400 })
  assert.deepEqual([result.detail.placement, result.detail.events, result.detail.eventsError], [null, null, "unsupported"])
  assert.equal(JSON.stringify(result.detail).includes("2001:db8"), false, "addresses are not returned")
  assert.deepEqual([...new Set(web.calls.map((call) => [call.url.host, call.url.pathname, call.authorization].join(" ")))], ["api.freestyle.sh /v5/vms/vm_1 Bearer freestyle-key"], "one read of the provider per look, nothing else")
})

test("a computer that is not this runner's, is unknown or cannot be read is refused, never guessed", async () => {
  const read = (config: ComputerFleetConfig, answer: (url: URL) => unknown | Response, source: string, id: string) => readComputer(config, { fetch: fakeFetch(answer).fetch, now }, source, id)
  const config = { computer: freestyle }
  // Another runner's computer, and a machine that is not a conversation's computer at all.
  assert.deepEqual(await read(config, () => vm("vm_9", { metadata: { kind: "headless-computer", "openwork.sandbox.scope": "another-runner" } }), "direct", "vm_9"), { ok: false, status: 404, error: "unknown_computer" })
  assert.deepEqual(await read(config, () => vm("vm_9", { metadata: { kind: "snapshot-builder" } }), "direct", "vm_9"), { ok: false, status: 404, error: "unknown_computer" })
  assert.deepEqual(await read(config, () => new Response("{}", { status: 404 }), "direct", "vm_gone"), { ok: false, status: 404, error: "unknown_computer" })
  assert.deepEqual(await read(config, () => new Response("{}", { status: 503 }), "direct", "vm_1"), { ok: false, status: 502, error: "provider_unreachable", code: "http_503" })
  // A source this runner does not have, and ids that are not ids: no request is made.
  const never = async () => { throw new Error("must not call") }
  assert.deepEqual(await readComputer(config, { fetch: never, now }, "gateway", "sbx_1"), { ok: false, status: 404, error: "unknown_computer" })
  for (const [source, id] of [["direct", "../admin/pools"], ["direct", "vm 1"], ["direct", ""], ["elsewhere", "vm_1"]] as const) {
    assert.deepEqual(await readComputer(config, { fetch: never, now }, source, id), { ok: false, status: 400, error: "invalid_computer" })
  }
  const response = await computerDetailResponse(config, { fetch: fakeFetch(() => new Response("{}", { status: 500 })).fetch, now }, "direct", "vm_1")
  assert.deepEqual([response.status, response.headers.get("cache-control"), await response.json()], [502, "no-store", { error: "provider_unreachable", code: "http_500" }])
  assert.equal((await computerDetailResponse(undefined, { fetch: never, now }, "direct", "vm_1")).status, 404)
})
