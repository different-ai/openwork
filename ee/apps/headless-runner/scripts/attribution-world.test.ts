import assert from "node:assert/strict"
import { test } from "node:test"
import { attributionProtocols, runAttributionCase } from "./attribution-world.js"
import { inferenceGateway } from "./fixtures/inference-gateway.js"

for (const protocol of attributionProtocols) {
  for (const configured of [true, false]) {
    test(`attribution world: ${protocol}, configured=${configured}: concurrent members, titles, anonymous fallback, durable privacy`, { timeout: 30_000 }, async () => {
      const report = await runAttributionCase({ protocol, configured, expect: "attributed" })
      assert.equal(report.requests.length, 11)
      assert.equal(report.requests.filter((request) => request.attribution !== null).length, configured ? 6 : 0)
      assert.equal(report.maxConcurrentStreams, 5)
      assert.equal(report.persistedIdentityAbsent, true)
      assert.equal(report.sameSessionMissingIdentityAbsent, true)
      assert.equal(report.unauthenticatedStatus, 401)
    })
  }
}

test("fake upstream supports JSON and SSE for all three APIs and records wire headers", { timeout: 5_000 }, async () => {
  const gateway = await inferenceGateway()
  try {
    for (const path of ["chat/completions", "messages", "responses"]) {
      for (const stream of [false, true]) {
        const response = await fetch(`${gateway.url}/${path}`, {
          method: "POST", headers: { "content-type": "application/json", "x-fixture-capture": "sent-on-wire" },
          body: JSON.stringify({ model: "fixture-alias", stream }), signal: AbortSignal.timeout(2_000),
        })
        assert.equal(response.status, 200)
        if (stream) {
          assert.match(response.headers.get("content-type") ?? "", /text\/event-stream/)
          assert.match(await response.text(), /Done/)
        } else {
          assert.match(response.headers.get("content-type") ?? "", /application\/json/)
          assert.match(await response.text(), /A short title/)
        }
      }
    }
    assert.equal(gateway.requests.length, 6)
    assert.ok(gateway.requests.every((request) => request.headers["x-fixture-capture"] === "sent-on-wire"))
    assert.deepEqual(gateway.errors, [])
  } finally {
    await gateway.close()
  }
})
