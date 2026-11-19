/** The router's `POST /v1/cells/ids`: which cell id each cell name has, for Den's admin page. */
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { test } from "node:test"
import { CELL_IDS_LIMIT, cellIdsResponse } from "../src/cell-ids.js"

const cell = {
  valid: (name: string) => name === "service" || name.startsWith("owner:") || /^session:hs_[A-Za-z0-9_-]{8,96}$/.test(name),
  id: (name: string) => createHash("sha256").update(name).digest("hex"),
}
const ask = (body: unknown) => cellIdsResponse(new Request("https://runner.test/v1/cells/ids", { method: "POST", body: typeof body === "string" ? body : JSON.stringify(body) }), cell)

test("each cell name gets its id, and anything that is not a cell name is left out", async () => {
  const response = await ask({ names: ["session:hs_c_0123456789abcdef0123456789abcdef", "owner:wb:abc", "service", "session:not-a-session", "elsewhere"] })
  assert.equal(response.status, 200)
  assert.equal(response.headers.get("cache-control"), "no-store")
  const { ids } = await response.json() as { ids: Record<string, string> }
  assert.deepEqual(Object.keys(ids), ["session:hs_c_0123456789abcdef0123456789abcdef", "owner:wb:abc", "service"])
  assert.equal(ids.service, cell.id("service"))
  assert.match(ids["owner:wb:abc"] ?? "", /^[0-9a-f]{64}$/)
})

test("a request that is not a list of names is refused, and so is one past the limit", async () => {
  assert.equal((await ask("not json")).status, 400)
  assert.equal((await ask({ names: "service" })).status, 400)
  assert.equal((await ask({ names: ["service"], also: true })).status, 400)
  assert.equal((await ask({ names: Array.from({ length: CELL_IDS_LIMIT + 1 }, () => "service") })).status, 400)
  assert.deepEqual(await (await ask({ names: [] })).json(), { ids: {} })
})
