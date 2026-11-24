import assert from "node:assert/strict"
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import type { Io } from "../src/io.ts"
import { main } from "../src/main.ts"

type Call = { method: string; path: string; headers: Headers; body: unknown }
type Reply = { status?: number; body?: unknown }
type Route = (call: Call) => Reply | undefined

const ORG = { id: "organization_1", name: "Acme", slug: "acme", role: "owner", planTier: "team", memberCount: 2, isActive: true }
const BETA = { ...ORG, id: "organization_2", name: "Beta", slug: "beta", isActive: false }
const DETAILS = {
  organization: { id: ORG.id, name: "Acme", slug: "acme", owner: { email: "owner@acme.test" } },
  currentMember: { role: "owner", permissions: ["members.update"] },
  members: [
    { id: "member_1", role: "owner", effectiveRole: "owner", isOwner: true, joinedAt: "2026-01-02T00:00:00.000Z", user: { id: "user_1", email: "owner@acme.test", name: "Owner" } },
    { id: "member_2", role: "member", effectiveRole: "member", isOwner: false, joinedAt: "2026-02-03T00:00:00.000Z", user: { id: "user_2", email: "sam@acme.test", name: "Sam" } },
  ],
  invitations: [{ id: "invitation_1", email: "new@acme.test", role: "member", status: "pending", expiresAt: "2026-12-01T00:00:00.000Z", createdAt: "2026-11-24T00:00:00.000Z" }],
  teams: [],
}

/** A stand-in for the API: device sign-in, the reads every command uses, and per-test routes first. */
function harness(options: { interactive?: boolean; env?: Record<string, string>; routes?: Route; confirm?: boolean } = {}) {
  const calls: Call[] = []
  const out: string[] = []
  const err: string[] = []
  let signIns = 0
  const io: Io = {
    env: { OPENWORK_CONFIG_DIR: mkdtempSync(join(tmpdir(), "openwork-cli-")), OPENWORK_API_URL: "https://den.test", ...options.env },
    homeDir: "/nonexistent",
    interactive: options.interactive ?? false,
    out: (text) => out.push(text),
    err: (text) => err.push(text),
    confirm: async () => options.confirm ?? false,
    sleep: async () => {},
    fetch: (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input))
      const call: Call = { method: init?.method ?? "GET", path: url.pathname, headers: new Headers(init?.headers), body: init?.body ? JSON.parse(String(init.body)) : undefined }
      calls.push(call)
      const reply = options.routes?.(call) ?? builtIn(call)
      return new Response(reply.body === undefined ? null : JSON.stringify(reply.body), { status: reply.status ?? 200 })
    }) as typeof fetch,
  }
  function builtIn(call: Call): Reply {
    if (call.path === "/api/auth/device/code") return { body: { device_code: "device", user_code: "ABCDEFGH", verification_uri_complete: "https://den.test/device?user_code=ABCDEFGH", interval: 1, expires_in: 900 } }
    if (call.path === "/api/auth/device/token") return { body: { access_token: `session-${++signIns}`, expires_in: 604800 } }
    if (call.path === "/api/auth/sign-out") return { body: {} }
    if (call.path === "/v1/me") return { body: { user: { id: "user_1", email: "owner@acme.test", name: "Owner" } } }
    if (call.path === "/v1/me/orgs") {
      // Like the API: a request that names an organization lists only that one.
      const named = call.headers.get("x-openwork-org-id")
      const orgs = [ORG, BETA].filter((org) => !named || org.id === named)
      return { body: { orgs, activeOrgId: named ?? ORG.id, activeOrgSlug: orgs[0]?.slug ?? null } }
    }
    if (call.path === "/v1/org") return { body: DETAILS }
    return { status: 404, body: { error: "not_found" } }
  }
  const run = (...argv: string[]) => main(argv, io)
  const sent = (method: string, path: string) => calls.filter((call) => call.method === method && call.path === path)
  return { io, calls, out, err, run, sent, profilesPath: join(io.env.OPENWORK_CONFIG_DIR as string, "profiles.json") }
}

test("signing in saves an owner-only profile and never prints the token", async () => {
  const cli = harness()
  assert.equal(await cli.run("auth", "login"), 0)
  assert.equal(statSync(cli.profilesPath).mode & 0o777, 0o600)
  const store = JSON.parse(readFileSync(cli.profilesPath, "utf8"))
  assert.equal(store.active, "default")
  assert.equal(store.profiles.default.accessToken, "session-1")
  assert.equal(store.profiles.default.orgId, ORG.id)
  assert.doesNotMatch(cli.out.join("\n") + cli.err.join("\n"), /session-1/)
  assert.match(cli.err.join("\n"), /ABCD-EFGH/)

  assert.equal(await cli.run("auth", "whoami"), 0)
  const who = JSON.parse(cli.out.at(-1) as string)
  assert.deepEqual([who.user.email, who.organization.slug, who.profile], ["owner@acme.test", "acme", "default"])
  const read = cli.sent("GET", "/v1/me").at(-1) as Call
  assert.equal(read.headers.get("authorization"), "Bearer session-1")
  assert.equal(read.headers.get("x-openwork-org-id"), ORG.id)
})

test("a second sign-in is skipped unless forced, and sign-out deletes the profile", async () => {
  const cli = harness()
  await cli.run("auth", "login")
  assert.equal(await cli.run("auth", "login"), 0)
  assert.equal(cli.sent("POST", "/api/auth/device/code").length, 1)
  assert.equal(await cli.run("auth", "login", "--force"), 0)
  assert.equal(cli.sent("POST", "/api/auth/device/code").length, 2)

  assert.equal(await cli.run("auth", "logout"), 0)
  assert.equal(cli.sent("POST", "/api/auth/sign-out")[0]?.headers.get("authorization"), "Bearer session-2")
  assert.deepEqual(JSON.parse(readFileSync(cli.profilesPath, "utf8")), { active: null, profiles: {} })
  assert.equal(await cli.run("members", "list"), 1)
  assert.equal(JSON.parse(cli.err.at(-1) as string).error, "not_signed_in")
})

test("an API key from the environment wins over profiles and cannot manage them", async () => {
  const cli = harness({ env: { OPENWORK_API_KEY: "den_key", OPENWORK_ORG_ID: "organization_2" } })
  assert.equal(await cli.run("members", "list"), 0)
  const read = cli.sent("GET", "/v1/org")[0] as Call
  assert.equal(read.headers.get("x-api-key"), "den_key")
  assert.equal(read.headers.get("authorization"), null)
  assert.equal(read.headers.get("x-openwork-org-id"), "organization_2")
  assert.deepEqual(JSON.parse(cli.out[0] as string).members.map((member: { email: string }) => member.email), ["owner@acme.test", "sam@acme.test"])

  assert.equal(await cli.run("auth", "login"), 1)
  assert.equal(JSON.parse(cli.err.at(-1) as string).error, "environment_credential")
  assert.equal(cli.sent("POST", "/api/auth/device/code").length, 0)
})

test("org use changes the organization later commands act on", async () => {
  const cli = harness()
  await cli.run("auth", "login")
  assert.equal(await cli.run("org", "use", "beta"), 0)
  await cli.run("org", "get")
  assert.equal(cli.sent("GET", "/v1/org").at(-1)?.headers.get("x-openwork-org-id"), "organization_2")
  assert.equal(await cli.run("org", "use", "nope"), 1)
  assert.equal(JSON.parse(cli.err.at(-1) as string).error, "unknown_organization")
})

test("removing a member needs --force when no one is at the terminal", async () => {
  const cli = harness({ env: { OPENWORK_API_KEY: "den_key" }, routes: (call) => (call.method === "DELETE" ? { status: 204 } : undefined) })
  assert.equal(await cli.run("members", "remove", "sam@acme.test"), 1)
  assert.equal(JSON.parse(cli.err.at(-1) as string).error, "confirmation_required")
  assert.equal(cli.sent("DELETE", "/v1/members/member_2").length, 0)

  assert.equal(await cli.run("members", "remove", "sam@acme.test", "--dry-run"), 0)
  assert.deepEqual(JSON.parse(cli.out.at(-1) as string), { dryRun: true, request: { method: "DELETE", path: "/v1/members/member_2" } })
  assert.equal(cli.sent("DELETE", "/v1/members/member_2").length, 0)

  assert.equal(await cli.run("members", "remove", "sam@acme.test", "--force"), 0)
  assert.equal(cli.sent("DELETE", "/v1/members/member_2").length, 1)
})

test("a declined confirmation at the terminal changes nothing", async () => {
  const cli = harness({ interactive: true, confirm: false })
  await cli.run("auth", "login")
  assert.equal(await cli.run("invitations", "cancel", "new@acme.test"), 1)
  assert.equal(cli.sent("POST", "/v1/invitations/invitation_1/cancel").length, 0)
})

test("a change that needs a recent sign-in signs in again and retries once", async () => {
  const stale: Route = (call) => {
    if (call.path !== "/v1/members/member_2/role") return undefined
    return call.headers.get("authorization") === "Bearer session-1"
      ? { status: 403, body: { error: "reauth", reason: "fresh_auth_required", message: "For security, confirm it's you before changing workspace settings." } }
      : { body: { success: true } }
  }
  const cli = harness({ interactive: true, routes: stale })
  await cli.run("auth", "login")
  await cli.run("org", "use", "beta")
  assert.equal(await cli.run("members", "set-role", "sam@acme.test", "--role", "admin"), 0)
  const attempts = cli.sent("POST", "/v1/members/member_2/role")
  assert.deepEqual(attempts.map((call) => call.headers.get("authorization")), ["Bearer session-1", "Bearer session-2"])
  assert.deepEqual(attempts[1]?.body, { role: "admin" })
  // Signing in again keeps the organization the profile was using.
  assert.equal(attempts[1]?.headers.get("x-openwork-org-id"), "organization_2")
  assert.equal(JSON.parse(readFileSync(cli.profilesPath, "utf8")).profiles.default.orgId, "organization_2")
})

test("without a terminal, a change that needs a recent sign-in says what to run", async () => {
  const cli = harness({ routes: (call) => (call.path === "/v1/members/member_2/role" ? { status: 403, body: { error: "reauth", reason: "fresh_auth_required" } } : undefined) })
  await cli.run("auth", "login")
  assert.equal(await cli.run("members", "set-role", "member_2", "--role", "admin"), 1)
  assert.equal(JSON.parse(cli.err.at(-1) as string).error, "recent_sign_in_required")
  assert.equal(cli.sent("POST", "/api/auth/device/code").length, 1)
})

test("inviting someone does not print the join token", async () => {
  const cli = harness({
    env: { OPENWORK_API_KEY: "den_key" },
    routes: (call) => (call.method === "POST" && call.path === "/v1/invitations"
      ? { status: 201, body: { invitationId: "invitation_2", email: "kim@acme.test", role: "admin", expiresAt: "2026-12-01T00:00:00.000Z", inviteToken: "join-secret", memberId: null } }
      : undefined),
  })
  assert.equal(await cli.run("invitations", "create", "kim@acme.test", "--role", "admin"), 0)
  assert.deepEqual(cli.sent("POST", "/v1/invitations")[0]?.body, { email: "kim@acme.test", role: "admin" })
  assert.doesNotMatch(cli.out.join("\n"), /join-secret/)
  assert.equal(JSON.parse(cli.out[0] as string).invitationId, "invitation_2")
})

test("an API error keeps its code and message, and an unknown flag is a usage error", async () => {
  const cli = harness({ env: { OPENWORK_API_KEY: "den_key" }, routes: (call) => (call.path === "/v1/org" ? { status: 403, body: { error: "forbidden", message: "You need the View members permission." } } : undefined) })
  assert.equal(await cli.run("members", "list"), 1)
  assert.deepEqual(JSON.parse(cli.err.at(-1) as string), { error: "forbidden", message: "You need the View members permission.", details: { error: "forbidden", message: "You need the View members permission." } })
  assert.equal(await cli.run("members", "list", "--yes"), 1)
  assert.equal(JSON.parse(cli.err.at(-1) as string).error, "usage")
  assert.equal(await cli.run("members", "purge"), 1)
})

test("a person at a terminal gets a table", async () => {
  const cli = harness({ interactive: true })
  await cli.run("auth", "login")
  assert.equal(await cli.run("members", "list"), 0)
  assert.match(cli.out.at(-1) as string, /^ID\s+EMAIL\s+NAME\s+ROLE\s+JOINED\nmember_1\s+owner@acme\.test\s+Owner\s+owner\s+2026-01-02\n/)
})

test("org list shows every organization and marks the one in use", async () => {
  const cli = harness()
  await cli.run("auth", "login")
  await cli.run("org", "use", "beta")
  assert.equal(await cli.run("org", "list"), 0)
  const listed = JSON.parse(cli.out.at(-1) as string).organizations
  assert.deepEqual(listed.map((org: { slug: string; current: boolean }) => [org.slug, org.current]), [["acme", false], ["beta", true]])
})

test("--org takes an id or a slug, and an unknown one stops the command before any change", async () => {
  const cli = harness({ routes: (call) => (call.method === "DELETE" ? { status: 204 } : undefined) })
  await cli.run("auth", "login")
  assert.equal(await cli.run("members", "list", "--org", "beta"), 0)
  assert.equal(cli.sent("GET", "/v1/org").at(-1)?.headers.get("x-openwork-org-id"), "organization_2")

  assert.equal(await cli.run("members", "remove", "sam@acme.test", "--org", "betta", "--force"), 1)
  assert.equal(JSON.parse(cli.err.at(-1) as string).error, "unknown_organization")
  assert.equal(cli.calls.filter((call) => call.method === "DELETE").length, 0)
})

test("a sign-in from openwork-bootstrap is used when there is no profile", async () => {
  const cli = harness()
  writeFileSync(join(cli.io.env.OPENWORK_CONFIG_DIR as string, "credentials.json"), JSON.stringify({
    baseUrl: "https://den.test/",
    accessToken: "bootstrap-session",
    expiresAt: null,
    user: { id: "user_1", email: "owner@acme.test" },
  }))
  assert.equal(await cli.run("auth", "whoami"), 0)
  assert.equal(cli.sent("GET", "/v1/me")[0]?.headers.get("authorization"), "Bearer bootstrap-session")
  assert.equal(JSON.parse(cli.out.at(-1) as string).credential, "openwork-bootstrap")
})

test("signing in again as someone else leaves the profile alone", async () => {
  const cli = harness({
    interactive: true,
    routes: (call) => {
      const second = call.headers.get("authorization") === "Bearer session-2"
      if (call.path === "/v1/me" && second) return { body: { user: { id: "user_9", email: "other@acme.test" } } }
      if (call.path === "/v1/members/member_2/role") return { status: 403, body: { error: "reauth", reason: "fresh_auth_required" } }
      return undefined
    },
  })
  await cli.run("auth", "login")
  assert.equal(await cli.run("members", "set-role", "sam@acme.test", "--role", "admin"), 1)
  assert.match(cli.err.at(-1) as string, /You signed in as other@acme\.test, but profile "default" belongs to owner@acme\.test/)
  assert.equal(cli.sent("POST", "/v1/members/member_2/role").length, 1)
  assert.equal(cli.sent("POST", "/api/auth/sign-out")[0]?.headers.get("authorization"), "Bearer session-2")
  assert.equal(JSON.parse(readFileSync(cli.profilesPath, "utf8")).profiles.default.accessToken, "session-1")
})

test("a rejected request shows which fields were wrong, and where to start billing", async () => {
  const cli = harness({
    interactive: true,
    routes: (call) => {
      if (call.method !== "POST" || call.path !== "/v1/invitations") return undefined
      return call.headers.get("authorization") === "Bearer session-1" && (call.body as { email: string }).email === "nope"
        ? { status: 400, body: { error: "invalid_request", details: [{ message: "Invalid email address", path: ["email"] }] } }
        : { status: 402, body: { error: "payment_required", message: "This workspace has used its free users.", billingUrl: "https://den.test/billing" } }
    },
  })
  await cli.run("auth", "login")
  assert.equal(await cli.run("invitations", "create", "nope"), 1)
  assert.equal(cli.err.at(-1), "Error: The request was not valid.\nemail: Invalid email address")
  assert.equal(await cli.run("invitations", "create", "kim@acme.test"), 1)
  assert.equal(cli.err.at(-1), "Error: This workspace has used its free users.\nStart billing: https://den.test/billing")
})

test("help lists the commands of one group", async () => {
  const cli = harness()
  assert.equal(await cli.run("help", "members"), 0)
  assert.match(cli.out[0] as string, /openwork members set-role/)
  assert.doesNotMatch(cli.out[0] as string, /openwork auth login/)
})
