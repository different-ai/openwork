import assert from "node:assert/strict"
import { test } from "node:test"
import { withExternalMcpCreationRetry } from "../src/capability-sources/external-mcp-creation-retry.js"

test("connection creation recovers from wrapped MySQL and PlanetScale deadlocks", async () => {
  for (const cause of [
    Object.assign(new Error("deadlock"), { code: "ER_LOCK_DEADLOCK" }),
    Object.assign(new Error("deadlock"), { errno: 1213 }),
    Object.assign(new Error("vttablet: Deadlock found when trying to get lock; try restarting transaction (errno 1213) (sqlstate 40001)"), { name: "DatabaseError" }),
  ]) {
    let attempts = 0
    const saved = await withExternalMcpCreationRetry(async () => {
      if (++attempts === 1) throw new Error("Failed query", { cause })
      return "saved connection and grants"
    })
    assert.equal(saved, "saved connection and grants")
    assert.equal(attempts, 2)
  }
})

test("persistent deadlocks stop after three transaction attempts", async () => {
  const error = new Error("Failed query", { cause: { errno: 1213 } })
  let attempts = 0
  await assert.rejects(withExternalMcpCreationRetry(async () => { attempts++; throw error }), (caught) => caught === error)
  assert.equal(attempts, 3)
})

test("constraint failures and ambiguous connection loss are never replayed", async () => {
  for (const code of ["ER_DUP_ENTRY", "ER_BAD_FIELD_ERROR", "ECONNRESET", "ER_LOCK_WAIT_TIMEOUT"]) {
    const error = new Error("Failed query", { cause: Object.assign(new Error("database failure"), { code }) })
    let attempts = 0
    await assert.rejects(withExternalMcpCreationRetry(async () => { attempts++; throw error }), (caught) => caught === error)
    assert.equal(attempts, 1)
  }
})

test("query parameters resembling a deadlock diagnostic do not trigger a retry", async () => {
  const error = new Error("Failed query: insert connection\nparams: connection named (errno 1213)", {
    cause: Object.assign(new Error("duplicate external key"), { code: "ER_DUP_ENTRY" }),
  })
  let attempts = 0
  await assert.rejects(withExternalMcpCreationRetry(async () => { attempts++; throw error }), (caught) => caught === error)
  assert.equal(attempts, 1)
})
