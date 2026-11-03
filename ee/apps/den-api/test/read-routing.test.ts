import assert from "node:assert/strict"
import test from "node:test"
import { forgetRequestReadsOnWrite, withRequestReads } from "../src/request-reads.ts"
import { shouldReadFromPrimary, withPrimaryReads } from "../src/read-routing.ts"

test("a request reads from the replica until it writes, then from the primary", async () => {
  await withRequestReads(async () => {
    assert.equal(shouldReadFromPrimary(), false)
    forgetRequestReadsOnWrite("select 1")
    assert.equal(shouldReadFromPrimary(), false)
    forgetRequestReadsOnWrite("insert into `member` values (?)")
    assert.equal(shouldReadFromPrimary(), true)
  })
  await withRequestReads(async () => {
    assert.equal(shouldReadFromPrimary(), false, "the next request starts on the replica again")
  })
})

test("a write in a nested request pins the request around it too", async () => {
  await withRequestReads(async () => {
    await withRequestReads(async () => {
      forgetRequestReadsOnWrite("update `organization` set `name` = ?")
    })
    assert.equal(shouldReadFromPrimary(), true)
  })
})

test("withPrimaryReads pins reads without a write, and nothing pins outside a request", async () => {
  assert.equal(shouldReadFromPrimary(), false)
  forgetRequestReadsOnWrite("delete from `session`")
  assert.equal(shouldReadFromPrimary(), false)
  await withPrimaryReads(async () => assert.equal(shouldReadFromPrimary(), true))
})
