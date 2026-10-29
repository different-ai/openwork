import assert from "node:assert/strict"
import { test } from "node:test"
import { forgetRequestReadsOnWrite, requestRead, requestReadMany, withRequestReads } from "../src/request-reads.ts"

function counter() {
  let loads = 0
  return { load: async () => { loads += 1; return loads }, loads: () => loads }
}

test("callers in one request share one read, including concurrent ones", async () => {
  const reads = counter()
  await withRequestReads(async () => {
    const [first, second] = await Promise.all([requestRead("k", reads.load), requestRead("k", reads.load)])
    assert.deepEqual([first, second, await requestRead("k", reads.load)], [1, 1, 1])
  })
  assert.equal(reads.loads(), 1)
})

test("different keys load separately", async () => {
  const reads = counter()
  await withRequestReads(async () => {
    assert.deepEqual([await requestRead("a", reads.load), await requestRead("b", reads.load)], [1, 2])
  })
})

test("a write statement drops shared reads; a read statement does not", async () => {
  const reads = counter()
  await withRequestReads(async () => {
    assert.equal(await requestRead("k", reads.load), 1)
    forgetRequestReadsOnWrite("select `id` from `member` where `member`.`id` = ?")
    assert.equal(await requestRead("k", reads.load), 1)
    forgetRequestReadsOnWrite("update `member` set `role` = ? where `member`.`id` = ?")
    assert.equal(await requestRead("k", reads.load), 2)
    for (const write of ["insert into `team` values (?)", "  delete from `team` where `id` = ?", "REPLACE INTO `team` VALUES (?)"]) {
      const before = reads.loads()
      forgetRequestReadsOnWrite(write)
      await requestRead("k", reads.load)
      assert.equal(reads.loads(), before + 1, write)
    }
  })
})

test("a failed read is not shared", async () => {
  let attempts = 0
  await withRequestReads(async () => {
    const failOnce = async () => {
      attempts += 1
      if (attempts === 1) throw new Error("database unavailable")
      return "rows"
    }
    await assert.rejects(requestRead("k", failOnce), /database unavailable/)
    assert.equal(await requestRead("k", failOnce), "rows")
  })
  assert.equal(attempts, 2)
})

test("outside a request every call loads, and each request has its own reads", async () => {
  const reads = counter()
  assert.equal(await requestRead("k", reads.load), 1)
  assert.equal(await requestRead("k", reads.load), 2)
  await withRequestReads(async () => {
    assert.equal(await requestRead("k", reads.load), 3)
    await withRequestReads(async () => {
      assert.equal(await requestRead("k", reads.load), 4, "a nested request does not see the outer one's reads")
    })
    assert.equal(await requestRead("k", reads.load), 3)
  })
  await withRequestReads(async () => {
    assert.equal(await requestRead("k", reads.load), 5, "nothing crosses requests")
  })
})

test("a write in a nested request also drops the outer request's shared reads", async () => {
  const reads = counter()
  await withRequestReads(async () => {
    assert.equal(await requestRead("k", reads.load), 1)
    await withRequestReads(async () => {
      forgetRequestReadsOnWrite("insert into `skill` values (?)")
    })
    assert.equal(await requestRead("k", reads.load), 2)
  })
})

test("many ids load in one call, reuse earlier reads, and are shared one by one afterwards", async () => {
  const batches: string[][] = []
  const loadMany = async (missing: string[]) => {
    batches.push(missing)
    return new Map(missing.filter((id) => id !== "gone").map((id) => [id, `row:${id}`]))
  }
  const single = counter()
  await withRequestReads(async () => {
    assert.equal(await requestRead("row:a", async () => "row:a (single)"), "row:a (single)")
    const rows = await requestReadMany(["a", "b", "c", "b", "gone"], (id) => `row:${id}`, loadMany, null)
    assert.deepEqual([...rows], [["a", "row:a (single)"], ["b", "row:b"], ["c", "row:c"], ["gone", null]])
    assert.deepEqual(batches, [["b", "c", "gone"]], "only ids nobody read yet load, together and once each")
    assert.equal(await requestRead("row:c", single.load), "row:c", "a later single read of a loaded id shares it")
    assert.equal(await requestRead("row:gone", single.load), null, "so does an id the batch did not find")
    assert.deepEqual([...await requestReadMany(["c"], (id) => `row:${id}`, loadMany, null)], [["c", "row:c"]])
  })
  assert.equal(single.loads(), 0)
  assert.equal(batches.length, 1)
})

test("a failed batch is not shared, and an empty batch loads nothing", async () => {
  let attempts = 0
  const loadMany = async (missing: string[]) => {
    attempts += 1
    if (attempts === 1) throw new Error("database unavailable")
    return new Map(missing.map((id) => [id, id.toUpperCase()]))
  }
  await withRequestReads(async () => {
    await assert.rejects(requestReadMany(["a", "b"], (id) => id, loadMany, null), /database unavailable/)
    assert.equal(await requestRead("a", async () => "single"), "single", "the failed id reads again")
    assert.deepEqual([...await requestReadMany(["a", "b"], (id) => id, loadMany, null)], [["a", "single"], ["b", "B"]])
    assert.deepEqual([...await requestReadMany([], (id) => id, loadMany, null)], [])
  })
  assert.equal(attempts, 2)
})
