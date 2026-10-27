import assert from "node:assert/strict"
import { test } from "node:test"
import { createReadinessController, initialReadiness, probeDeploymentServices, readinessLookup, readinessServiceHosts, readinessServiceOrigin } from "../src/service-readiness.js"

for (const address of ["169.254.169.254", "fe80::1", "fd00:ec2::254", "::ffff:169.254.169.254", "64:ff9b::a9fe:a9fe", "2002:a9fe:a9fe::", "0.0.0.0", "224.0.0.1"]) test(`DNS/socket boundary rejects reserved service destination ${address}`, async () => {
  await assert.rejects(readinessLookup("runner.internal", async () => [{ address, family: address.includes(":") ? 6 : 4 }], new Set(["runner.internal"])))
})
for (const address of ["10.2.3.4", "172.20.0.5", "127.0.0.1", "::1", "fc00::1"]) test(`public service DNS cannot rebind to private ${address}`, async () => {
  await assert.rejects(readinessLookup("runner.example.test", async () => [{ address, family: address.includes(":") ? 6 : 4 }]))
})
test("supported private service DNS and loopback require explicit operator policy; mixed answers fail closed", async () => {
  const policy = readinessServiceHosts({ DEN_HEADLESS_RUNNER_URL: "http://runner:8795", DEN_WORKBOT_URL: "http://localhost:3017" })
  assert.equal((await readinessLookup("runner", async () => [{ address: "10.2.3.4", family: 4 }], policy))[0].address, "10.2.3.4")
  assert.equal((await readinessLookup("localhost", async () => [{ address: "::1", family: 6 }], policy))[0].address, "::1")
  await assert.rejects(readinessLookup("runner", async () => [{ address: "10.2.3.4", family: 4 }]))
  await assert.rejects(readinessLookup("localhost", async () => [{ address: "::1", family: 6 }]))
  await assert.rejects(readinessLookup("runner", async () => [{ address: "8.8.8.8", family: 4 }, { address: "169.254.169.254", family: 4 }], policy))
  await assert.rejects(readinessLookup("runner", async () => [], policy))
})
for (const address of ["10.2.3.4", "172.20.0.5", "192.168.1.5", "fd42::1234"]) test(`private HTTPS corporate FQDN works only when explicitly operator-allowlisted: ${address}`, async () => {
  const policy = readinessServiceHosts({ DEN_HEADLESS_RUNNER_URL: "https://runner.corp.example.test", DEN_WORKBOT_URL: "https://workbot.corp.example.test", GATEWAY_PROXY_BASE_URL: "https://gateway.corp.example.test" })
  const resolve = async () => [{ address, family: address.includes(":") ? 6 : 4 }]
  assert.equal((await readinessLookup("runner.corp.example.test", resolve, policy))[0].address, address)
  await assert.rejects(readinessLookup("runner.corp.example.test", resolve))
  await assert.rejects(readinessLookup("arbitrary.corp.example.test", resolve, policy))
  assert.deepEqual([...policy].sort(), ["gateway.corp.example.test", "runner.corp.example.test", "workbot.corp.example.test"])
})
test("invalid origins and metadata targets never enter or benefit from operator DNS policy", async () => {
  assert.equal(readinessServiceHosts({ DEN_HEADLESS_RUNNER_URL: "https://user:token@runner.corp.example.test", DEN_WORKBOT_URL: "https://workbot.corp.example.test?token=synthetic", GATEWAY_PROXY_BASE_URL: "https://metadata.google.internal" }).size, 0)
  assert.equal(readinessServiceHosts({ GATEWAY_ENABLED: "false", GATEWAY_PROXY_BASE_URL: "https://gateway.corp.example.test" }).size, 0)
  const policy = readinessServiceHosts({ DEN_HEADLESS_RUNNER_URL: "https://runner.corp.example.test" })
  for (const address of ["169.254.169.254", "fd00:ec2::254", "fe80::1", "0.0.0.0", "224.0.0.1"]) await assert.rejects(readinessLookup("runner.corp.example.test", async () => [{ address, family: address.includes(":") ? 6 : 4 }], policy))
})
test("IP literals cannot bypass the transport's DNS protection with IPv6 transition addresses", () => {
  for (const origin of ["https://[2002:a9fe:a9fe::]", "https://[64:ff9b::a9fe:a9fe]", "https://[::ffff:a9fe:a9fe]", "https://0.0.0.0"]) assert.throws(() => readinessServiceOrigin(origin))
})
test("partial resume callback setup does not mint a credential or claim callback success", async () => {
  let fetched = 0
  const facts = await probeDeploymentServices({ env: { DEN_HEADLESS_RUNNER_CALLBACK_TOKEN: "callback-token-not-for-production".repeat(2) }, database: async () => undefined, fetch: async () => { fetched++; throw new Error("not called") } })
  const runner = facts.services.get("headlessRunner")
  assert.equal(runner?.state, "misconfigured")
  assert.ok(!runner?.notes.includes("resume_ready"))
  assert.equal(fetched, 0)
})
test("email checks never reflect provider or SMTP error text and never run without complete settings", async () => {
  const secret = "535 5.7.8 Username and Password not accepted for synthetic-user@example.test"
  let verified = 0
  const facts = await probeDeploymentServices({ env: { SMTP_HOST: "smtp.internal", EMAIL_FROM: "den@example.test", SMTP_USER: "synthetic-user", SMTP_PASS: "synthetic-pass" }, database: async () => undefined, fetch: async () => { throw new Error("not called") },
    verifyEmail: async () => { verified++; throw new Error(secret) } })
  assert.equal(verified, 1)
  assert.ok(!JSON.stringify(facts.services.get("email")).includes("synthetic"))
  const partial = await probeDeploymentServices({ env: { SMTP_HOST: "smtp.internal", SMTP_USER: "synthetic-user" }, database: async () => undefined, fetch: async () => { throw new Error("not called") },
    verifyEmail: async () => { verified++; return { provider: "smtp", outcome: "verified" } } })
  assert.equal(partial.services.get("email")?.state, "misconfigured")
  assert.equal(verified, 1)
})
test("a database timeout is not process health; a late resolve does not flip the failed status", async () => {
  let finish: (() => void) | undefined
  const promise = new Promise<void>((resolve) => { finish = resolve })
  let admissions = 0
  let queries = 0
  const controller = createReadinessController({ admit: async () => { admissions++; return null }, probe: () => probeDeploymentServices({ env: {}, database: () => { queries++; return promise }, timeoutMs: 5, fetch: async () => { throw new Error("not called") } }) })
  await controller.refresh()
  for (let attempt = 0; attempt < 100 && !controller.snapshot().checkedAt; attempt++) await new Promise((resolve) => setTimeout(resolve, 1))
  assert.equal(controller.snapshot().services[0].reason, "timeout")
  assert.equal(controller.snapshot().services[0].lastSuccessAt, null)
  assert.equal(controller.snapshot().checking, true, "timeout publishes failure without discarding the active uncancellable query")
  await controller.refresh()
  assert.equal(admissions, 1)
  assert.equal(queries, 1)
  finish?.()
  await controller.idle()
  assert.equal(controller.snapshot().checking, false)
  assert.equal(controller.snapshot().services[0].state, "unreachable")
})
test("a replica retains the previous replica's last success after a fresh failed probe", async () => {
  const previous = initialReadiness()
  previous.checkedAt = "2026-10-19T00:00:00.000Z"
  previous.services[0] = { ...previous.services[0], configured: true, state: "ready", reason: "database_verified", checkedAt: previous.checkedAt, lastSuccessAt: previous.checkedAt, stale: false }
  const controller = createReadinessController({ now: () => Date.parse("2026-10-19T00:01:00Z"), admit: async () => null, load: async () => previous,
    probe: () => probeDeploymentServices({ env: {}, database: async () => { throw new Error("secret database connection string") }, fetch: async () => { throw new Error("not called") } }),
  })
  await controller.refresh()
  await controller.idle()
  const database = controller.snapshot().services[0]
  assert.equal(database.lastSuccessAt, previous.checkedAt)
  assert.equal(database.checkedAt, "2026-10-19T00:01:00.000Z")
  assert.equal(database.stale, false)
  assert.equal(database.state, "unreachable")
})
