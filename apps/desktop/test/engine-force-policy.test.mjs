import assert from "node:assert/strict"
import test from "node:test"
import { applyDesktopEngineForcePolicy, desktopEngineForcePolicy } from "../electron/engine-force-policy.mjs"

test("policy is applied to the existing host route using only upgrade and host credentials", async () => {
  for (const upgrade of [true, false]) {
    await applyDesktopEngineForcePolicy({ upgrade }, {
      getServerInfo: async () => ({ baseUrl: "http://local.invalid/", hostToken: "host-secret", clientToken: "client-secret" }),
      fetchImpl: async (url, init) => {
        assert.equal(url, "http://local.invalid/experimental/engine-v2-preview/force")
        assert.equal(init.method, "POST")
        assert.deepEqual(JSON.parse(init.body), { upgrade })
        assert.equal(new Headers(init.headers).get("X-OpenWork-Host-Token"), "host-secret")
        assert.equal(new Headers(init.headers).has("Authorization"), false)
        return Response.json({ ok: true })
      },
    })
  }
})

test("false is meaningful and unavailable policy or host credentials are not fabricated", async () => {
  assert.deepEqual(desktopEngineForcePolicy({ enginePolicy: { upgrade: false } }), { upgrade: false })
  assert.equal(desktopEngineForcePolicy({ enginePolicy: {} }), undefined)
  assert.equal(desktopEngineForcePolicy({}), undefined)
  await assert.rejects(applyDesktopEngineForcePolicy({ upgrade: true }, { getServerInfo: async () => ({ baseUrl: "http://local.invalid" }) }), /unavailable/)
})
