import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { readFileSync } from "node:fs"
import { test } from "node:test"
import { instrument } from "@openwork/sandbox"
import { sandboxBlockConformanceCases, sandboxProviderConformanceCases } from "@openwork/sandbox/testing"
import { createInstaboxProvider } from "./index.js"

const keyFile = process.env.INSTABOX_API_KEY_FILE
const apiKey = process.env.INSTABOX_API_KEY ?? (keyFile ? readFileSync(keyFile, "utf8").trim() : undefined)
if (!apiKey) throw new Error("test:live requires INSTABOX_API_KEY or INSTABOX_API_KEY_FILE (creates and deletes real sandboxes)")

const log = (e: { operation: string; durationMs: number; outcome: string }) => console.log(`   ${e.operation} ${(e.durationMs / 1000).toFixed(1)}s ${e.outcome}`)
const factory = () => instrument(createInstaboxProvider({ apiKey }), log)

for (const c of sandboxProviderConformanceCases(factory)) test(`instabox: ${c.name}`, { timeout: 120_000 }, c.run)
for (const c of sandboxBlockConformanceCases(factory, ["run", "files", "pause", "snapshots"])) test(`instabox: ${c.name}`, { timeout: 180_000 }, c.run)

test("instabox: detached exec reports a running job, then its exit code and output", { timeout: 120_000 }, async () => {
  const p = factory()
  const key = `detach-${randomUUID()}`
  const h = await p.create({ idempotencyKey: key, image: null, labels: { "openwork.test": key }, env: {}, storage: [], exposePorts: [] }, { timeoutMs: 30_000 })
  try {
    const job = await p.exec(h, { command: "sleep 4; echo done; exit 4", detach: true, timeoutMs: 30_000 })
    assert.ok(job.id.length > 0)
    assert.equal(await job.exitCode(), null)
    let code: number | null = null
    for (let i = 0; i < 30 && code === null; i++) code = await job.exitCode()
    assert.equal(code, 4)
    assert.match((await job.logs()).stdout, /done/)
  } finally {
    await p.destroy(h, { timeoutMs: 30_000 })
  }
})
