import assert from "node:assert/strict"
import { test } from "node:test"
import axios from "axios"
import "../src/worker/http.js"

test("Worker SDK requests preserve authentication, JSON and cancellation without browser Request options", async () => {
  const controller = new AbortController()
  let requests = 0
  const response = await axios.post("https://api.example.test/sandbox", { name: "isolated-computer" }, {
    adapter: "fetch",
    headers: { authorization: "Bearer test-only-credential" },
    signal: controller.signal,
    env: { fetch: async (url, init) => {
      requests++
      assert.equal(url, "https://api.example.test/sandbox")
      assert.equal(init?.method, "POST")
      assert.equal(new Headers(init?.headers).get("authorization"), "Bearer test-only-credential")
      assert.deepEqual(JSON.parse(String(init?.body)), { name: "isolated-computer" })
      assert.ok(init?.signal)
      for (const option of ["cache", "referrer", "mode", "priority", "window"]) assert.ok(!Object.hasOwn(init, option), option)
      return Response.json({ id: "created-computer" })
    } },
  })
  assert.equal(requests, 1)
  assert.deepEqual(response.data, { id: "created-computer" })
})
