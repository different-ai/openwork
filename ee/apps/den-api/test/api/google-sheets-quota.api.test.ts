import assert from "node:assert/strict"
import { test } from "node:test"
import { fetchGoogleSheet } from "../../src/routes/org/google-sheets-quota.js"

const allow = async () => null
const signal = new AbortController().signal

test("a short quota pause retries a read once and charges both provider calls", async () => {
  const charges: string[] = []
  let calls = 0
  const reply = await fetchGoogleSheet("member", "GET", signal,
    async () => ++calls === 1 ? new Response(null, { status: 429, headers: { "Retry-After": "1" } }) : new Response("ok"),
    async (key, max, window) => { assert.equal(max, 60); assert.equal(window, 60_000); charges.push(key); return null })
  assert.equal(await reply.text(), "ok")
  assert.deepEqual(charges, ["sheets:read:member", "sheets:read:member"])
})

test("writes are never replayed and long provider delays are returned immediately", async () => {
  for (const method of ["POST", "GET"]) {
    let calls = 0
    const reply = await fetchGoogleSheet("member", method, signal, async () => {
      calls++
      return new Response(null, { status: 429, headers: { "Retry-After": "47" } })
    }, allow)
    assert.equal(calls, 1)
    assert.equal(reply.status, 429)
    assert.equal(reply.headers.get("Retry-After"), "47")
  }
})

test("a full minute budget or concurrent burst returns 429 before a provider call", async () => {
  const forbidden = async () => { throw new Error("unexpected provider call") }
  const quota = await fetchGoogleSheet("member", "GET", signal, forbidden, async () => 23)
  assert.equal(quota.headers.get("Retry-After"), "23")
  const gate = Promise.withResolvers<void>()
  const pending = Array.from({ length: 4 }, () => fetchGoogleSheet("member", "GET", signal,
    async () => { await gate.promise; return new Response() }, allow))
  try {
    assert.equal((await fetchGoogleSheet("member", "GET", signal, forbidden, allow)).status, 429)
    assert.equal((await fetchGoogleSheet("other", "GET", signal, async () => new Response(), allow)).status, 200)
  } finally { gate.resolve(); await Promise.all(pending) }
  assert.equal((await fetchGoogleSheet("member", "GET", signal, async () => new Response(), allow)).status, 200)
})

test("an authenticated Sheets read returns the provider delay and enforces the member's minute budget", async () => {
  const { bootDen, startFakeHttpServer } = await import("./harness.js")
  const { normalizeDenTypeId } = await import("@openwork-ee/utils/typeid")
  let calls = 0
  const google = await startFakeHttpServer((_req, _body, res) => {
    calls++
    if (calls === 1) res.writeHead(429, { "Retry-After": "41" }).end()
    else res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ range: "Sheet1!A1:A1", majorDimension: "ROWS", values: [[1]] }))
  })
  try {
    const den = await bootDen({ env: { DEN_GOOGLE_API_BASE_URL: google.url } })
    try {
      const { upsertOrgOAuthClient, upsertConnectedAccount } = await import("../../src/capability-sources/oauth-credentials.js")
      const { orgId, owner } = await den.createOrg(await den.signUp("Sheets Owner"), "Sheets quota")
      const account = { organizationId: normalizeDenTypeId("organization", orgId), orgMembershipId: normalizeDenTypeId("member", owner.memberId), providerId: "google-workspace" }
      await upsertOrgOAuthClient({ ...account, clientId: "local-client", createdByOrgMembershipId: account.orgMembershipId, extra: { features: ["sheetsRead"] } })
      await upsertConnectedAccount({ ...account, accessToken: "local-access", expiresAt: new Date(Date.now() + 3_600_000), scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"] })
      const read = () => den.as(owner, orgId)("GET", "/v1/capabilities/google-workspace/spreadsheets/demo/values?range=Sheet1!A1:A1")
      const first = await read()
      assert.equal(first.status, 429, first.text)
      assert.equal(first.headers.get("Retry-After"), "41")
      assert.match(first.text, /Batch your reads/)
      for (let i = 1; i < 60; i++) {
        const response = await read()
        assert.equal(response.status, 200, response.text)
      }
      assert.equal((await read()).status, 429)
      assert.equal(calls, 60)
    } finally { await den.close() }
  } finally { await google.close() }
})
