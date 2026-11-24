import assert from "node:assert/strict"
import { readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { test } from "node:test"
import { harness, type Call, type Reply, type Route } from "./harness.ts"

const BLOB = { format: "openwork.config-blob", formatVersion: 1, scope: ["connectors.mcp", "members.teams"], areas: {}, omitted: [{ area: "settings.audit", reason: "missing_permission" }] }
const PLAN = {
  planHash: "sha256:preview",
  mode: "merge",
  summary: { create: 1, update: 1, rename: 0, delete: 0, unchanged: 3, untouched: 0, skip: 0, blocking: 0 },
  areas: [{
    area: "connectors.mcp",
    label: "Connectors",
    items: [
      { ref: "a", op: "create", blob: { name: "Docs" }, flags: [], fields: [{ path: "url", to: "https://docs.test" }] },
      { ref: "b", op: "update", blob: { name: "Linear" }, flags: [], fields: [{ path: "url", from: "https://a.test", to: "https://b.test" }, { path: "teams", added: ["Platform"], removed: ["Sales"] }] },
      { ref: "c", op: "unchanged", blob: { name: "Notion" }, flags: [], fields: [] },
    ],
  }],
  issues: [{ level: "warning", message: "Workbot's model is left as it is." }],
}
const STORED_PLAN = { ...PLAN, planHash: "sha256:stored" }
const BLOCKED_PLAN = {
  ...STORED_PLAN,
  summary: { ...PLAN.summary, blocking: 1 },
  areas: [{ area: "connectors.mcp", label: "Connectors", items: [{ ref: "d", op: "create", blob: { name: "Jira" }, flags: ["needs_input"], reasons: ["Enter the API key."], fields: [] }] }],
}
const UNCHANGED_PLAN = { ...PLAN, summary: { ...PLAN.summary, create: 0, update: 0 }, areas: [], issues: [] }
const REPORT = { status: "applied", counts: { applied: 2, noop: 3, failed: 0, not_reached: 0, skipped: 0 }, failure: null, warnings: [] }
const FAILED_REPORT = {
  status: "failed",
  counts: { applied: 1, noop: 3, failed: 1, not_reached: 0, skipped: 0 },
  failure: { area: "connectors.mcp", ref: "b", name: "Linear", failure: { code: "conflict", message: "The address is already used." } },
  warnings: [],
}

type Setup = { preview?: unknown; stored?: unknown; applyEndsAs?: string; report?: unknown; refuseApply?: Reply; alreadyInReview?: boolean }

function configApi(setup: Setup = {}): Route {
  const upcoming = setup.alreadyInReview ? [] : ["analyzing", "needs_review"]
  let status = setup.alreadyInReview ? "needs_review" : "uploaded"
  const request = () => ({ changeRequest: { id: "ccr_1", status, title: "Rotate", mode: "merge", planHash: null, summary: PLAN.summary, errors: [], approvals: [], createdAt: "2026-11-24T00:00:00.000Z" } })
  return (call: Call) => {
    if (!call.path.startsWith("/v1/config-blobs")) return undefined
    const path = call.path.slice("/v1/config-blobs".length)
    if (path === "/export") return { body: BLOB }
    if (path === "/change-requests" && call.method === "POST" && call.query === "?dryRun=true") return { body: { dryRun: true, plan: setup.preview === undefined ? PLAN : setup.preview, errors: setup.preview === null ? ["Unknown area: connectors.nope"] : [] } }
    if (path === "/change-requests" && call.method === "POST") return { status: 202, body: request() }
    if (path === "/change-requests/ccr_1/plan") return { body: { plan: setup.stored ?? STORED_PLAN, decisions: {} } }
    if (path === "/change-requests/ccr_1/cancel") {
      status = "cancelled"
      return { body: request() }
    }
    if (path === "/change-requests/ccr_1/apply") {
      if (setup.refuseApply) return setup.refuseApply
      upcoming.push("queued", "applying", setup.applyEndsAs ?? "applied")
      return { body: request() }
    }
    if (path === "/change-requests/ccr_1") {
      status = upcoming.shift() ?? status
      return { body: { ...request(), report: status === "applied" || status === "failed" ? setup.report ?? REPORT : null, runs: [] } }
    }
    return undefined
  }
}

function setUp(options: { interactive?: boolean; confirm?: boolean; setup?: Setup; env?: Record<string, string> } = {}) {
  const cli = harness({ interactive: options.interactive, confirm: options.confirm, env: { OPENWORK_API_KEY: "den_config_token", ...options.env }, routes: configApi(options.setup) })
  const file = join(cli.configDir, "org-config.json")
  writeFileSync(file, JSON.stringify(BLOB))
  const uploads = () => cli.sent("POST", "/v1/config-blobs/change-requests").filter((call) => call.query === "")
  return { ...cli, file, uploads, lastJson: () => JSON.parse(cli.out.at(-1) ?? "null"), lastError: () => JSON.parse(cli.err.at(-1) ?? "null") }
}

test("pull saves the chosen areas to a file and says what was left out", async () => {
  const cli = setUp()
  const out = join(cli.configDir, "pulled.json")
  assert.equal(await cli.run("config", "pull", "--areas", "connectors.mcp,members.teams", "--out", out), 0)
  assert.equal(cli.sent("GET", "/v1/config-blobs/export")[0]?.query, "?areas=connectors.mcp%2Cmembers.teams")
  assert.deepEqual(JSON.parse(readFileSync(out, "utf8")), BLOB)
  assert.match(cli.err.join("\n"), /Left out of the file: settings\.audit \(missing_permission\)/)
  assert.deepEqual(cli.lastJson().areas, ["connectors.mcp", "members.teams"])

  assert.equal(await cli.run("config", "pull"), 0)
  assert.deepEqual(cli.lastJson(), BLOB)
})

test("diff shows the plan at a terminal and stores nothing", async () => {
  const cli = setUp({ interactive: true })
  assert.equal(await cli.run("config", "diff", cli.file, "--mode", "mirror"), 0)
  assert.equal(cli.out.at(-1), [
    "Plan (merge): 1 to create, 1 to update (3 unchanged)",
    "Connectors (connectors.mcp)",
    "  + create Docs",
    "  ~ update Linear",
    '      url: "https://a.test" → "https://b.test"',
    '      teams: +"Platform", -"Sales"',
    "warning: Workbot's model is left as it is.",
  ].join("\n"))
  const sent = cli.sent("POST", "/v1/config-blobs/change-requests")
  assert.deepEqual(sent.map((call) => call.query), ["?dryRun=true"])
  assert.deepEqual(sent[0]?.body, { blob: BLOB, mode: "mirror" })
})

test("a file the server cannot import fails with its reasons", async () => {
  const cli = setUp({ setup: { preview: null } })
  assert.equal(await cli.run("config", "diff", cli.file), 1)
  assert.equal(cli.lastError().error, "invalid_config_file")
  assert.match(cli.lastError().message, /Unknown area: connectors\.nope/)
  assert.equal(await cli.run("config", "diff", join(cli.configDir, "missing.json")), 1)
  assert.equal(cli.lastError().error, "file_not_found")
  assert.equal(await cli.run("config", "diff", cli.file, "--mode", "replace"), 1)
  assert.equal(cli.lastError().error, "usage")
})

test("push uploads a change request and waits for its plan", async () => {
  const cli = setUp()
  assert.equal(await cli.run("config", "push", cli.file, "--title", "Rotate"), 0)
  assert.deepEqual(cli.uploads()[0]?.body, { blob: BLOB, mode: "merge", title: "Rotate" })
  assert.deepEqual(cli.lastJson().changeRequest, { id: "ccr_1", status: "needs_review", planHash: "sha256:stored" })
  assert.equal(cli.sent("POST", "/v1/config-blobs/change-requests/ccr_1/apply").length, 0)
})

test("deploy stops before uploading when no one can confirm", async () => {
  const cli = setUp()
  assert.equal(await cli.run("config", "deploy", cli.file), 1)
  assert.equal(cli.lastError().error, "confirmation_required")
  assert.equal(cli.uploads().length, 0)
})

test("deploy applies the uploaded plan and waits until it is applied", async () => {
  const cli = setUp()
  assert.equal(await cli.run("config", "deploy", cli.file, "--force"), 0)
  assert.equal(cli.uploads().length, 1)
  assert.deepEqual(cli.sent("POST", "/v1/config-blobs/change-requests/ccr_1/apply")[0]?.body, { planHash: "sha256:stored" })
  assert.deepEqual(cli.lastJson(), {
    deployed: true,
    changeRequest: { id: "ccr_1", status: "applied" },
    report: { status: "applied", applied: 2, unchanged: 3, failed: 0, notReached: 0, skipped: 0, failure: null, warnings: [] },
  })
})

test("deploy does nothing when the organization already matches the file", async () => {
  const cli = setUp({ setup: { preview: UNCHANGED_PLAN } })
  assert.equal(await cli.run("config", "deploy", cli.file, "--force"), 0)
  assert.equal(cli.lastJson().deployed, false)
  assert.equal(cli.uploads().length, 0)
})

test("deploy leaves a request that needs decisions open and applies nothing", async () => {
  const cli = setUp({ setup: { stored: BLOCKED_PLAN } })
  assert.equal(await cli.run("config", "deploy", cli.file, "--force"), 1)
  assert.equal(cli.lastError().error, "decisions_needed")
  assert.match(cli.lastError().message, /! create Jira\n\s+needs a decision: needs_input; Enter the API key\./)
  assert.match(cli.lastError().message, /openwork config deploy --request ccr_1/)
  assert.equal(cli.sent("POST", "/v1/config-blobs/change-requests/ccr_1/apply").length, 0)
  assert.equal(cli.sent("POST", "/v1/config-blobs/change-requests/ccr_1/cancel").length, 0)
})

test("declining at the terminal withdraws the uploaded request", async () => {
  const cli = setUp({ interactive: true, confirm: false })
  assert.equal(await cli.run("config", "deploy", cli.file), 1)
  assert.equal(cli.err.at(-1), "Error: Aborted. Change request ccr_1 was withdrawn.")
  assert.equal(cli.sent("POST", "/v1/config-blobs/change-requests/ccr_1/cancel").length, 1)
  assert.equal(cli.sent("POST", "/v1/config-blobs/change-requests/ccr_1/apply").length, 0)
})

test("a deploy that fails part-way reports where it stopped", async () => {
  const cli = setUp({ setup: { applyEndsAs: "failed", report: FAILED_REPORT } })
  assert.equal(await cli.run("config", "deploy", cli.file, "--force"), 1)
  assert.equal(cli.lastError().error, "deploy_failed")
  assert.match(cli.lastError().message, /stopped at Linear \(connectors\.mcp\): The address is already used\.\nApplied before it: 1\. Not reached: 0\./)
})

test("deploy --request applies an uploaded request without uploading again", async () => {
  const cli = setUp({ setup: { alreadyInReview: true } })
  assert.equal(await cli.run("config", "deploy", "--request", "ccr_1", "--force"), 0)
  assert.equal(cli.sent("POST", "/v1/config-blobs/change-requests").length, 0)
  assert.equal(cli.lastJson().deployed, true)
})

test("a refused apply keeps the server's reason and the request id", async () => {
  const cli = setUp({ setup: { refuseApply: { status: 409, body: { error: "change_request_not_approved", message: "This change needs another approval.", status: "approved" } } } })
  assert.equal(await cli.run("config", "deploy", cli.file, "--force"), 1)
  assert.equal(cli.lastError().error, "change_request_not_approved")
  assert.match(cli.lastError().message, /^This change needs another approval\. Change request ccr_1 stays open/)
})

test("a standard API key is told it needs a config token", async () => {
  const cli = harness({ env: { OPENWORK_API_KEY: "den_standard" }, routes: (call) => (call.path.startsWith("/v1/config-blobs") ? { status: 403, body: { error: "config_scope_required", scope: "config:export" } } : undefined) })
  assert.equal(await cli.run("config", "pull"), 1)
  assert.match(JSON.parse(cli.err.at(-1) ?? "null").message, /OPENWORK_API_KEY is not a config token with the config:export scope/)
})

test("downloading with an old sign-in signs in again first", async () => {
  const server = configApi()
  const cli = harness({
    interactive: true,
    routes: (call) => (call.path === "/v1/config-blobs/export" && call.headers.get("authorization") === "Bearer session-1"
      ? { status: 403, body: { error: "reauth", reason: "fresh_auth_required", message: "For security, confirm it's you before downloading configuration." } }
      : server(call)),
  })
  await cli.run("auth", "login")
  assert.equal(await cli.run("config", "pull"), 0)
  assert.deepEqual(cli.sent("GET", "/v1/config-blobs/export").map((call) => call.headers.get("authorization")), ["Bearer session-1", "Bearer session-2"])
  assert.deepEqual(JSON.parse(cli.out.at(-1) ?? "null"), BLOB)
})

test("status and requests show an uploaded change request", async () => {
  const requests: Route = (call) => (call.path === "/v1/config-blobs/change-requests" && call.method === "GET"
    ? { body: { changeRequests: [{ id: "ccr_1", status: "needs_review", title: "Rotate", mode: "merge", planHash: "sha256:stored", summary: PLAN.summary, errors: [], approvals: [], createdAt: "2026-11-24T00:00:00.000Z" }] } }
    : undefined)
  const server = configApi()
  const cli = harness({ interactive: true, env: { OPENWORK_API_KEY: "den_config_token" }, routes: (call) => requests(call) ?? server(call) })
  assert.equal(await cli.run("config", "requests"), 0)
  assert.match(cli.out.at(-1) ?? "", /^ID\s+STATUS\s+MODE\s+TITLE\s+CHANGES\s+CREATED\nccr_1\s+needs_review\s+merge\s+Rotate\s+2\s+2026-11-24$/)
  assert.equal(cli.sent("GET", "/v1/config-blobs/change-requests")[0]?.query, "?state=open")
  assert.equal(await cli.run("config", "status", "ccr_1"), 0)
  assert.match(cli.out.at(-1) ?? "", /^Change request ccr_1: analyzing \(Rotate\)\nPlan \(merge\): 1 to create, 1 to update \(3 unchanged\)\nApprovals: 0$/)
})
