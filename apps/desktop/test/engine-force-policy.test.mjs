import assert from "node:assert/strict"
import test from "node:test"
import { applyDesktopEngineForcePolicy, desktopEngineForcePolicy } from "../electron/engine-force-policy.mjs"

test("legacy positive policy uses only upgrade and private host credentials", async () => {
  await applyDesktopEngineForcePolicy({ upgrade: true }, {
    getServerInfo: async () => ({ baseUrl: "http://local.invalid/", hostToken: "host-secret", clientToken: "client-secret" }),
    fetchImpl: async (url, init) => {
      assert.equal(url, "http://local.invalid/experimental/engine-v2-preview/force")
      assert.equal(init.method, "POST")
      assert.deepEqual(JSON.parse(init.body), { upgrade: true })
      assert.equal(new Headers(init.headers).get("X-OpenWork-Host-Token"), "host-secret")
      assert.equal(new Headers(init.headers).has("Authorization"), false)
      return Response.json({ ok: true })
    },
  })
})

test("legacy upgrade:false is ignored rather than forwarded as a rollback", async () => {
  assert.equal(desktopEngineForcePolicy({ enginePolicy: { upgrade: false } }), undefined)
  await applyDesktopEngineForcePolicy({ upgrade: false }, {
    getServerInfo: async () => assert.fail("off policy must not touch the local host"),
    fetchImpl: async () => assert.fail("off policy must not be forwarded"),
  })
})

test("missing policy and unavailable host credentials are not fabricated", async () => {
  assert.deepEqual(desktopEngineForcePolicy({ enginePolicy: { upgrade: true } }), { upgrade: true })
  assert.equal(desktopEngineForcePolicy({ enginePolicy: {} }), undefined)
  assert.equal(desktopEngineForcePolicy({}), undefined)
  await assert.rejects(applyDesktopEngineForcePolicy({ upgrade: true }, { getServerInfo: async () => ({ baseUrl: "http://local.invalid" }) }), /unavailable/)
})
