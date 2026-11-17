/**
 * The runner's list of its computers (`GET /v1/computers`): what it asks the sandbox gateway and the direct provider,
 * what it keeps of their answers, and what a failing source looks like. Record shapes are the providers' own.
 */
import assert from "node:assert/strict"
import { test } from "node:test"
import { COMPUTER_EVENT_LIMIT, COMPUTER_FLEET_LIMIT, computerDetailResponse, computerFleetResponse, readComputer, readComputerFleet, type ComputerFleetConfig } from "../src/computer-fleet.js"

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
    image: "workbot-computer", imageCurrent: true, idleTimeoutSeconds: null, idledAt: null, resumeRequestedAt: null, slotReleased: true, trust: "private",
  })
  assert.equal(fleet.sandboxes[1]?.statusReason, "backend rejected the sandbox")
  assert.deepEqual(fleet.sandboxes[2], {
    id: "vm_1", key: "hc-vm_1", source: "direct", provider: "freestyle", status: "running", statusReason: null, pool: null, backend: null, region: null,
    cpu: 2, memoryMb: 4096, diskGb: 8, createdAt: "2026-11-17T20:00:00.000Z", updatedAt: "2026-11-17T21:00:00.000Z", startedAt: null, pausedAt: null, lastActivityAt: "2026-11-17T21:59:00.000Z", expiresAt: null, endedAt: null, attempts: null,
    image: null, imageCurrent: null, idleTimeoutSeconds: null, idledAt: null, resumeRequestedAt: null, slotReleased: null, trust: null,
  })
  // How the runner treats each source's computers rides along, so a reader can tell an older image and a late pause.
  assert.deepEqual(fleet.sources.map((source) => source.settings), [
    { image: "workbot-computer", idlePauseSeconds: 60, keepDays: 14, persistent: false },
    { image: "snap", idlePauseSeconds: 60, keepDays: 14, persistent: false },
  ])
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
  assert.deepEqual(daytona.sources, [{ source: "direct", provider: "daytona", status: "unsupported", error: null, truncated: false, pools: [], settings: { image: "snap", idlePauseSeconds: 60, keepDays: 14, persistent: false } }])
})

test("one gateway computer in full: its record, why it was placed there, and its lifecycle without what the conversation did", async () => {
  const record = gatewaySandbox("sbx_1", {
    status: "running", pausedAt: null, slotReleased: false, idleTimeoutSeconds: 1_209_600, profile: "desktop", classification: "internal", capabilities: ["exec", "pause"], preemptible: false, maxPausedSeconds: 0,
    decision: {
      pool: "opensandbox-microvm", strategy: "private-first", outcome: "placed", reason: "first eligible private pool with capacity", evaluatedAt: "2026-10-29T22:36:42.000Z", policies: ["global"],
      candidates: [{ pool: "opensandbox-microvm", trust: "private", eligible: true, hasCapacity: true, rank: 1, reasons: ["private pool"], estimatedCostPerHour: 0.02 }, { pool: "freestyle", trust: "external", eligible: false, hasCapacity: true, reasons: ["policy keeps this classification on private pools"] }],
    },
  })
  const event = (seq: number, action: string, details: Record<string, string> = {}) => ({ seq, time: `2026-11-17T21:${String(seq).padStart(2, "0")}:00.000Z`, actor: "key_runner", orgId: "org_1", action, resource: "sbx_1", outcome: "success", details, hash: "abc" })
  const web = fakeFetch((url) => {
    if (url.pathname === "/v1/sandboxes/sbx_1") return record
    if (url.pathname === "/v1/audit-events" && !url.searchParams.get("beforeSeq")) {
      return { items: [event(40, "sandbox.exec", { command: "cat /workspace/secret.txt" }), event(39, "sandbox.woke", { after: "exec", pool: "opensandbox-microvm" }), event(38, "sandbox.file_read", { path: "/workspace/files/plan.docx" }), event(37, "sandbox.idled", { pool: "opensandbox-microvm", action: "pause", token: "leak" }), event(36, "sandbox.port_expose", { port: "6080" }), event(35, "organization.update")], nextCursor: "35" }
    }
    if (url.pathname === "/v1/audit-events") return { items: [event(2, "sandbox.running", { pool: "opensandbox-microvm", backendRef: "pod-9" }), event(1, "sandbox.create")] }
    return new Response("{}", { status: 404 })
  })
  const result = await readComputer({ computerGateway: gateway, computer: freestyle }, { fetch: web.fetch, now }, "gateway", "sbx_1")
  assert.equal(result.ok, true)
  if (!result.ok) return
  const detail = result.detail
  assert.deepEqual([detail.computer.id, detail.computer.status, detail.computer.image, detail.computer.imageCurrent, detail.computer.idleTimeoutSeconds, detail.computer.trust], ["sbx_1", "running", "workbot-computer", true, 1_209_600, "private"])
  assert.deepEqual(detail.limits, { profile: "desktop", classification: "internal", capabilities: ["exec", "pause"], preemptible: false, ttlSeconds: 1_209_600, maxRunSeconds: null, maxPausedSeconds: null, autoDeleteSeconds: null, totalRunSeconds: null })
  assert.deepEqual(detail.settings, { image: "workbot-computer", idlePauseSeconds: 60, keepDays: 14, persistent: false })
  assert.deepEqual([detail.placement?.pool, detail.placement?.outcome, detail.placement?.reason, detail.placement?.policies], ["opensandbox-microvm", "placed", "first eligible private pool with capacity", ["global"]])
  assert.deepEqual(detail.placement?.candidates, [
    { pool: "opensandbox-microvm", trust: "private", eligible: true, hasCapacity: true, rank: 1, reasons: ["private pool"] },
    { pool: "freestyle", trust: "external", eligible: false, hasCapacity: true, rank: null, reasons: ["policy keeps this classification on private pools"] },
  ])
  // Newest first, across pages. Commands, files and ports say what the conversation did: they and their details stay out.
  assert.deepEqual(detail.events, [
    { at: "2026-11-17T21:39:00.000Z", action: "woke", outcome: "success", details: { pool: "opensandbox-microvm", after: "exec" } },
    { at: "2026-11-17T21:37:00.000Z", action: "idled", outcome: "success", details: { pool: "opensandbox-microvm", action: "pause" } },
    { at: "2026-11-17T21:02:00.000Z", action: "running", outcome: "success", details: { pool: "opensandbox-microvm" } },
    { at: "2026-11-17T21:01:00.000Z", action: "create", outcome: "success", details: {} },
  ])
  assert.equal(detail.eventsError, null)
  assert.equal(JSON.stringify(detail).includes("secret.txt") || JSON.stringify(detail).includes("plan.docx") || JSON.stringify(detail).includes("leak") || JSON.stringify(detail).includes("key_runner"), false)
  const audit = web.calls.filter((call) => call.url.pathname === "/v1/audit-events")
  assert.deepEqual(audit.map((call) => [call.url.searchParams.get("resource"), call.url.searchParams.get("order"), call.url.searchParams.get("beforeSeq")]), [["sbx_1", "desc", null], ["sbx_1", "desc", "35"]])
  assert.equal(web.calls.every((call) => call.authorization === "Bearer gateway-key"), true)
})

test("a key that may not read the gateway's events still gets the computer, and a long history is cut", async () => {
  const refused = fakeFetch((url) => (url.pathname === "/v1/audit-events" ? new Response("{}", { status: 403 }) : gatewaySandbox("sbx_1")))
  const result = await readComputer({ computerGateway: gateway }, { fetch: refused.fetch, now }, "gateway", "sbx_1")
  assert.deepEqual(result.ok && [result.detail.computer.id, result.detail.events, result.detail.eventsError, result.detail.placement], ["sbx_1", null, "http_403", null])

  const busy = fakeFetch((url) => (url.pathname === "/v1/audit-events" ? { items: Array.from({ length: 200 }, (_, index) => ({ time: "2026-11-17T21:00:00.000Z", action: index % 2 ? "sandbox.idled" : "sandbox.woke", outcome: "success" })), nextCursor: "1" } : gatewaySandbox("sbx_1")))
  const long = await readComputer({ computerGateway: gateway }, { fetch: busy.fetch, now }, "gateway", "sbx_1")
  assert.equal(long.ok && long.detail.events?.length, COMPUTER_EVENT_LIMIT)
  assert.equal(busy.calls.filter((call) => call.url.pathname === "/v1/audit-events").length, 1, "stops reading once it has enough")
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
  const current = await readComputer({ computer: { ...freestyle, snapshot: "snp_8f2" } }, { fetch: web.fetch, now }, "direct", "vm_1")
  assert.equal(current.ok && current.detail.computer.imageCurrent, true)
  assert.deepEqual(result.detail.limits, { profile: null, classification: null, capabilities: [], preemptible: null, ttlSeconds: null, maxRunSeconds: null, maxPausedSeconds: null, autoDeleteSeconds: 1_209_600, totalRunSeconds: 5400 })
  assert.deepEqual([result.detail.placement, result.detail.events, result.detail.eventsError], [null, null, "unsupported"])
  assert.equal(JSON.stringify(result.detail).includes("2001:db8"), false, "addresses are not returned")
  assert.deepEqual([...new Set(web.calls.map((call) => [call.url.host, call.url.pathname, call.authorization].join(" ")))], ["api.freestyle.sh /v5/vms/vm_1 Bearer freestyle-key"], "one read of the provider per look, nothing else")
})

test("a computer that is not this runner's, is unknown or cannot be read is refused, never guessed", async () => {
  const read = (config: ComputerFleetConfig, answer: (url: URL) => unknown | Response, source: string, id: string) => readComputer(config, { fetch: fakeFetch(answer).fetch, now }, source, id)
  const config = { computerGateway: gateway, computer: freestyle }
  // Another runner's computer, and a machine that is not a conversation's computer at all.
  assert.deepEqual(await read(config, () => gatewaySandbox("sbx_9", { labels: { kind: "headless-computer", "openwork.sandbox.scope": "another-runner" } }), "gateway", "sbx_9"), { ok: false, status: 404, error: "unknown_computer" })
  assert.deepEqual(await read(config, () => vm("vm_9", { metadata: { kind: "snapshot-builder" } }), "direct", "vm_9"), { ok: false, status: 404, error: "unknown_computer" })
  assert.deepEqual(await read(config, () => new Response("{}", { status: 404 }), "gateway", "sbx_gone"), { ok: false, status: 404, error: "unknown_computer" })
  assert.deepEqual(await read(config, () => new Response("{}", { status: 503 }), "direct", "vm_1"), { ok: false, status: 502, error: "provider_unreachable", code: "http_503" })
  // A source this runner does not have, and ids that are not ids: no request is made.
  const never = async () => { throw new Error("must not call") }
  assert.deepEqual(await readComputer({ computer: freestyle }, { fetch: never, now }, "gateway", "sbx_1"), { ok: false, status: 404, error: "unknown_computer" })
  for (const [source, id] of [["gateway", "../admin/pools"], ["gateway", "sbx 1"], ["gateway", ""], ["elsewhere", "sbx_1"]] as const) {
    assert.deepEqual(await readComputer(config, { fetch: never, now }, source, id), { ok: false, status: 400, error: "invalid_computer" })
  }
  const response = await computerDetailResponse(config, { fetch: fakeFetch(() => new Response("{}", { status: 500 })).fetch, now }, "gateway", "sbx_1")
  assert.deepEqual([response.status, response.headers.get("cache-control"), await response.json()], [502, "no-store", { error: "provider_unreachable", code: "http_500" }])
  assert.equal((await computerDetailResponse(undefined, { fetch: never, now }, "gateway", "sbx_1")).status, 404)
})
