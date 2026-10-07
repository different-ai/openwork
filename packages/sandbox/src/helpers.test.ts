import assert from "node:assert/strict"
import { test } from "node:test"
import { SandboxError, RuntimeProviderError, sandboxName, ensure, ensureRunning, destroyScope, SCOPE_LABEL, withBlocks, instrument, type SandboxSpec } from "./index.js"
import { createFakeProvider } from "./testing/index.js"

const opts = { timeoutMs: 3000 }
const spec = (key: string, scope = "tests"): SandboxSpec => ({ workerId: "", idempotencyKey: key, image: null, env: {}, labels: { [SCOPE_LABEL]: scope }, storage: [], exposePorts: [] })

test("error alias preserves instanceof for existing callers", () => {
  assert.ok(new SandboxError({ providerId: "fake", code: "conflict", message: "exists" }) instanceof RuntimeProviderError)
})
test("names are stable, bounded, collision-resistant and valid slugs", () => {
  assert.equal(sandboxName("tests", "computer", "a"), sandboxName("tests", "computer", "a"))
  assert.notEqual(sandboxName("a b", "computer", "a"), sandboxName("a-b", "computer", "a"))
  assert.match(sandboxName("tests", "computer", "a"), /^[a-z0-9-]{1,63}$/)
  assert.match(sandboxName("!!!", "??", "a"), /^[a-z0-9]+(?:-[a-z0-9]+)*$/)
  assert.throws(() => sandboxName("", "computer", "a"))
})
test("ensure adopts, then wakes a stopped instance without executing work", async () => {
  const p = createFakeProvider()
  const first = await ensure(p, spec("job"), opts)
  const second = await ensure(p, spec("job"), opts)
  assert.deepEqual(first.ref, second.ref)
  assert.equal(p.fake.count("create"), 1)
  await p.stop(first, opts)
  assert.equal((await ensureRunning(p, spec("job"), opts)).state, "running")
  assert.equal(p.fake.count("exec"), 0)
})
test("ensure handles a competing creator, never retries unknown outcomes", async () => {
  const p = createFakeProvider({ onOperation(op) {
    if (op.name === "create") p.fake.seed({ idempotencyKey: "race", state: "running", labels: { [SCOPE_LABEL]: "tests" } })
  } })
  const adopted = await ensure(p, spec("race"), opts)
  assert.equal(adopted.state, "running")
  assert.equal(p.fake.count("create"), 1)
  const broken = createFakeProvider({ onOperation(op) {
    if (op.name === "create") throw new SandboxError({ providerId: "fake", code: "transient", message: "unknown response" })
  } })
  await assert.rejects(ensure(broken, spec("job"), opts), /unknown response/)
  assert.equal(broken.fake.count("create"), 1)
})
test("scoped teardown refuses empty scope, leaves neighboring scopes and reports failures", async () => {
  const p = createFakeProvider()
  await p.create(spec("mine"), opts)
  await p.create(spec("theirs", "production"), opts)
  await assert.rejects(destroyScope(p, "", opts), /empty/)
  const result = await destroyScope(p, "tests", opts)
  assert.equal(result.deleted.length, 1)
  assert.equal(result.failed.length, 0)
  assert.ok(await p.find({ idempotencyKey: "theirs" }))
})
test("withBlocks narrows types and checks a job's requirements", async () => {
  const p = createFakeProvider()
  const b = withBlocks(p, ["run", "files"], "computer")
  const h = await p.create(spec("job"), opts)
  await b.files.write(h, "/tmp/a", new Uint8Array([1, 2]), opts)
  assert.deepEqual(await b.files.read(h, "/tmp/a", opts), new Uint8Array([1, 2]))
  assert.equal(await b.files.stat(h, "/tmp/missing", opts), null)
  assert.throws(() => withBlocks({ ...p, blocks: {} }, ["files"], "computer"), /computer requires files/)
})
test("instrumentation cannot affect the operation and emits no input or secrets", async () => {
  const p = createFakeProvider()
  const events: unknown[] = []
  const observed = instrument(p, e => { events.push(e); throw new Error("broken observer") })
  const h = await observed.create(spec("secret-key"), opts)
  await withBlocks(observed, ["run"]).run(h, { command: "secret command", ...opts })
  assert.equal(events.length, 2)
  assert.ok(!JSON.stringify(events).includes("secret"))
})

test("scoped teardown retains failed instances and continues with the rest", async () => {
  const p = createFakeProvider({ onOperation(op) {
    if (op.name === "destroy" && op.attempt === 1) throw new SandboxError({ providerId: "fake", code: "auth", message: "denied" })
  } })
  await p.create(spec("one"), opts)
  await p.create(spec("two"), opts)
  const result = await destroyScope(p, "tests", opts)
  assert.equal(result.failed.length, 1)
  assert.equal(result.deleted.length, 1)
  assert.ok(await p.get(result.failed[0].handle.ref))
})
