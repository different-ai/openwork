import assert from "node:assert/strict"
import { createHash, randomUUID } from "node:crypto"
import { after, test } from "node:test"
import { ManagedDeploymentTable } from "@openwork-ee/den-db/schema"
import { healthRoleName, heartbeatProof } from "@openwork/managed-deployments/aws"
import { bootDen, field, summary } from "./harness.js"

const den = await bootDen({ productionLike: true })
const org = await den.createOrg(await den.signUp("Heartbeat Owner"), "Heartbeat workspace")
const { db } = await import("../../src/db.js")
const ACCOUNT = "123456789012"
const HOUR = 60 * 60_000
const FIVE_MINUTES = 5 * 60_000
const realFetch = globalThis.fetch
const identities = new Map<string, { account: string; arn: string; signature: string }>()
let stsRequests = 0

// Only STS's external identity response is synthetic. The real Hono route,
// account/role and exact-body verification, replay guard and MySQL limiter run.
globalThis.fetch = async (input, init) => {
  const url = input instanceof Request ? input.url : String(input)
  if (url !== "https://sts.us-east-1.amazonaws.com/") return realFetch(input, init)
  stsRequests += 1
  assert.equal(init?.method, "POST")
  assert.equal(init?.body, "Action=GetCallerIdentity&Version=2011-06-15")
  const headers = new Headers(init?.headers)
  const deploymentId = headers.get("x-openwork-proof")?.split(":")[1] ?? ""
  const identity = identities.get(deploymentId)
  if (!identity || !headers.get("authorization")?.endsWith(`Signature=${identity.signature}`)) return new Response("Invalid fixture signature", { status: 403 })
  return new Response(`<GetCallerIdentityResponse><GetCallerIdentityResult><Account>${identity.account}</Account><Arn>${identity.arn}</Arn></GetCallerIdentityResult></GetCallerIdentityResponse>`, { headers: { "content-type": "text/xml" } })
}
after(async () => { globalThis.fetch = realFetch; await den.close() })

async function deployment() {
  const id = randomUUID()
  await db.insert(ManagedDeploymentTable).values({
    id, org_id: org.orgId, provider: "aws", name: "Heartbeat fixture", domain_name: "openwork.example.test", owner_email: "admin@example.test", size: "small", installed_version: "1.0.0",
    target: { accountId: ACCOUNT, region: "us-east-1", route53ZoneId: "ZTEST" },
  })
  identities.set(id, { account: ACCOUNT, arn: `arn:aws:sts::${ACCOUNT}:assumed-role/${healthRoleName(id)}/health-fixture`, signature: createHash("sha256").update(`fixture-identity:${id}`).digest("hex") })
  return id
}

const report = { version: "1.0.0", checks: [
  { id: "api_health", status: "ok", value: 12 }, { id: "database_ready", status: "ok" }, { id: "web_available", status: "ok", value: 15 },
  { id: "services_running", status: "ok", value: 2, total: 2 }, { id: "load_balancer_targets", status: "ok", value: 2, total: 2 },
  { id: "database_instance", status: "ok" }, { id: "database_storage", status: "ok", value: 10, total: 20 },
  { id: "database_backups", status: "ok", value: 1 }, { id: "certificate", status: "ok", value: 80 },
] }

function signedReport(id: string, signedAt: number, rawBody = JSON.stringify(report)) {
  const identity = identities.get(id)
  assert.ok(identity)
  const date = new Date(signedAt).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "")
  return {
    rawBody,
    headers: {
      "content-type": "application/json",
      "x-openwork-aws-authorization": `AWS4-HMAC-SHA256 Credential=fixture/${date.slice(0, 8)}/us-east-1/sts/aws4_request, SignedHeaders=content-type;host;x-amz-date;x-amz-security-token;x-openwork-proof, Signature=${identity.signature}`,
      "x-openwork-aws-date": date,
      "x-openwork-aws-security-token": "fixture-session-token",
      "x-openwork-proof": heartbeatProof(id, createHash("sha256").update(rawBody).digest("hex")),
    },
  }
}

const post = (id: string, request: ReturnType<typeof signedReport>) => den.request(null, "POST", `/v1/managed-deployments/${id}/heartbeat`, request)
const clockStart = () => Math.ceil(Date.now() / 1000) * 1000

test("a deployment's five-minute signed health reports stay accepted for seven hours", async (t) => {
  const id = await deployment()
  const start = clockStart()
  t.mock.timers.enable({ apis: ["Date"], now: start })
  const before = stsRequests
  const statuses: number[] = []
  for (let interval = 0; interval <= 84; interval += 1) {
    const now = start + interval * FIVE_MINUTES
    t.mock.timers.setTime(now)
    const response = await post(id, signedReport(id, now))
    statuses.push(response.status)
    assert.equal(response.status, 200, `report ${interval + 1} after ${interval * 5} minutes: ${summary(response)}; Retry-After=${response.headers.get("retry-after")}`)
  }
  assert.equal(statuses.length, 85)
  assert.equal(stsRequests - before, 85, "every accepted report passed the signed cloud identity adapter")
  assert.deepEqual(den.production?.concurrentStatements ?? [], [])
})

test("the same thirty-per-hour burst quota returns its fixed wait and accepts the exact next-window boundary", async (t) => {
  const id = await deployment()
  const start = clockStart()
  t.mock.timers.enable({ apis: ["Date"], now: start })
  for (let request = 0; request < 30; request += 1) {
    const now = start + request * 1000
    t.mock.timers.setTime(now)
    const response = await post(id, signedReport(id, now))
    assert.equal(response.status, 200, summary(response))
  }
  t.mock.timers.setTime(start + 30_000)
  const blocked = await post(id, signedReport(id, start + 30_000))
  assert.equal(blocked.status, 429, summary(blocked))
  assert.equal(field(blocked.body, "error"), "rate_limited")
  assert.equal(blocked.headers.get("retry-after"), "3570")
  t.mock.timers.setTime(start + HOUR - 1)
  const lastMillisecond = await post(id, signedReport(id, start + HOUR - 1))
  assert.equal(lastMillisecond.status, 429, summary(lastMillisecond))
  assert.equal(lastMillisecond.headers.get("retry-after"), "1")
  t.mock.timers.setTime(start + HOUR)
  const boundary = await post(id, signedReport(id, start + HOUR))
  assert.equal(boundary.status, 200, summary(boundary))
})

test("concurrent signed reports cannot exceed the same thirty-attempt window", async (t) => {
  const id = await deployment()
  const start = clockStart()
  t.mock.timers.enable({ apis: ["Date"], now: start })
  // Freeze the replica after arranging the deployment; every quota claim and
  // replay check must still read its fresh authoritative counter/state.
  await den.production?.freeze()
  const before = stsRequests
  try {
    const responses = await Promise.all(Array.from({ length: 40 }, (_, index) => post(id, signedReport(id, start + index * 1000))))
    assert.equal(responses.filter((response) => response.status === 429).length, 10)
    assert.equal(responses.filter((response) => response.status === 200 || response.status === 409).length, 30)
    assert.equal(stsRequests - before, 30, "only quota-admitted attempts reach identity verification; out-of-order reports remain replay conflicts")
  } finally {
    await den.production?.thaw()
  }
})

test("body binding, cloud identity, freshness and replay rejection still protect heartbeat ingestion", async (t) => {
  const id = await deployment()
  const start = clockStart()
  t.mock.timers.enable({ apis: ["Date"], now: start })
  const first = signedReport(id, start)
  assert.equal((await post(id, first)).status, 200)
  t.mock.timers.setTime(start + 1000)
  const replay = await post(id, first)
  assert.equal(replay.status, 409, summary(replay))
  assert.equal(field(replay.body, "error"), "stale_report")
  const beforeTamper = stsRequests
  const tampered = await post(id, { ...first, rawBody: JSON.stringify({ ...report, version: "1.0.1" }) })
  assert.equal(tampered.status, 401, summary(tampered))
  assert.equal(stsRequests, beforeTamper, "changed body is refused before the signed STS request is replayed")
  const fresh = signedReport(id, start + 1000)
  const invalidSignature = await post(id, { ...fresh, headers: { ...fresh.headers, "x-openwork-aws-authorization": fresh.headers["x-openwork-aws-authorization"].replace(/Signature=.*/, `Signature=${"0".repeat(64)}`) } })
  assert.equal(invalidSignature.status, 401, summary(invalidSignature))
  const identity = identities.get(id)
  assert.ok(identity)
  identities.set(id, { ...identity, arn: `arn:aws:sts::${ACCOUNT}:assumed-role/other-health-role/health-fixture` })
  const wrongRole = await post(id, fresh)
  assert.equal(wrongRole.status, 401, summary(wrongRole))
  identities.set(id, identity)
  const expired = await post(id, signedReport(id, start - 61_000))
  assert.equal(expired.status, 401, summary(expired))
  assert.equal((await post(id, fresh)).status, 200, "a fresh authorized report still succeeds after refused reports")
})
