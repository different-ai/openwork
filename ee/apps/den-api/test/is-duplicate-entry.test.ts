import assert from "node:assert/strict"
import { test } from "node:test"
import { isDuplicateEntry } from "../src/routes/org/declarative.js"

const planetScaleMessage = "target: db.-.primary: vttablet: rpc error: code = AlreadyExists desc = Duplicate entry 'org_1-marketing-slack' for key 'config_object.config_object_org_external_key' (errno 1062) (sqlstate 23000)"

test("detects mysql2 duplicate entry fields", () => {
  assert.equal(isDuplicateEntry({ code: "ER_DUP_ENTRY" }), true)
  assert.equal(isDuplicateEntry({ errno: 1062 }), true)
})

test("detects PlanetScale duplicate entry wrapped by Drizzle", () => {
  const driverError = new Error(planetScaleMessage)
  const drizzleError = new Error("Failed query: update `config_object` set `external_key` = ?", { cause: driverError })
  assert.equal(isDuplicateEntry(drizzleError), true)
})

test("does not treat other database errors as duplicates", () => {
  const driverError = new Error("vttablet: rpc error: code = ResourceExhausted desc = transaction pool connection limit exceeded")
  assert.equal(isDuplicateEntry(new Error("Failed query: update", { cause: driverError })), false)
  assert.equal(isDuplicateEntry(null), false)
})
