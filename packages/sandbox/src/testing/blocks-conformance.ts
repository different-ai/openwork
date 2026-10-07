import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { withBlocks } from "../lifecycle"
import type { SandboxBlocks } from "../blocks"
import type { SandboxProvider, SandboxSpec } from "../provider"
import type { ConformanceCase } from "./conformance"

/** Explicitly select blocks. Missing selected blocks fail; unselected blocks are not reported as passed. */
export function sandboxBlockConformanceCases(factory: () => SandboxProvider | Promise<SandboxProvider>, blocks: readonly (keyof SandboxBlocks)[]): ConformanceCase[] {
  const opts = { timeoutMs: 60_000 }
  async function using(fn: (p: SandboxProvider, spec: SandboxSpec) => Promise<void>) {
    const p = await factory()
    const key = `conformance-${randomUUID()}`
    const spec: SandboxSpec = { workerId: "", idempotencyKey: key, image: p.currentImage(), env: {}, labels: { "openwork.sandbox.scope": key }, storage: [], exposePorts: [] }
    await fn(p, spec)
  }
  return blocks.map(block => ({
    name: `block ${block}: observable behavior`,
    async run() {
      await using(async (p, spec) => {
        withBlocks(p, [block], "conformance") // check before allocating compute
        const h = await p.create(spec, opts)
        try {
          if (block === "run") {
            const { run } = withBlocks(p, ["run"])
            const result = await run(h, { ...opts, command: "printf '%s' \"$OPENWORK_CHECK\"; printf 'stderr' >&2; exit 7", cwd: "/tmp", env: { OPENWORK_CHECK: "value with ' quotes $ and spaces" } })
            assert.equal(result.exitCode, 7)
            assert.equal(result.stdout, "value with ' quotes $ and spaces")
            assert.equal(result.stderr, "stderr")
          } else if (block === "files") {
            const { files } = withBlocks(p, ["files"])
            const path = `/tmp/${spec.idempotencyKey}.bin`
            const bytes = new Uint8Array([0, 255, 10, 39, 128])
            assert.equal(await files.stat(h, path, opts), null)
            await files.write(h, path, bytes, opts)
            assert.deepEqual(await files.read(h, path, opts), bytes)
            assert.deepEqual(await files.stat(h, path, opts), { size: bytes.length, kind: "file" })
          } else if (block === "pause") {
            const { pause } = withBlocks(p, ["pause"])
            await pause(h, opts)
            assert.equal((await p.inspect(h)).state, "stopped")
            await p.start(h, opts)
            assert.equal((await p.inspect(h)).state, "running")
          } else if (block === "snapshots") {
            const { snapshots } = withBlocks(p, ["snapshots"])
            const image = await snapshots.create(h, `${spec.idempotencyKey}-image`, opts)
            try {
              assert.ok(image.id)
              const copy = await p.create({ ...spec, idempotencyKey: `${spec.idempotencyKey}-copy`, image }, opts)
              try { assert.equal(copy.state, "running") } finally { await p.destroy(copy, opts) }
            } finally { await snapshots.destroy(image, opts) }
          }
        } finally {
          await p.destroy(h, opts)
        }
      })
    },
  }))
}
