import assert from "node:assert/strict"
import { test } from "node:test"
import { denServerFactsSchema } from "@openwork/types/den/service-readiness"

process.env.DATABASE_URL ??= "mysql://test:test@127.0.0.1:3306/server_start_unit_test"
process.env.BETTER_AUTH_URL ??= "http://unit.test"
process.env.BETTER_AUTH_SECRET ??= "synthetic-server-start-unit-test-secret-not-production"
process.env.DEN_DB_ENCRYPTION_KEY ??= "synthetic-server-start-unit-test-key-not-production"
process.env.OPENWORK_DEV_MODE = "1"
process.env.DEN_API_VERSION = `release-${"x".repeat(80)}`
const { denServerFacts, markServerListening } = await import("../src/server-start.js")

test("server facts: per-process start, startup time once listening, bounded version", () => {
  const before = denServerFacts()
  denServerFactsSchema.parse(before)
  assert.equal(before.startupMs, null, "not listening yet")
  assert.equal(before.version.length, 64)
  assert.ok(before.version.startsWith("release-"))
  const started = Date.parse(before.startedAt)
  assert.ok(started <= Date.now())
  assert.ok(Date.now() - started < 10 * 60_000, "this process started recently")

  markServerListening()
  const listening = denServerFacts()
  denServerFactsSchema.parse(listening)
  assert.equal(typeof listening.startupMs, "number")
  assert.ok((listening.startupMs ?? -1) >= 0)
  assert.ok((listening.startupMs ?? 0) <= Date.now() - started + 1)
  assert.equal(listening.startedAt, before.startedAt, "start time is fixed for the process")

  markServerListening()
  assert.equal(denServerFacts().startupMs, listening.startupMs, "the first listen time is kept")
})
