/**
 * DEN_API_KEY_RATE_LIMIT_MAX sets how many requests a minute each new
 * organization API key may make, and the key is refused once it runs out.
 */
import assert from "node:assert/strict"
import { after, test } from "node:test"
import { bootDen, field, list, summary, text } from "./harness.js"

const LIMIT = 3
const den = await bootDen({ env: { DEN_API_KEY_RATE_LIMIT_MAX: String(LIMIT) } })
// env.ts reads the environment when it loads, so import it after bootDen sets it.
const { parseApiKeyRateLimitMax } = await import("../../src/env.js")
after(() => den.close())

test("a new API key gets the configured limit and is refused once it is used up", async () => {
  const { orgId, owner } = await den.createOrg(await den.signUp("Limit Owner"), "Limit org")
  const minted = await den.as(owner, orgId)("POST", "/v1/api-keys", { name: "Limited script key" })
  assert.equal(minted.status, 201, summary(minted))
  const apiKey = text(field(minted.body, "key"), "api key value")
  const apiKeyId = text(field(minted.body, "apiKey", "id"), "api key id")

  const listed = await den.as(owner, orgId)("GET", "/v1/api-keys")
  const summaryRow = list(field(listed.body, "apiKeys")).find((row) => field(row, "id") === apiKeyId)
  assert.equal(field(summaryRow, "rateLimitMax"), LIMIT, listed.text.slice(0, 400))

  const statuses: number[] = []
  for (let attempt = 0; attempt <= LIMIT; attempt++) {
    statuses.push((await den.request(null, "GET", "/v1/me", { headers: { "x-api-key": apiKey } })).status)
  }
  assert.deepEqual(statuses.slice(0, LIMIT), Array(LIMIT).fill(200), `statuses: ${statuses.join(",")}`)
  assert.notEqual(statuses[LIMIT], 200, `the key was not refused after ${LIMIT} requests: ${statuses.join(",")}`)
})

test("a blank value keeps the default and a bad value stops startup", () => {
  assert.equal(parseApiKeyRateLimitMax(undefined), 600)
  assert.equal(parseApiKeyRateLimitMax("  "), 600)
  assert.equal(parseApiKeyRateLimitMax("1200"), 1200)
  for (const bad of ["0", "-5", "1.5", "lots"]) {
    assert.throws(() => parseApiKeyRateLimitMax(bad), /DEN_API_KEY_RATE_LIMIT_MAX/)
  }
})
