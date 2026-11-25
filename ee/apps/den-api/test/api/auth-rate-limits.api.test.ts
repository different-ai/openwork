import assert from "node:assert/strict"
import { after, test } from "node:test"
import { bootDen, field, summary } from "./harness.js"

// Production-like: rate limits on (dev mode off), default address headers.
const den = await bootDen({ env: { OPENWORK_DEV_MODE: "0" } })
after(() => den.close())

const OFFICE = "198.51.100.7"

function fromAddress(ip: string) {
  return { "x-real-ip": ip }
}

function signUp(email: string, headers: Record<string, string>) {
  return den.request(null, "POST", "/api/auth/sign-up/email", { headers, body: { email, name: "Teammate", password: den.password } })
}

test("a whole office behind one address signs up together", async () => {
  for (let person = 0; person < 12; person += 1) {
    const created = await signUp(`office-${person}+${den.stamp}@acme.test`, fromAddress(OFFICE))
    assert.equal(created.status, 200, `person ${person}: ${summary(created)}`)
  }
})

test("one email asking for codes is limited, with a readable wait", async () => {
  const email = `codes+${den.stamp}@acme.test`
  const statuses: number[] = []
  let last = null
  for (let attempt = 0; attempt < 6; attempt += 1) {
    last = await den.request(null, "POST", "/api/auth/email-otp/send-verification-otp", {
      headers: fromAddress(`192.0.2.${attempt + 1}`),
      body: { email, type: "email-verification" },
    })
    statuses.push(last.status)
  }
  assert.ok(statuses.slice(0, 5).every((status) => status !== 429), statuses.join(","))
  assert.ok(last)
  assert.equal(last.status, 429, summary(last))
  assert.equal(field(last.body, "error"), "rate_limited")
  assert.match(String(field(last.body, "message")), /try again in/)
  assert.ok(Number(last.headers.get("retry-after")) > 0)
})

test("Better Auth's remaining limits keep each address separate and ignore a caller-chosen bucket", async () => {
  const hammer = async (headers: Record<string, string>, times: number) => {
    let status = 0
    for (let attempt = 0; attempt < times; attempt += 1) {
      status = (await den.request(null, "GET", "/api/auth/ok", { headers })).status
    }
    return status
  }
  // Better Auth's default rule is 20 per minute per address and path.
  assert.equal(await hammer(fromAddress("192.0.2.50"), 21), 429)
  assert.equal(await hammer(fromAddress("192.0.2.51"), 1), 200, "another address keeps its own bucket")
  // Den's internal header cannot move a caller into a fresh bucket.
  assert.equal(await hammer({ ...fromAddress("192.0.2.50"), "x-openwork-resolved-client-ip": "192.0.2.99" }, 1), 429)
})
