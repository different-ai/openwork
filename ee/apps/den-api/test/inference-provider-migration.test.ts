import { expect, test } from "bun:test"
import { isMigrationSourceLockConflict } from "../src/llm/inference-provider-migration.js"

const sourceQuery = "select * from llm_provider where id = ? for update nowait"

for (const diagnostic of [
  { code: "ER_LOCK_NOWAIT", errno: 3572, sqlState: "HY000" },
  { code: "ER_LOCK_WAIT_TIMEOUT", errno: 1205, sqlState: "HY000" },
  { code: 1205, sqlState: "HY000" },
  { errno: 1205, sqlstate: "HY000" },
  { code: "1205", sqlState: "HY000" },
  { errno: 3572 },
  { code: "ER_LOCK_NOWAIT" },
]) {
  test(`migration NOWAIT recognizes ${JSON.stringify(diagnostic)} directly and through nested provider/Drizzle causes`, () => {
    const databaseError = Object.assign(new Error("Database source lock conflict"), diagnostic)
    const providerError = new Error("Provider query failed", { cause: databaseError })
    // den-db does not export DrizzleQueryError; reproduce its standard cause/query/params shape.
    const drizzleError = Object.assign(new Error("Failed query", { cause: providerError }), {
      name: "DrizzleQueryError", query: sourceQuery, params: ["fixture-source"],
    })
    expect(isMigrationSourceLockConflict(databaseError)).toBe(true)
    expect(isMigrationSourceLockConflict(providerError)).toBe(true)
    expect(isMigrationSourceLockConflict(drizzleError)).toBe(true)
    expect(isMigrationSourceLockConflict({ cause: { cause: drizzleError } })).toBe(true)
  })
}

for (const error of [
  new Error("Lock wait timeout exceeded; try restarting transaction"),
  { code: "ETIMEDOUT" },
  { code: "ECONNRESET" },
  { code: "ER_QUERY_TIMEOUT", errno: 3024, sqlState: "HY000" },
  { code: "ER_LOCK_DEADLOCK", errno: 1213, sqlState: "40001" },
  { code: "ER_PARSE_ERROR", errno: 1064, sqlState: "42000" },
  { code: "ER_PARSE_ERROR", errno: 1205, sqlState: "HY000" },
  { errno: 1205, sqlState: "42000" },
  { code: "ER_LOCK_WAIT_TIMEOUT", sqlState: "HYT00" },
  { sqlState: "HY000" },
  null,
  "ER_LOCK_WAIT_TIMEOUT",
]) {
  test(`unexpected database/network diagnostics remain errors: ${JSON.stringify(error)}`, () => {
    expect(isMigrationSourceLockConflict(error)).toBe(false)
    expect(isMigrationSourceLockConflict(new Error("Provider wrapper", { cause: error }))).toBe(false)
  })
}

test("cyclic and non-object cause chains terminate without classifying an unrelated failure", () => {
  const error = new Error("Unrelated failure")
  error.cause = error
  expect(isMigrationSourceLockConflict(error)).toBe(false)
  expect(isMigrationSourceLockConflict({ cause: undefined })).toBe(false)
})
