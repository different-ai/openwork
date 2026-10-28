import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { test } from "node:test"
import { SandboxError, ensureRunning, withBlocks, type SandboxSpec } from "@openwork/sandbox"
import { sandboxBlockConformanceCases, sandboxProviderConformanceCases } from "@openwork/sandbox/testing"
import { createDifferentlyProvider, differentlyError, KEY_LABEL } from "./index.js"

type Box = { id: string; status: string; key: string; labels: Record<string, string>; files: Map<string, Uint8Array>; body: Record<string, unknown>; ttl?: number }

/**
 * An in-memory Differently: sandboxes settle one state per read, keys name live sandboxes only,
 * and exec runs the command in a local `sh` (chmod is recorded instead). `stopStart: false`
 * answers like an OpenSandbox pool, which can pause but not stop.
 */
function fakeDifferently(opts: { stopStart?: boolean } = {}) {
  const boxes = new Map<string, Box>()
  const snaps = new Map<string, Map<string, Uint8Array>>()
  const requests: Array<{ method: string; path: string; body?: unknown; headers: Record<string, string> }> = []
  let n = 0
  const reply = (status: number, body?: unknown) => new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } })
  const fail = (status: number, code: string) => reply(status, { error: { code, message: `fake: ${code}` } })
  const view = (b: Box) => ({ id: b.id, status: b.status, labels: b.labels, region: "dc1" })
  const advance = (b: Box) => { b.status = ({ queued: "provisioning", provisioning: "running", terminating: "terminated" } as Record<string, string>)[b.status] ?? b.status }
  const fetch: typeof globalThis.fetch = async (input, init = {}) => {
    const url = new URL(String(input))
    const method = init.method ?? "GET"
    const headers = Object.fromEntries(Object.entries((init.headers ?? {}) as Record<string, string>))
    const raw = init.body instanceof Uint8Array ? init.body : typeof init.body === "string" ? init.body : undefined
    const body = typeof raw === "string" ? JSON.parse(raw) : undefined
    requests.push({ method, path: url.pathname + url.search, body, headers })
    if (headers.Authorization !== "Bearer dly_test") return fail(401, "unauthenticated")
    const [, , kind, id, action] = url.pathname.split("/")
    if (kind === "snapshots" && method === "DELETE") { snaps.delete(id); return reply(204) }
    if (kind !== "sandboxes") return fail(404, "not_found")
    if (!id && method === "POST") {
      const key = headers["Idempotency-Key"] ?? ""
      const existing = [...boxes.values()].find(b => b.key === key && b.status !== "terminated" && b.status !== "failed")
      if (key && existing) return reply(200, view(existing))
      const files = body.fromSnapshot ? new Map(snaps.get(body.fromSnapshot)) : new Map<string, Uint8Array>()
      const box: Box = { id: `sbx_${++n}`, status: "queued", key, labels: body.labels ?? {}, files, body, ttl: body.ttlSeconds }
      boxes.set(box.id, box)
      return reply(202, view(box))
    }
    if (!id) {
      const statuses = (url.searchParams.get("status") ?? "").split(",")
      const labels = url.searchParams.getAll("label").map(l => l.split("="))
      const all = [...boxes.values()].reverse().filter(b => statuses.includes(b.status) && labels.every(([k, v]) => b.labels[k] === v))
      const start = Number(url.searchParams.get("cursor") ?? 0)
      const page = all.slice(start, start + 2) // small pages, so the adapter must follow the cursor
      return reply(200, { items: page.map(view), ...(start + 2 < all.length ? { nextCursor: String(start + 2) } : {}) })
    }
    const box = boxes.get(id)
    if (!box) return fail(404, "not_found")
    if (!action && method === "GET") { const out = view(box); advance(box); return reply(200, out) }
    if (!action && method === "PATCH") { box.ttl = body.ttlSeconds; return reply(200, view(box)) }
    if (!action && method === "DELETE") { if (box.status !== "terminated") box.status = "terminating"; return reply(202, view(box)) }
    if (box.status === "terminated" || box.status === "terminating") return fail(409, "invalid_state")
    const path = url.searchParams.get("path") ?? ""
    switch (`${method} ${action}`) {
      case "POST stop": if (opts.stopStart === false) return fail(501, "unsupported_operation"); box.status = "stopped"; return reply(200, view(box))
      case "POST start": box.status = "running"; return reply(200, view(box))
      case "POST pause": box.status = "paused"; return reply(200, view(box))
      case "POST resume": box.status = "running"; return reply(200, view(box))
      case "POST snapshots": { const sid = `snp_${++n}`; snaps.set(sid, new Map(box.files)); return reply(201, { id: sid, status: "ready" }) }
      case "POST ports": return reply(200, { port: body.port, url: `https://${box.id}-${body.port}.example.test` })
      case "POST exec": {
        if (String(body.command).startsWith("chmod ")) return reply(200, { exitCode: 0, stdout: "", stderr: "" })
        const ran = spawnSync("sh", ["-c", body.command], { cwd: body.cwd ?? "/", env: { PATH: process.env.PATH, ...body.env }, encoding: "utf8" })
        return reply(200, { exitCode: ran.status, stdout: ran.stdout, stderr: ran.stderr })
      }
      case "PUT files": { box.files.set(path, new Uint8Array(raw as Uint8Array)); return reply(204) }
    }
    if (url.pathname.endsWith("/files/content")) {
      const bytes = box.files.get(path)
      if (method === "PUT") { box.files.set(path, new Uint8Array(raw as Uint8Array)); return reply(204) }
      return bytes ? new Response(bytes.slice(), { status: 200 }) : fail(404, "not_found")
    }
    if (url.pathname.endsWith("/files")) {
      const dir = path.replace(/\/+$/, "")
      const items = [...box.files].filter(([p]) => p.slice(0, p.lastIndexOf("/")) === dir).map(([p, b]) => ({ name: p.slice(p.lastIndexOf("/") + 1), size: b.length, isDir: false }))
      return dir === "/tmp" || items.length ? reply(200, { items }) : fail(404, "not_found")
    }
    return fail(404, "not_found")
  }
  return { fetch, boxes, requests }
}

const quick = { fetch: undefined as unknown as typeof fetch, sleep: async () => {} }
function provider(opts: Parameters<typeof fakeDifferently>[0] = {}, options: Partial<Parameters<typeof createDifferentlyProvider>[0]> = {}) {
  const fake = fakeDifferently(opts)
  return { fake, p: createDifferentlyProvider({ url: "https://differently.test/", apiKey: "dly_test", template: "workbot-computer", ...options }, { ...quick, fetch: fake.fetch }) }
}

for (const c of sandboxProviderConformanceCases(() => provider().p, { timeoutMs: 5_000 })) test(`conformance: ${c.name}`, c.run)
for (const c of sandboxBlockConformanceCases(() => provider().p, ["run", "files", "pause", "snapshots"])) test(`conformance: ${c.name}`, c.run)
for (const c of sandboxProviderConformanceCases(() => provider({ stopStart: false }).p, { timeoutMs: 5_000 })) test(`conformance without stop/start: ${c.name}`, c.run)

const spec = (extra: Partial<SandboxSpec> = {}): SandboxSpec => ({ idempotencyKey: "computer-1", image: null, labels: { kind: "headless-computer" }, env: {}, storage: [], exposePorts: [], ...extra })

test("create sends one Differently request with the key, template, labels and an idle TTL", async () => {
  const { fake, p } = provider()
  await p.create(spec({ lifecycle: { autoStopMinutes: 60, autoDeleteMinutes: 14 * 1440 } }), { timeoutMs: 5_000 })
  const sent = fake.requests.find(r => r.method === "POST" && r.path === "/v1/sandboxes")!
  assert.equal(sent.headers["Idempotency-Key"], "computer-1")
  assert.deepEqual(sent.body, {
    template: "workbot-computer", ttlSeconds: 14 * 1440 * 60, env: {},
    labels: { kind: "headless-computer", [KEY_LABEL]: "computer-1", "openwork.sandbox.idle-minutes": String(14 * 1440) },
  })
})

test("a captured snapshot boots by ID, and persistent computers get a long TTL", async () => {
  const { fake, p } = provider()
  await p.create(spec({ image: { id: "snp_9", version: "copy" }, lifecycle: { autoDeleteMinutes: -1 } }), { timeoutMs: 5_000 })
  const body = fake.requests.find(r => r.method === "POST" && r.path === "/v1/sandboxes")!.body as Record<string, unknown>
  assert.equal(body.fromSnapshot, "snp_9")
  assert.equal(body.template, undefined)
  assert.equal(body.ttlSeconds, 365 * 1440 * 60)
})

test("unsupported create-time configuration fails before any request", async () => {
  const { fake, p } = provider()
  await assert.rejects(p.create(spec({ storage: [{ volume: { providerId: "differently", id: "v", name: "v" }, mountPath: "/data" }] }), { timeoutMs: 1_000 }), /storage/)
  await assert.rejects(p.create(spec({ lifecycle: { autoPauseMinutes: 5 } }), { timeoutMs: 1_000 }), /auto-pause/)
  assert.equal(fake.requests.length, 0)
})

test("resuming a paused computer restarts its idle clock", async () => {
  const { fake, p } = provider()
  const h = await p.create(spec({ lifecycle: { autoDeleteMinutes: 120 } }), { timeoutMs: 5_000 })
  await withBlocks(p, ["pause"]).pause(h, { timeoutMs: 5_000 })
  fake.boxes.get(h.ref.ref.sandboxId)!.ttl = 1
  const box = await ensureRunning(p, spec({ lifecycle: { autoDeleteMinutes: 120 } }), { timeoutMs: 5_000 })
  assert.deepEqual(box.ref, h.ref)
  assert.equal(fake.boxes.get(h.ref.ref.sandboxId)!.ttl, 120 * 60)
})

test("stop pauses on a pool that cannot stop, and a stopped sandbox starts again", async () => {
  const { fake, p } = provider({ stopStart: false })
  const h = await p.create(spec(), { timeoutMs: 5_000 })
  await p.stop(h, { timeoutMs: 5_000 })
  assert.equal(fake.boxes.get(h.ref.ref.sandboxId)!.status, "paused")
  assert.equal((await p.inspect(h)).state, "stopped")
  await p.start(h, { timeoutMs: 5_000 })
  assert.equal((await p.inspect(h)).state, "running")
})

test("a key names a live sandbox: after destroy the same key creates a new one", async () => {
  const { p } = provider()
  const first = await p.create(spec(), { timeoutMs: 5_000 })
  await p.destroy(first, { timeoutMs: 5_000 })
  const second = await p.create(spec(), { timeoutMs: 5_000 })
  assert.notDeepEqual(second.ref, first.ref)
})

test("file modes are applied with chmod, and endpoints are stable URLs", async () => {
  const { fake, p } = provider()
  const h = await p.create(spec({ exposePorts: [6080] }), { timeoutMs: 5_000 })
  await withBlocks(p, ["files"]).files.write(h, "/home/user/a b.txt", new TextEncoder().encode("x"), { timeoutMs: 5_000, mode: 0o660 })
  assert.ok(fake.requests.some(r => (r.body as { command?: string } | undefined)?.command === "chmod 660 '/home/user/a b.txt'"))
  assert.deepEqual(await p.endpoint(h, 6080), { url: `https://${h.ref.ref.sandboxId}-6080.example.test`, expiresAt: null, kind: "stable" })
})

test("Differently's error codes map onto OpenWork's taxonomy without reading messages", () => {
  for (const [status, code, expected, retryable] of [
    [404, "not_found", "not_found", false], [409, "conflict", "conflict", false], [429, "quota_exceeded", "capacity", false],
    [422, "no_eligible_pool", "capacity", false], [501, "unsupported_operation", "invalid_state", false], [409, "invalid_state", "invalid_state", true],
    [503, "provider_unavailable", "transient", true], [401, "unauthenticated", "auth", false], [403, "suspended", "auth", false], [502, "", "transient", true],
  ] as const) {
    const error = differentlyError(status, code ? { error: { code, message: "arbitrary" } } : null)
    assert.ok(error instanceof SandboxError)
    assert.equal(error.code, expected, `${code || status}`)
    assert.equal(error.retryable, retryable, `${code || status} retryable`)
    assert.equal(error.providerId, "differently")
  }
})

test("a wrong key surfaces as an auth error", async () => {
  const fake = fakeDifferently()
  const p = createDifferentlyProvider({ url: "https://differently.test", apiKey: "dly_wrong" }, { ...quick, fetch: fake.fetch })
  await assert.rejects(p.find({ idempotencyKey: "x" }), (error: unknown) => error instanceof SandboxError && error.code === "auth")
})
