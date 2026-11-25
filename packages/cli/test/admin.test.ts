import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { test } from "node:test"
import { DETAILS, harness, type Call, type Reply, type Route } from "./harness.ts"

const TEAMS = [
  { id: "team_1", name: "Platform", memberIds: ["member_1"], managedByScim: false, grantsOrganizationAdmin: false },
  { id: "team_2", name: "Support", memberIds: [], managedByScim: true, grantsOrganizationAdmin: false },
  { id: "team_3", name: "support", memberIds: [], managedByScim: false, grantsOrganizationAdmin: false },
]
const KEYS = [
  { id: "key_1", name: "ci", type: "config", scopes: ["config:export"], areas: null, owner: { email: "owner@acme.test" }, lastRequest: null, expiresAt: "2027-02-22T00:00:00.000Z", createdAt: "2026-11-24T00:00:00.000Z" },
  { id: "key_2", name: "reports", type: "standard", scopes: [], areas: null, owner: { email: "sam@acme.test" }, lastRequest: "2026-11-20T10:00:00.000Z", expiresAt: null, createdAt: "2026-11-01T00:00:00.000Z" },
]

const organization: Route = (call) => {
  if (call.path === "/v1/org") return { body: { ...DETAILS, teams: TEAMS } }
  if (call.path === "/v1/teams" && call.method === "POST") return { status: 201, body: { team: { id: "team_9" } } }
  if (call.path.startsWith("/v1/teams/")) return call.method === "DELETE" ? { status: 204 } : { body: { team: { id: call.path.slice("/v1/teams/".length) } } }
  if (call.path === "/v1/api-keys" && call.method === "GET") return { body: { apiKeys: KEYS } }
  if (call.path === "/v1/api-keys" && call.method === "POST") {
    return { status: 201, body: { apiKey: { id: "key_9", name: "deploy", type: "config", scopes: ["config:export", "config:submit"], areas: ["connectors.*"], expiresAt: "2027-02-22T00:00:00.000Z" }, key: "den_secret_value" } }
  }
  if (call.path.startsWith("/v1/api-keys/") && call.method === "DELETE") return { status: 204 }
  return undefined
}

function setUp(options: { interactive?: boolean; routes?: Route } = {}) {
  const cli = harness({ interactive: options.interactive, env: { OPENWORK_API_KEY: "den_key" }, routes: (call) => options.routes?.(call) ?? organization(call) })
  return { ...cli, lastJson: () => JSON.parse(cli.out.at(-1) ?? "null"), lastError: () => JSON.parse(cli.err.at(-1) ?? "null") }
}

test("teams list names the people in each team", async () => {
  const cli = setUp()
  assert.equal(await cli.run("teams", "list"), 0)
  assert.deepEqual(cli.lastJson().teams[0], { id: "team_1", name: "Platform", members: ["owner@acme.test"], managedByScim: false, grantsOrganizationAdmin: false })
})

test("teams create takes members by email", async () => {
  const cli = setUp()
  assert.equal(await cli.run("teams", "create", "Design", "--members", "sam@acme.test, owner@acme.test"), 0)
  assert.deepEqual(cli.sent("POST", "/v1/teams")[0]?.body, { name: "Design", memberIds: ["member_2", "member_1"] })
  assert.equal(cli.lastJson().id, "team_9")

  assert.equal(await cli.run("teams", "create", "Design", "--members", "nobody@acme.test"), 1)
  assert.equal(cli.lastError().error, "unknown_member")
  assert.equal(cli.sent("POST", "/v1/teams").length, 1)
})

test("teams update adds and removes members from the current list", async () => {
  const cli = setUp()
  assert.equal(await cli.run("teams", "update", "Platform", "--add", "sam@acme.test", "--remove", "owner@acme.test", "--name", "Core"), 0)
  assert.deepEqual(cli.sent("PATCH", "/v1/teams/team_1")[0]?.body, { name: "Core", memberIds: ["member_2"] })

  assert.equal(await cli.run("teams", "update", "team_1", "--name", "Core"), 0)
  assert.deepEqual(cli.sent("PATCH", "/v1/teams/team_1")[1]?.body, { name: "Core" })

  assert.equal(await cli.run("teams", "update", "Platform"), 1)
  assert.equal(cli.lastError().error, "usage")
  assert.equal(await cli.run("teams", "update", "Support", "--name", "Help"), 1)
  assert.equal(cli.lastError().error, "ambiguous_team")
  assert.equal(cli.calls.filter((call) => call.method === "PATCH").length, 2)
})

test("teams delete asks first", async () => {
  const cli = setUp()
  assert.equal(await cli.run("teams", "delete", "Platform"), 1)
  assert.equal(cli.lastError().error, "confirmation_required")
  assert.equal(await cli.run("teams", "delete", "Platform", "--force"), 0)
  assert.equal(cli.sent("DELETE", "/v1/teams/team_1").length, 1)
})

test("api-keys create makes a config token when scopes are named, and prints the key once", async () => {
  const cli = setUp({ interactive: true })
  assert.equal(await cli.run("api-keys", "create", "deploy", "--scopes", "config:export,config:submit", "--areas", "connectors.*"), 0)
  assert.deepEqual(cli.sent("POST", "/v1/api-keys")[0]?.body, { name: "deploy", type: "config", scopes: ["config:export", "config:submit"], areas: ["connectors.*"] })
  assert.equal(cli.out.at(-1), [
    "Created config token deploy (config:export, config:submit), valid until 2027-02-22.",
    "den_secret_value",
    "Store it now: it is not shown again.",
  ].join("\n"))

  assert.equal(await cli.run("api-keys", "create", "reports", "--json"), 0)
  assert.deepEqual(cli.sent("POST", "/v1/api-keys")[1]?.body, { name: "reports" })
  assert.equal(cli.lastJson().key, "den_secret_value")
})

test("api-keys create refuses a config token without scopes before asking the API", async () => {
  const cli = setUp()
  assert.equal(await cli.run("api-keys", "create", "deploy", "--type", "config"), 1)
  assert.equal(cli.lastError().error, "usage")
  assert.equal(await cli.run("api-keys", "create", "deploy", "--type", "admin"), 1)
  assert.equal(cli.sent("POST", "/v1/api-keys").length, 0)
})

test("api-keys list and delete find a key by name", async () => {
  const cli = setUp()
  assert.equal(await cli.run("api-keys", "list"), 0)
  assert.deepEqual(cli.lastJson().apiKeys.map((key: { name: string; owner: string; lastUsedAt: string | null }) => [key.name, key.owner, key.lastUsedAt]), [["ci", "owner@acme.test", null], ["reports", "sam@acme.test", "2026-11-20T10:00:00.000Z"]])
  assert.equal(await cli.run("api-keys", "delete", "reports", "--force"), 0)
  assert.equal(cli.sent("DELETE", "/v1/api-keys/key_2").length, 1)
  assert.equal(await cli.run("api-keys", "delete", "missing", "--force"), 1)
  assert.equal(cli.lastError().error, "unknown_api_key")
})

test("audit list sends the filters and shows the next page", async () => {
  const cli = setUp({
    interactive: true,
    routes: (call) => (call.path === "/v1/audit/operations"
      ? { body: { operations: [{ id: "aop_1", action: "member.role_updated", outcome: "succeeded", origin: "api", initiatingActor: { type: "user", id: "usr_1" }, eventCount: 2, startedAt: "2026-11-24T09:30:00.000Z" }], nextCursor: "next-page", snapshotAt: "2026-11-24T10:00:00.000Z" } }
      : undefined),
  })
  assert.equal(await cli.run("audit", "list", "--from", "2026-11-01", "--action", "member.role_updated", "--actor", "usr_1", "--limit", "10"), 0)
  assert.equal(cli.sent("GET", "/v1/audit/operations")[0]?.query, "?from=2026-11-01&action=member.role_updated&actorId=usr_1&limit=10")
  assert.match(cli.out.at(-1) ?? "", /^STARTED\s+ACTION\s+OUTCOME\s+ORIGIN\s+ACTOR\s+EVENTS\s+ID\n2026-11-24 09:30:00\s+member\.role_updated\s+succeeded\s+api\s+usr_1\s+2\s+aop_1\nMore: add --cursor next-page$/)
})

test("audit export follows every page and keeps one CSV header", async () => {
  const pages = (call: Call): Reply | undefined => {
    if (call.path !== "/v1/audit/export") return undefined
    if (new URLSearchParams(call.query).get("cursor") === "page-2") return { text: '"id","action"\r\n"evt_3","api_key.created"\r\n', headers: { "content-type": "text/csv" } }
    return { text: '"id","action"\r\n"evt_1","member.invited"\r\n"evt_2","member.removed"\r\n', headers: { "content-type": "text/csv", "x-audit-next-cursor": "page-2" } }
  }
  const cli = setUp({ routes: pages })
  const out = join(cli.configDir, "audit.csv")
  assert.equal(await cli.run("audit", "export", "--format", "csv", "--from", "2026-11-01", "--out", out), 0)
  assert.deepEqual(cli.sent("GET", "/v1/audit/export").map((call) => call.query), ["?from=2026-11-01&format=csv&limit=100", "?from=2026-11-01&format=csv&limit=100&cursor=page-2"])
  assert.equal(readFileSync(out, "utf8"), '"id","action"\r\n"evt_1","member.invited"\r\n"evt_2","member.removed"\r\n"evt_3","api_key.created"\r\n')
  assert.deepEqual(cli.lastJson(), { file: out, format: "csv", events: 3 })
})

test("audit export prints NDJSON when no file is named", async () => {
  const cli = setUp({ routes: (call) => (call.path === "/v1/audit/export" ? { text: '{"id":"evt_1"}\n{"id":"evt_2"}\n', headers: { "content-type": "application/x-ndjson" } } : undefined) })
  assert.equal(await cli.run("audit", "export"), 0)
  assert.deepEqual(cli.out, ['{"id":"evt_1"}\n{"id":"evt_2"}'])
  assert.equal(await cli.run("audit", "export", "--format", "xml"), 1)
  assert.equal(cli.lastError().error, "usage")
})

test("an option another command takes is refused, with the command's usage", async () => {
  const cli = setUp()
  assert.equal(await cli.run("teams", "list", "--scopes", "config:export"), 1)
  assert.deepEqual(cli.lastError(), { error: "usage", message: "--scopes is not an option of this command. Usage: openwork teams list" })
  assert.equal(cli.calls.length, 0)
})
