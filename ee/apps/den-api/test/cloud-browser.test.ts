import { Client, InMemoryTransport } from "@modelcontextprotocol/client"
import { McpServer } from "@modelcontextprotocol/server"
import { CloudBrowserError, CLOUD_BROWSER_INSTRUCTION, type BrowserKey } from "@openwork-ee/cloud-browser"
import { createFakeCloudBrowser, type FakeCloudBrowser } from "@openwork-ee/cloud-browser/testing"
import { createDenTypeId } from "@openwork-ee/utils/typeid"
import { beforeAll, describe, expect, test } from "bun:test"
import { Hono, type MiddlewareHandler } from "hono"
import { generateSpecs } from "hono-openapi"
import type { OrganizationContext } from "../src/orgs.js"
import type { OrgRouteVariables } from "../src/routes/org/shared.js"

function seedRequiredEnv() {
  process.env.DATABASE_URL = process.env.DATABASE_URL ?? "mysql://root:password@127.0.0.1:3306/openwork_test"
  process.env.DEN_DB_ENCRYPTION_KEY = process.env.DEN_DB_ENCRYPTION_KEY ?? "x".repeat(32)
  process.env.BETTER_AUTH_SECRET = process.env.BETTER_AUTH_SECRET ?? "y".repeat(32)
  process.env.BETTER_AUTH_URL = process.env.BETTER_AUTH_URL ?? "http://127.0.0.1:8790"
  process.env.CORS_ORIGINS = process.env.CORS_ORIGINS ?? "http://127.0.0.1:8790"
}

let tools: typeof import("../src/cloud-browser/mcp-tools.js")
let routes: typeof import("../src/cloud-browser/routes.js")
let policy: typeof import("../src/mcp/policy.js")

beforeAll(async () => {
  seedRequiredEnv()
  ;[tools, routes, policy] = await Promise.all([
    import("../src/cloud-browser/mcp-tools.js"),
    import("../src/cloud-browser/routes.js"),
    import("../src/mcp/policy.js"),
  ])
})

const member: BrowserKey = { organizationId: "org_cloud_browser", memberId: "om_cloud_browser" }
const BROWSER_URL = "https://app.openwork.example/browser"

type ToolResult = { isError?: boolean; content: Array<{ type: string; text?: string; data?: string; mimeType?: string }> }

function isToolResult(value: unknown): value is ToolResult {
  return typeof value === "object" && value !== null && "content" in value && Array.isArray(value.content)
}

function payloadOf(result: ToolResult): Record<string, unknown> {
  const text = result.content.find((part) => part.type === "text")?.text ?? "{}"
  const parsed: unknown = JSON.parse(text)
  return typeof parsed === "object" && parsed !== null ? Object.fromEntries(Object.entries(parsed)) : {}
}

async function withTools<T>(browser: FakeCloudBrowser, run: (call: (name: string, args: Record<string, unknown>) => Promise<ToolResult>, client: Client) => Promise<T>) {
  const server = new McpServer({ name: "cloud-browser-test", version: "1.0.0" })
  tools.registerCloudBrowserTools({ server, browser, key: member, browserUrl: (site) => (site ? `${BROWSER_URL}?site=${site}` : BROWSER_URL) })
  const client = new Client({ name: "headless-runner-test", version: "1.0.0" })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  await client.connect(clientTransport)
  try {
    return await run(async (name, args) => {
      const result: unknown = await client.callTool({ name, arguments: args })
      if (!isToolResult(result)) throw new Error("unexpected tool result")
      return result
    }, client)
  } finally {
    await client.close()
    await server.close()
  }
}

describe("who gets the cloud browser tools", () => {
  test("only headless runs, in organizations with the capability, on a configured deployment", () => {
    const base = { headlessRun: true, capabilityEnabled: true, configured: true, memberId: "om_1" }
    expect(tools.cloudBrowserToolsAvailable(base)).toBe(true)
    // Desktop, Claude, Cursor and other MCP clients keep their own browser tools.
    expect(tools.cloudBrowserToolsAvailable({ ...base, headlessRun: false })).toBe(false)
    expect(tools.cloudBrowserToolsAvailable({ ...base, capabilityEnabled: false })).toBe(false)
    expect(tools.cloudBrowserToolsAvailable({ ...base, configured: false })).toBe(false)
    expect(tools.cloudBrowserToolsAvailable({ ...base, memberId: null })).toBe(false)
  })

  test("the model instructions are added only when the tools are", () => {
    expect(tools.withCloudBrowserInstructions("Agent rules.", false)).toBe("Agent rules.")
    const headless = tools.withCloudBrowserInstructions("Agent rules.", true)
    expect(headless).toBe(`Agent rules.\n${CLOUD_BROWSER_INSTRUCTION}`)
    expect(headless).toContain("call browser_handoff and end your turn")
    expect(headless).toContain("Never ask for passwords, codes or cookies in chat")
  })
})

describe("cloud browser tools", () => {
  test("registers the desktop tool names", async () => {
    await withTools(createFakeCloudBrowser(), async (_call, client) => {
      const listed = await client.listTools()
      expect(listed.tools.map((tool) => tool.name).sort()).toEqual([...tools.CLOUD_BROWSER_TOOL_NAMES].sort())
    })
  })

  test("open, observe with a screenshot block, act and navigate", async () => {
    const browser = createFakeCloudBrowser()
    await withTools(browser, async (call) => {
      const opened = await call("browser_open", { url: "https://app.example.com/inbox" })
      expect(opened.isError).toBeFalsy()
      expect(payloadOf(opened)).toMatchObject({ ok: true, url: "https://app.example.com/inbox", next: "observe" })

      const observed = await call("browser_observe", {})
      const observation = payloadOf(observed)
      expect(observation).toMatchObject({ ok: true, trust: "untrusted-site-content", hasPasswordField: false })
      expect(observation.image).toBeUndefined()
      const image = observed.content.find((part) => part.type === "image")
      expect(image?.mimeType).toBe("image/jpeg")
      expect(Buffer.from(image?.data ?? "", "base64").subarray(0, 2).toString("hex")).toBe("ffd8")

      const textOnly = await call("browser_observe", { includeImage: false })
      expect(textOnly.content.some((part) => part.type === "image")).toBe(false)

      const acted = await call("browser_act", { observationId: String(observation.observationId), action: { type: "click", ref: "e1" } })
      expect(payloadOf(acted)).toMatchObject({ ok: true, dispatched: true, outcome: "not_yet_verified", retrySafe: false })

      const navigated = await call("browser_navigate", { url: "https://app.example.com/settings" })
      expect(payloadOf(navigated)).toMatchObject({ ok: true, url: "https://app.example.com/settings" })
    })
    expect(browser.calls.map((call) => call.method)).toEqual(["open", "observe", "observe", "act", "navigate"])
    expect(browser.calls.every((call) => call.key === member)).toBe(true)
  })

  test("sign-in pages withhold the screenshot and password fields are refused with a hand-off", async () => {
    const browser = createFakeCloudBrowser()
    await withTools(browser, async (call) => {
      await call("browser_open", { url: "https://app.example.com/login" })
      browser.setSignInPage(member, true)
      const observed = await call("browser_observe", {})
      expect(observed.content.some((part) => part.type === "image")).toBe(false)
      expect(payloadOf(observed)).toMatchObject({ hasPasswordField: true, imageOmitted: "sign_in_page", next: "handoff" })

      const refused = await call("browser_act", { observationId: String(payloadOf(observed).observationId), action: { type: "fill", ref: "e2", text: "hunter2" } })
      expect(refused.isError).toBe(true)
      expect(payloadOf(refused)).toMatchObject({ ok: false, code: "sign_in_required", next: "handoff", dispatched: false, retrySafe: false })
    })
  })

  test("hand-off ends the turn and points the person at their live view, never asking for credentials", async () => {
    const browser = createFakeCloudBrowser()
    await withTools(browser, async (call) => {
      await call("browser_open", { url: "https://app.example.com/login" })
      const handoff = payloadOf(await call("browser_handoff", { reason: "sign_in" }))
      expect(handoff).toMatchObject({ ok: true, status: "waiting_for_person", next: "end_turn", browserUrl: `${BROWSER_URL}?site=app.example.com` })
      expect(String(handoff.message)).toContain("app.example.com needs you to sign in.")
      expect(String(handoff.message)).toContain("Take over")
      expect(String(handoff.message)).toContain("Your password goes to the site, not to me.")
      expect(String(handoff.instructions)).toContain("Do not ask for passwords")

      const named = payloadOf(await call("browser_handoff", { reason: "captcha", site: "Example Mail" }))
      expect(String(named.message)).toContain("Example Mail wants to check you're a person.")
    })
  })

  test("a hand-off with nothing open opens the named site, so the person lands on it", async () => {
    const browser = createFakeCloudBrowser()
    await withTools(browser, async (call) => {
      const handoff = payloadOf(await call("browser_handoff", { reason: "sign_in", site: "github.com" }))
      expect(handoff).toMatchObject({ ok: true, status: "waiting_for_person", browserUrl: `${BROWSER_URL}?site=github.com` })
      expect(browser.calls.filter((entry) => entry.method === "open").map((entry) => entry.input)).toEqual([{ url: "https://github.com/" }])
    })
    expect(tools.siteAddress("Example Mail")).toBeNull()
    expect(tools.siteAddress("https://app.example.com/login")).toBe("https://app.example.com/login")
  })

  test("failures are structured, with a next step and no retry", async () => {
    const browser = createFakeCloudBrowser()
    await withTools(browser, async (call) => {
      const blocked = await call("browser_open", { url: "http://169.254.169.254/latest/meta-data/" })
      expect(payloadOf(blocked)).toMatchObject({ ok: false, code: "blocked_url", next: "fix_request" })
      const invalid = await call("browser_open", { url: "file:///etc/passwd" })
      expect(payloadOf(invalid)).toMatchObject({ ok: false, code: "invalid_url" })
      const notRunning = await call("browser_observe", {})
      expect(payloadOf(notRunning)).toMatchObject({ ok: false, code: "not_running", next: "open" })
      browser.failNext("act", new CloudBrowserError("timeout", "slow", { dispatched: true }))
      await call("browser_open", { url: "https://app.example.com/" })
      const timedOut = await call("browser_act", { observationId: "x", action: { type: "key", key: "Enter" } })
      expect(payloadOf(timedOut)).toMatchObject({ ok: false, code: "timeout", next: "observe_before_retry", dispatched: true })
      const unexpected = await call("browser_act", { observationId: "x", action: { type: "key", key: "Meta+A" } })
      expect(unexpected.isError).toBe(true)
    })
  })
})

function organizationContext(metadata: string | null): OrganizationContext {
  const now = new Date("2026-09-30T00:00:00Z")
  return {
    organization: { id: createDenTypeId("organization"), name: "Cloud Browser Test", slug: `cloud-browser-${crypto.randomUUID()}`, logo: null, allowedEmailDomains: null, metadata, createdAt: now, updatedAt: now },
    currentMember: { id: createDenTypeId("member"), userId: createDenTypeId("user"), role: "member", createdAt: now, joinedAt: now, isOwner: false },
    members: [],
    invitations: [],
    roles: [],
    teams: [],
  }
}

function contextMiddleware(context: OrganizationContext): MiddlewareHandler<{ Variables: OrgRouteVariables }> {
  return async (c, next) => {
    c.set("organizationContext", context)
    await next()
  }
}

const enabled = JSON.stringify({ capabilities: { cloudBrowser: true } })

function routeApp(options: { metadata?: string | null; browser?: FakeCloudBrowser | null } = {}) {
  const app = new Hono<{ Variables: OrgRouteVariables }>()
  const context = organizationContext(options.metadata === undefined ? enabled : options.metadata)
  const browser = options.browser === undefined ? createFakeCloudBrowser() : options.browser
  routes.registerCloudBrowserRoutes(app, { browser, memberRoute: contextMiddleware(context) })
  const key = { organizationId: context.organization.id, memberId: context.currentMember.id }
  const post = (path: string, body: unknown) => app.request(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
  return { app, browser, key, post }
}

describe("member cloud browser routes", () => {
  test("off for the workspace or the deployment: reported, never started", async () => {
    for (const setup of [routeApp({ metadata: null }), routeApp({ browser: null })]) {
      expect(await (await setup.app.request("/v1/cloud-browser")).json()).toEqual({ available: false, running: false, url: null, title: null })
      expect((await setup.app.request("/v1/cloud-browser/screen")).status).toBe(404)
      expect((await setup.post("/v1/cloud-browser/input", { events: [{ type: "key", key: "Tab" }] })).status).toBe(404)
      expect((await setup.post("/v1/cloud-browser/done", {})).status).toBe(404)
    }
  })

  test("not running: status says so and nothing starts it", async () => {
    const { app, browser, post } = routeApp()
    expect(await (await app.request("/v1/cloud-browser")).json()).toEqual({ available: true, running: false, url: null, title: null })
    const screen = await app.request("/v1/cloud-browser/screen")
    expect(screen.status).toBe(409)
    expect(await screen.json()).toEqual({ error: "cloud_browser_not_running", message: "Your cloud browser isn't running." })
    expect((await post("/v1/cloud-browser/input", { events: [{ type: "key", key: "Tab" }] })).status).toBe(409)
    expect((await post("/v1/cloud-browser/done", {})).status).toBe(409)
    expect(browser?.calls.some((call) => call.method === "open" || call.method === "navigate")).toBe(false)
  })

  test("running: status, live view, take-over input and done, for the caller's own browser only", async () => {
    const { app, browser, key, post } = routeApp()
    if (!browser) throw new Error("missing browser")
    await browser.open(key, { url: "https://app.example.com/login?token=secret" })

    const status = await (await app.request("/v1/cloud-browser")).json()
    expect(status).toEqual({ available: true, running: true, url: "https://app.example.com/login", title: "app.example.com" })

    const screen = await app.request("/v1/cloud-browser/screen")
    expect(screen.status).toBe(200)
    expect(screen.headers.get("content-type")).toBe("image/jpeg")
    expect(screen.headers.get("cache-control")).toContain("no-store")
    expect(Buffer.from(await screen.arrayBuffer()).subarray(0, 2).toString("hex")).toBe("ffd8")

    const events = [
      { type: "click", x: 120, y: 64 },
      { type: "text", text: "my own password" },
      { type: "key", key: "Enter" },
    ]
    const input = await post("/v1/cloud-browser/input", { events })
    expect(input.status).toBe(200)
    expect(await input.json()).toEqual({ ok: true })
    expect(browser.calls.find((call) => call.method === "input")?.input).toEqual(events)

    expect(await (await post("/v1/cloud-browser/done", {})).json()).toEqual({ ok: true })
    expect(browser.calls.filter((call) => call.method !== "open").every((call) => call.key.organizationId === key.organizationId && call.key.memberId === key.memberId)).toBe(true)
  })

  test("take-over input is validated and bounded", async () => {
    const { browser, key, post } = routeApp()
    await browser?.open(key, { url: "https://app.example.com/" })
    for (const body of [
      {},
      { events: [] },
      { events: Array.from({ length: 33 }, () => ({ type: "key", key: "Tab" })) },
      { events: [{ type: "key", key: "F12" }] },
      { events: [{ type: "text", text: "x".repeat(2_001) }] },
      { events: [{ type: "click", x: -5, y: 10 }] },
      { events: [{ type: "wheel", x: 1, y: 1, deltaY: 99_999 }] },
      { events: [{ type: "eval", code: "alert(1)" }] },
    ]) {
      expect([body, (await post("/v1/cloud-browser/input", body)).status]).toEqual([body, 400])
    }
    expect(browser?.calls.some((call) => call.method === "input")).toBe(false)
  })

  test("viewers polling at once share one capture", async () => {
    const { app, browser, key } = routeApp()
    await browser?.open(key, { url: "https://app.example.com/" })
    const responses = await Promise.all([app.request("/v1/cloud-browser/screen"), app.request("/v1/cloud-browser/screen"), app.request("/v1/cloud-browser/screen")])
    expect(responses.map((response) => response.status)).toEqual([200, 200, 200])
    expect(browser?.calls.filter((call) => call.method === "screenshot")).toHaveLength(1)
  })

  test("a browser that fails answers 503 without details", async () => {
    const { app, browser, key, post } = routeApp()
    await browser?.open(key, { url: "https://app.example.com/" })
    browser?.failNext("screenshot", new CloudBrowserError("browser_unavailable", "Daytona said 429 for sandbox owb-1234"))
    const screen = await app.request("/v1/cloud-browser/screen")
    expect(screen.status).toBe(503)
    expect(JSON.stringify(await screen.json())).not.toContain("owb-")
    browser?.failNext("rememberLogins", new CloudBrowserError("not_running", "gone"))
    expect((await post("/v1/cloud-browser/done", {})).status).toBe(409)
  })

  test("the routes are documented but never offered to agents as capabilities", async () => {
    const { app } = routeApp()
    const document = await generateSpecs(app)
    const operations = Object.entries(document.paths ?? {}).flatMap(([path, item]) =>
      (["get", "post"] as const).flatMap((method) => {
        const operation = item?.[method]
        return operation ? [{ path, method, operation }] : []
      }))
    expect(operations.map(({ method, path }) => `${method.toUpperCase()} ${path}`).sort()).toEqual([
      "GET /v1/cloud-browser",
      "GET /v1/cloud-browser/screen",
      "POST /v1/cloud-browser/done",
      "POST /v1/cloud-browser/input",
    ])
    for (const { path, method, operation } of operations) {
      expect(policy.isMcpOperationAllowed({ method, path, operation: { ...operation, "x-mcp": Reflect.get(operation, "x-mcp") } })).toBe(false)
    }
  })
})
