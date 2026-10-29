import assert from "node:assert/strict"
import { test } from "node:test"
import {
  adminGrantFinding,
  automationClientFinding,
  automationClientOf,
  instantAllowanceFinding,
  roundTheClockFinding,
  clientRegistrationFinding,
  deniedSpikeFinding,
  disposableSignupFinding,
  failedSignInFinding,
  networkOf,
  networkSpreadFinding,
  rateLimitedFinding,
  signupNetworkFinding,
  sortFindings,
  spendSpikeFinding,
  unverifiedSignupFinding,
  type NewAccount,
} from "../src/routes/admin/security-findings.js"

const at = new Date(Date.UTC(2026, 9, 20, 12))
const personal = new Set(["gmail.com"])

function accounts(count: number, input: { network?: string | null; email?: (index: number) => string; verified?: boolean }): NewAccount[] {
  return Array.from({ length: count }, (_, index) => ({
    userId: `usr_${input.network ?? "none"}_${index}`,
    email: input.email?.(index) ?? `person${index}@gmail.com`,
    emailVerified: input.verified ?? true,
    createdAt: at,
    network: input.network === undefined ? "203.0.113.0/24" : input.network,
  }))
}

test("groups sign-in addresses into coarse networks", () => {
  assert.equal(networkOf("203.0.113.42"), "203.0.113.0/24")
  assert.equal(networkOf("::ffff:198.51.100.7"), "198.51.100.0/24")
  assert.equal(networkOf("2001:db8:85a3:12::8a2e:370:7334"), "2001:db8:85a3:12::/64")
  assert.equal(networkOf("2001:db8::"), "2001:db8:0:0::/64")
  assert.equal(networkOf("not an address"), null)
  assert.equal(networkOf(null), null)
})

test("flags a network that opened many accounts, and softens a team on one company domain", () => {
  const burst = signupNetworkFinding([
    ...accounts(16, { network: "203.0.113.0/24", verified: false }),
    ...accounts(6, { network: "198.51.100.0/24", email: (index) => `teammate${index}@acme.example` }),
    ...accounts(4, { network: "192.0.2.0/24" }),
  ], personal)
  assert.equal(burst.severity, "high")
  assert.deepEqual(burst.entities.map((entity) => [entity.label, entity.severity, entity.value]), [
    ["203.0.113.0/24", "high", 16],
    ["198.51.100.0/24", "low", 6],
  ])
  assert.match(burst.entities[1]?.detail ?? "", /Mostly verified acme\.example addresses/)
  assert.equal(signupNetworkFinding(accounts(4, {}), personal).severity, "clear")
})

test("raises unverified sign-ups only when the share is high and rising", () => {
  const current = [...accounts(30, { verified: false }), ...accounts(70, {})]
  assert.equal(unverifiedSignupFinding(current, { total: 100, unverified: 2 }).severity, "medium")
  assert.equal(unverifiedSignupFinding(current, { total: 100, unverified: 30 }).severity, "clear")
  assert.equal(unverifiedSignupFinding([...accounts(60, { verified: false }), ...accounts(40, {})], { total: 100, unverified: 60 }).severity, "high")
})

test("lists throwaway inbox sign-ups by domain", () => {
  const result = disposableSignupFinding([
    ...accounts(5, { email: (index) => `x${index}@mailinator.com` }),
    ...accounts(1, { email: () => "y@YOPMAIL.com" }),
    ...accounts(3, {}),
  ])
  assert.equal(result.severity, "medium")
  assert.equal(result.value, 6)
  assert.deepEqual(result.entities.map((entity) => [entity.label, entity.value]), [["mailinator.com", 5], ["yopmail.com", 1]])
})

test("ranks accounts by sign-in networks and links to the person", () => {
  const result = networkSpreadFinding([
    { userId: "usr_a", email: "a@example.com", networks: 31, signIns: 90, clients: 12 },
    { userId: "usr_b", email: "b@example.com", networks: 9, signIns: 20, clients: 2 },
    { userId: "usr_c", email: "c@example.com", networks: 3, signIns: 5, clients: 1 },
  ])
  assert.equal(result.severity, "high")
  assert.deepEqual(result.entities.map((entity) => entity.id), ["usr_a", "usr_b"])
  assert.deepEqual(result.entities[0]?.target, { type: "user", userId: "usr_a" })
})

test("every new platform admin needs review", () => {
  assert.equal(adminGrantFinding([], 4).severity, "clear")
  const result = adminGrantFinding([{ id: "adm_1", email: "new@openwork.example", note: "support rotation", createdAt: at }], 5)
  assert.equal(result.severity, "medium")
  assert.equal(result.entities[0]?.detail, "Added 2026-10-20: support rotation")
})

test("app registrations fire on a wave, not on steady volume", () => {
  assert.equal(clientRegistrationFinding({ current: 900, previous: 800, anonymous: 600, byUser: [] }).severity, "clear")
  assert.equal(clientRegistrationFinding({ current: 450, previous: 200, anonymous: 300, byUser: [] }).severity, "medium")
  assert.equal(clientRegistrationFinding({ current: 3_000, previous: 900, anonymous: 2_500, byUser: [] }).severity, "high")
  assert.equal(clientRegistrationFinding({ current: 100, previous: 100, anonymous: 0, byUser: [{ userId: "usr_a", email: "a@example.com", clients: 60 }] }).severity, "medium")
})

test("spend spikes need both a real amount and real growth", () => {
  const result = spendSpikeFinding([
    { organizationId: "org_new", name: "New", currentMicroUsd: 120_000_000, previousMicroUsd: 0 },
    { organizationId: "org_up", name: "Up", currentMicroUsd: 40_000_000, previousMicroUsd: 10_000_000 },
    { organizationId: "org_steady", name: "Steady", currentMicroUsd: 500_000_000, previousMicroUsd: 400_000_000 },
    { organizationId: "org_small", name: "Small", currentMicroUsd: 5_000_000, previousMicroUsd: 0 },
  ])
  assert.deepEqual(result.entities.map((entity) => [entity.id, entity.severity]), [["org_new", "high"], ["org_up", "medium"]])
  assert.equal(result.entities[1]?.detail, "$40.00, up from $10.00 (4×)")
  assert.deepEqual(result.entities[0]?.target, { type: "organization", organizationId: "org_new" })
})

test("a burst of failed sign-ins against a quiet day is high", () => {
  const quiet = Array.from({ length: 24 }, () => 2)
  assert.equal(failedSignInFinding(quiet).severity, "clear")
  assert.equal(failedSignInFinding([...quiet.slice(0, 23), 150]).severity, "high")
  assert.equal(failedSignInFinding([...quiet.slice(0, 23), 40]).severity, "medium")
})

test("steady pollers with dead credentials do not fire; a new refusal burst does", () => {
  const steady = Array.from({ length: 24 }, () => 15_000)
  const burst = [...Array.from({ length: 23 }, () => 10), 600]
  const result = deniedSpikeFinding(new Map([["automation_runner.work.poll.attempted", steady], ["organization.read.attempted", burst]]))
  assert.equal(result.severity, "medium")
  assert.deepEqual(result.entities.map((entity) => entity.id), ["organization.read.attempted"])
})

test("rate limiting is judged across all endpoints together", () => {
  const quiet = new Map([["auth.oauth.token.issue.attempted", Array.from({ length: 24 }, () => 8)]])
  const quietResult = rateLimitedFinding(quiet)
  assert.equal(quietResult.severity, "clear")
  assert.equal(quietResult.entities[0]?.severity, "clear")
  const burst = new Map([
    ["auth.oauth.token.issue.attempted", [...Array.from({ length: 23 }, () => 8), 300]],
    ["oauth_client.register.attempted", Array.from({ length: 24 }, () => 1)],
  ])
  const burstResult = rateLimitedFinding(burst)
  assert.equal(burstResult.severity, "high")
  assert.deepEqual(burstResult.entities.map((entity) => entity.id), ["auth.oauth.token.issue.attempted", "oauth_client.register.attempted"])
})

test("findings sort from high to clear", () => {
  const findings = sortFindings([
    adminGrantFinding([], 1),
    failedSignInFinding([...Array.from({ length: 23 }, () => 1), 200]),
    adminGrantFinding([{ id: "adm_1", email: "a@example.com", note: null, createdAt: at }], 2),
  ])
  assert.deepEqual(findings.map((item) => item.severity), ["high", "medium", "clear"])
})

test("recognizes automation clients but not browsers or mobile apps", () => {
  assert.equal(automationClientOf("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/131.0.0.0 Safari/537.36"), "Headless Chrome")
  assert.equal(automationClientOf("python-requests/2.32.3"), "Python script")
  assert.equal(automationClientOf("curl/8.7.1"), "curl or Wget")
  assert.equal(automationClientOf("Go-http-client/2.0"), "Go program")
  assert.equal(automationClientOf("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"), null)
  assert.equal(automationClientOf("okhttp/4.12.0"), null)
  assert.equal(automationClientOf(null), null)
})

test("automation sign-ins are medium on a new account and high when repeated", () => {
  const result = automationClientFinding([
    { userId: "usr_new", email: "new@example.com", client: "Playwright", signIns: 1, newAccount: true },
    { userId: "usr_old", email: "old@example.com", client: "curl or Wget", signIns: 1, newAccount: false },
    { userId: "usr_farm", email: "farm@example.com", client: "Python script", signIns: 15, newAccount: false },
    { userId: "usr_farm", email: "farm@example.com", client: "Headless Chrome", signIns: 6, newAccount: false },
  ])
  assert.deepEqual(result.entities.map((entity) => [entity.id, entity.severity, entity.value]), [["usr_farm", "high", 21], ["usr_new", "medium", 1], ["usr_old", "low", 1]])
  assert.equal(result.entities[0]?.detail, "Python script, Headless Chrome")
})

test("model use with no break for sleep is flagged, softened for automation owners", () => {
  const result = roundTheClockFinding([
    { userId: "usr_bot", email: "bot@example.com", organization: "Farm", days: [24, 23, 22, 21, 6], automations: 0 },
    { userId: "usr_owner", email: "owner@example.com", organization: "Ops", days: [24, 24, 24], automations: 2 },
    { userId: "usr_person", email: "person@example.com", organization: "Studio", days: [9, 12, 19], automations: 0 },
  ])
  assert.deepEqual(result.entities.map((entity) => [entity.id, entity.severity, entity.value]), [["usr_bot", "high", 4], ["usr_owner", "low", 3]])
  assert.match(result.entities[1]?.detail ?? "", /Owns 2 active automations/)
})

test("lists new accounts that used the weekly free allowance in a day", () => {
  const result = instantAllowanceFinding([{ userId: "usr_a", email: "a@example.com", createdAt: at, firstDayMicroUsd: 4_800_000 }], 5_000_000)
  assert.equal(result.severity, "medium")
  assert.equal(result.entities[0]?.detail, "$4.80 in the first day, signed up 2026-10-20")
  assert.equal(instantAllowanceFinding([], 5_000_000).severity, "clear")
})
