import assert from "node:assert/strict"
import { test } from "node:test"
import { Hono } from "hono"
import { activationDenUrl, claimActivationReport, hasAnsweredTurn } from "../../../packages/workbot-ui/src/activation.js"
import { createAuth, type AppEnv } from "../src/server/auth.js"
import { createDen, denSessionSchema } from "../src/server/den.js"
import { loadConfig } from "../src/server/config.js"
import { registerWorkbotRoutes } from "../src/server/routes.js"

const PUBLIC = "http://localhost:3090"

function workbot(enabled: boolean) {
  const calls: Array<{ method: string; body?: unknown }> = []
  const config = loadConfig({ WORKBOT_PUBLIC_URL: PUBLIC, WORKBOT_DEN_API_URL: "http://localhost:3091", WORKBOT_DEN_WEB_URL: "https://console.example.test", WORKBOT_RUNNER_URL: "http://localhost:3092", WORKBOT_RUNNER_TOKEN: "r".repeat(32), WORKBOT_SESSION_SECRET: "s".repeat(32) })
  const state = { steps: [{ id: "first_response", done: true }], dismissed: false }
  const den: ReturnType<typeof createDen> = {
    ...createDen({ apiUrl: config.denApiUrl, publicUrl: config.publicUrl }),
    activation: async () => { calls.push({ method: "GET" }); return { status: 200, payload: state } },
    activationEvent: async (_token: string, body: unknown) => { calls.push({ method: "POST", body }); return { status: 200, payload: { ...state, dismissed: true } } },
    connections: async () => [{ id: "fixture-connection", name: "Fixture", app: "gmail", ready: false, connectUrl: "https://old.example.test/", connectMode: "external" }],
  }
  const auth = createAuth({ config, den })
  const app = new Hono<AppEnv>()
  registerWorkbotRoutes(app, { config, den, sameOrigin: auth.sameOrigin, member: async (c, next) => {
    const who = denSessionSchema.parse({ user: { id: "user_example", name: "Example", email: "member@example.test" }, organization: { id: "org_example", name: "Example workspace", brandAppName: null }, memberId: "member_example", enabled, canSchedule: false })
    c.set("member", { session: { id: "session_example", userId: who.user.id, organizationId: who.organization.id, tokens: { accessToken: "fixture-token", expiresAt: Date.now() + 60000 }, createdAt: Date.now() }, accessToken: "fixture-token", den: who })
    await next()
  } })
  const request = (method: "GET" | "POST", path: string, body?: unknown) => app.request(`${PUBLIC}${path}`, { method, headers: { origin: PUBLIC, ...(body ? { "content-type": "application/json" } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) })
  return { calls, request }
}

test("with Workbot off, Workbot never asks Den and the page sees it off", async () => {
  const { calls, request } = workbot(false)
  const me: unknown = await (await request("GET", "/v1/workbot/me")).json()
  assert.ok(typeof me === "object" && me !== null && "activationChecklist" in me && me.activationChecklist === false)
  assert.equal((await request("GET", "/v1/workbot/activation")).status, 404)
  assert.equal((await request("POST", "/v1/workbot/activation/events", { step: "first_response" })).status, 404)
  assert.deepEqual(calls, [])
})

test("with Workbot on, Workbot forwards Den's checklist and only the events it observes", async () => {
  const { calls, request } = workbot(true)
  const me: unknown = await (await request("GET", "/v1/workbot/me")).json()
  assert.ok(typeof me === "object" && me !== null && "activationChecklist" in me && me.activationChecklist === true)
  const read = await request("GET", "/v1/workbot/activation")
  assert.equal(read.status, 200)
  assert.equal(read.headers.get("cache-control"), "no-store")
  assert.deepEqual(await read.json(), { steps: [{ id: "first_response", done: true }], dismissed: false })
  // A browser cannot claim steps Den computes, or ones only Desktop can see.
  for (const step of ["connector", "own_provider", "use_skill"]) assert.equal((await request("POST", "/v1/workbot/activation/events", { step })).status, 400)
  const hidden = await request("POST", "/v1/workbot/activation/events", { step: "dismiss" })
  assert.equal(hidden.status, 200)
  assert.deepEqual(calls, [{ method: "GET" }, { method: "POST", body: { step: "dismiss" } }])
})

test("the header chip waits for a real answer, reports it once and links to the exact Den pages", () => {
  assert.equal(hasAnsweredTurn(undefined), false)
  assert.equal(hasAnsweredTurn([{ greeting: true, status: "done" }]), false, "Workbot's own hello is not an answer")
  assert.equal(hasAnsweredTurn([{ greeting: false, status: "working" }, { greeting: false, status: "failed" }]), false)
  assert.equal(hasAnsweredTurn([{ greeting: true, status: "done" }, { greeting: false, status: "done" }]), true)
  assert.equal(claimActivationReport("org_a:user_a:first_response"), true)
  assert.equal(claimActivationReport("org_a:user_a:first_response"), false)
  assert.equal(claimActivationReport("org_b:user_a:first_response"), true, "another workspace reports its own")
  const destination = { denUrl: "https://den.example.test/", organizationId: "org_example" }
  assert.equal(activationDenUrl(destination, "own_provider"), "https://den.example.test/dashboard/library/model-providers/new?workbotOrganizationId=org_example")
  assert.equal(activationDenUrl(destination, "gateway_provider"), "https://den.example.test/dashboard/ai-gateway?tab=ai-providers&workbotOrganizationId=org_example")
  assert.equal(activationDenUrl(destination, "use_skill"), "https://den.example.test/dashboard/library?show=skills&workbotOrganizationId=org_example")
  assert.equal(activationDenUrl(destination, "invite_teammate"), "https://den.example.test/dashboard/members?workbotOrganizationId=org_example")
})

test("external connection links carry the Workbot workspace on the configured Den domain", async () => {
  const { request } = workbot(true)
  const response = await request("GET", "/v1/workbot/connections")
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), { connections: [{ id: "fixture-connection", name: "Fixture", app: "gmail", ready: false, connectMode: "external", connectUrl: "https://console.example.test/dashboard/your-connections?connectionId=fixture-connection&workbotOrganizationId=org_example" }] })
})

test("activation links strip only trailing slashes in one scan, including long suffixes", () => {
  const expected = "https://den.example.test/base//path/dashboard/members?workbotOrganizationId=org%20example"
  for (const suffix of ["", "/", "///", "/".repeat(100_000)]) {
    assert.equal(activationDenUrl({ denUrl: `https://den.example.test/base//path${suffix}`, organizationId: "org example" }, "invite_teammate"), expected)
  }
})
