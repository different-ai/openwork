import { describe, expect, test } from "bun:test"
import { createEnterpriseMockLabApp } from "../src/app.js"
import {
  ControlPlaneError,
  type CreateInstanceInput,
  type EnterpriseMockLabControlPlane,
  type LabFault,
  type LabInstanceView,
  type LabProfile,
  type UpdateScenarioInput,
} from "../src/contracts.js"
import { SecurityService } from "../src/security.js"

const ORIGIN = "http://127.0.0.1:8794"
const ADMIN_SECRET = "local-admin-secret-with-more-than-32-characters"
const CLIENT_SECRET = "synthetic-oauth-client-secret"

const profile: LabProfile = {
  description: "ServiceNow MCP inbound quickstart simulation",
  fixtureVersion: "2026-07-12.1",
  id: "servicenow-inbound-quickstart",
  name: "ServiceNow Inbound Quickstart",
  provenance: {
    aspectFidelity: { authorization: "synthetic", catalog: "synthetic", endpoint: "provider-documented", providerResults: "synthetic", toolSchemas: "synthetic", transport: "mcp-specification" },
    documentationUrls: ["https://example.test/servicenow"],
    fidelity: "provider-documented",
    knownLimitations: ["No live tenant business rules."],
    productSurface: "Inbound MCP server",
    verifiedAt: "2026-07-12",
  },
}

const fault: LabFault = {
  category: "provider_authorization",
  description: "The provider denies access after successful OAuth.",
  diagnosticLevel: "operation",
  expectedCategory: "provider_authorization",
  expectedFirstFailedPhase: "PROVIDER_AUTHORIZATION",
  id: "servicenow-provider-authorization-denied",
  name: "Provider authorization denied",
  phase: "PROVIDER_AUTHORIZATION",
  profileIds: [profile.id],
}

const syntheticProfile: LabProfile = {
  description: "Synthetic standards reference Standards-only OAuth MCP · client-to-provider",
  fixtureVersion: "2026-07-12.1",
  id: "synthetic-enterprise-oauth-mcp",
  name: "Synthetic Enterprise OAuth MCP",
  provenance: {
    aspectFidelity: { authorization: "spec-conformant", catalog: "synthetic", endpoint: "synthetic", providerResults: "synthetic", toolSchemas: "synthetic", transport: "mcp-specification" },
    documentationUrls: ["https://modelcontextprotocol.io/specification"],
    fidelity: "spec-conformant",
    knownLimitations: ["Not a vendor product simulation."],
    productSurface: "Standards-only OAuth MCP",
    verifiedAt: "2026-07-12",
  },
}

function instance(overrides: Partial<LabInstanceView> = {}): LabInstanceView {
  return {
    activeFault: null,
    createdAt: "2026-07-12T00:00:00.000Z",
    displayName: "ServiceNow development scenario",
    endpoint: null,
    events: [],
    id: "instance-1",
    lastError: null,
    lastProbe: null,
    oauth: {
      authorizationServerUrl: null,
      clientId: "enterprise-mcp-test-client",
      protectedResourceMetadataUrl: null,
      registration: "manual",
    },
    port: 21080,
    profile,
    scenarioRevision: 1,
    secretsConfigured: { clientId: true, clientSecret: true },
    state: "stopped",
    ...overrides,
  }
}

class FakeControlPlane implements EnterpriseMockLabControlPlane {
  createdInput: CreateInstanceInput | undefined
  current = instance()

  catalog() {
    return { faults: [fault], profiles: [profile, syntheticProfile] }
  }

  async create(input: CreateInstanceInput) {
    this.createdInput = input
    this.current = instance({ displayName: input.displayName, port: input.port })
    return this.current
  }

  get(id: string) {
    return id === this.current.id ? this.current : undefined
  }

  list() {
    return [this.current]
  }

  async probe(id: string) {
    this.#require(id)
    this.current = instance({
      endpoint: { baseUrl: "http://127.0.0.1:21080", mcpUrl: "http://127.0.0.1:21080/sncapps/mcp-server/mcp/mock" },
      lastProbe: {
        expected: { category: null, firstFailedPhase: null, outcome: "success" },
        matchesExpectation: true,
        mode: "fixture-conformance",
        observed: { category: null, firstFailedPhase: null, outcome: "success" },
        summary: "The healthy probe matched.",
      },
      state: "running",
    })
    return this.current
  }

  async remove(id: string) {
    this.#require(id)
  }

  async reset(id: string) {
    this.#require(id)
    this.current = instance()
    return this.current
  }

  async start(id: string) {
    this.#require(id)
    this.current = instance({
      endpoint: { baseUrl: "http://127.0.0.1:21080", mcpUrl: "http://127.0.0.1:21080/sncapps/mcp-server/mcp/mock" },
      state: "running",
    })
    return this.current
  }

  async stop(id: string) {
    this.#require(id)
    this.current = instance()
    return this.current
  }

  async updateScenario(id: string, input: UpdateScenarioInput) {
    this.#require(id)
    if (input.expectedRevision !== this.current.scenarioRevision) throw new ControlPlaneError("conflict", "stale")
    this.current = instance({
      activeFault: input.faultId ? fault : null,
      scenarioRevision: this.current.scenarioRevision + 1,
    })
    return this.current
  }

  #require(id: string) {
    if (id !== this.current.id) throw new ControlPlaneError("not_found", "not found")
  }
}

function createFixture() {
  const tokens = ["csrf-token-value", "session-token-value"]
  const controlPlane = new FakeControlPlane()
  const security = new SecurityService({
    adminSecret: ADMIN_SECRET,
    expectedOrigin: ORIGIN,
    randomToken: () => tokens.shift() ?? "extra-token",
    sessionTtlSeconds: 3_600,
  })
  const app = createEnterpriseMockLabApp({ controlPlane, security })
  return { app, controlPlane }
}

async function login(app: ReturnType<typeof createEnterpriseMockLabApp>) {
  const response = await app.request(`${ORIGIN}/session/login`, {
    body: new URLSearchParams({ adminSecret: ADMIN_SECRET }),
    headers: { "content-type": "application/x-www-form-urlencoded", origin: ORIGIN },
    method: "POST",
  })
  const cookie = response.headers.get("set-cookie")?.split(";", 1)[0]
  if (!cookie) throw new Error("Login did not issue a session cookie")
  return cookie
}

describe("Enterprise Mock Lab control-plane HTTP boundary", () => {
  test("keeps the API private and applies defensive response headers", async () => {
    const { app } = createFixture()
    const response = await app.request(`${ORIGIN}/api/v1/instances`)

    expect(response.status).toBe(401)
    expect(response.headers.get("cache-control")).toBe("no-store")
    expect(response.headers.get("content-security-policy")).toContain("script-src")
    expect(response.headers.get("referrer-policy")).toBe("same-origin")
    expect(response.headers.get("x-frame-options")).toBe("DENY")
    expect(await response.json()).toMatchObject({ error: "authentication_required" })
  })

  test("rejects login from a foreign or missing Origin", async () => {
    const { app } = createFixture()
    const response = await app.request(`${ORIGIN}/session/login`, {
      body: new URLSearchParams({ adminSecret: ADMIN_SECRET }),
      headers: { "content-type": "application/x-www-form-urlencoded", origin: "https://attacker.example" },
      method: "POST",
    })

    expect(response.headers.get("set-cookie")).toBeNull()
    expect(response.status).not.toBe(200)
  })

  test("issues an HttpOnly SameSite=Strict session after constant-time secret authentication", async () => {
    const { app } = createFixture()
    const response = await app.request(`${ORIGIN}/session/login`, {
      body: new URLSearchParams({ adminSecret: ADMIN_SECRET }),
      headers: { "content-type": "application/x-www-form-urlencoded", origin: ORIGIN },
      method: "POST",
    })

    expect(response.status).toBe(303)
    expect(response.headers.get("set-cookie")).toContain("HttpOnly")
    expect(response.headers.get("set-cookie")).toContain("SameSite=Strict")
    expect(response.headers.get("set-cookie")).not.toContain(ADMIN_SECRET)
  })

  test("renders a script-free accessible admin UI with provenance and write-only fields", async () => {
    const { app } = createFixture()
    const cookie = await login(app)
    const response = await app.request(`${ORIGIN}/`, { headers: { cookie } })
    const html = await response.text()

    expect(response.status).toBe(200)
    expect(html).toContain("Skip to content")
    expect(html).toContain("Profile provenance")
    expect(html).toContain("provider-documented")
    expect(html).toContain("Synthetic Enterprise OAuth MCP")
    expect(html).toContain("Not a vendor product simulation")
    expect(html).toContain('value="servicenow-inbound-quickstart" selected')
    expect(html).toContain('type="password"')
    expect(html).toContain('name="csrfToken" value="csrf-token-value"')
    expect(html).not.toContain("<script")
    expect(html).not.toContain(ADMIN_SECRET)
    expect(html).not.toContain(CLIENT_SECRET)
  })

  test("requires both exact Origin and CSRF token for JSON mutations", async () => {
    const { app } = createFixture()
    const cookie = await login(app)
    const response = await app.request(`${ORIGIN}/api/v1/instances`, {
      body: JSON.stringify({
        clientSecret: CLIENT_SECRET,
        displayName: "Test",
        port: 21081,
        profileId: profile.id,
      }),
      headers: { "content-type": "application/json", cookie, origin: ORIGIN },
      method: "POST",
    })

    expect(response.status).toBe(403)
    expect(await response.json()).toMatchObject({ error: "csrf_failed" })
  })

  test("rejects cross-origin and oversized streaming mutations before control-plane work", async () => {
    const { app, controlPlane } = createFixture()
    const cookie = await login(app)
    let crossOriginBodyRead = false
    const crossOriginBody = new ReadableStream<Uint8Array>({
      pull(controller) {
        crossOriginBodyRead = true
        controller.error(new Error("cross-origin body must not be consumed"))
      },
    }, { highWaterMark: 0 })
    const crossOrigin = await app.fetch(new Request(`${ORIGIN}/api/v1/instances`, {
      body: crossOriginBody,
      headers: { "content-type": "application/json", cookie, origin: "https://attacker.example" },
      method: "POST",
      // Required by Node-compatible streaming Request implementations.
      duplex: "half",
    } as RequestInit & { duplex: "half" }))
    expect(crossOrigin.status).toBe(403)
    expect(crossOriginBodyRead).toBe(false)
    expect(controlPlane.createdInput).toBeUndefined()

    const chunks = [new Uint8Array(40 * 1024), new Uint8Array(40 * 1024)]
    const oversizedBody = new ReadableStream<Uint8Array>({
      pull(controller) {
        const chunk = chunks.shift()
        if (chunk) controller.enqueue(chunk)
        else controller.close()
      },
    })
    const oversized = await app.fetch(new Request(`${ORIGIN}/api/v1/instances`, {
      body: oversizedBody,
      headers: {
        "content-type": "application/json",
        cookie,
        origin: ORIGIN,
        "x-csrf-token": "csrf-token-value",
      },
      method: "POST",
      duplex: "half",
    } as RequestInit & { duplex: "half" }))
    expect(oversized.status).toBe(413)
    expect(controlPlane.createdInput).toBeUndefined()
  })

  test("classifies malformed and unsupported request bodies without echoing submitted secrets", async () => {
    const { app } = createFixture()
    const cookie = await login(app)
    const headers = {
      cookie,
      origin: ORIGIN,
      "x-csrf-token": "csrf-token-value",
    }
    const malformed = await app.request(`${ORIGIN}/api/v1/instances`, {
      body: `{"clientSecret":"${CLIENT_SECRET}",`,
      headers: { ...headers, "content-type": "application/json" },
      method: "POST",
    })
    const malformedText = await malformed.text()
    expect(malformed.status).toBe(400)
    expect(malformedText).toContain("JSON request body is malformed")
    expect(malformedText).not.toContain(CLIENT_SECRET)

    const unsupported = await app.request(`${ORIGIN}/api/v1/instances`, {
      body: CLIENT_SECRET,
      headers: { ...headers, "content-type": "text/plain" },
      method: "POST",
    })
    const unsupportedText = await unsupported.text()
    expect(unsupported.status).toBe(400)
    expect(unsupportedText).toContain("application/json")
    expect(unsupportedText).not.toContain(CLIENT_SECRET)
  })

  test("accepts a valid mutation without returning provider secrets", async () => {
    const { app, controlPlane } = createFixture()
    const cookie = await login(app)
    const response = await app.request(`${ORIGIN}/api/v1/instances`, {
      body: JSON.stringify({
        clientSecret: CLIENT_SECRET,
        displayName: "ServiceNow local",
        port: 21081,
        profileId: profile.id,
      }),
      headers: {
        "content-type": "application/json",
        cookie,
        origin: ORIGIN,
        "x-csrf-token": "csrf-token-value",
      },
      method: "POST",
    })
    const serialized = await response.text()

    expect(response.status).toBe(201)
    expect(controlPlane.createdInput?.clientSecret).toBe(CLIENT_SECRET)
    expect(serialized).not.toContain(CLIENT_SECRET)
    expect(serialized).toContain('"clientSecret":true')
  })

  test("dispatches lifecycle actions and preserves revision conflicts", async () => {
    const { app } = createFixture()
    const cookie = await login(app)
    const mutationHeaders = {
      "content-type": "application/json",
      cookie,
      origin: ORIGIN,
      "x-csrf-token": "csrf-token-value",
    }

    const started = await app.request(`${ORIGIN}/api/v1/instances/instance-1/actions/start`, {
      body: "{}",
      headers: mutationHeaders,
      method: "POST",
    })
    expect(started.status).toBe(200)
    expect(await started.json()).toMatchObject({ state: "running" })

    const stale = await app.request(`${ORIGIN}/api/v1/instances/instance-1/scenario`, {
      body: JSON.stringify({ expectedRevision: 0, faultId: fault.id }),
      headers: mutationHeaders,
      method: "POST",
    })
    expect(stale.status).toBe(409)
    expect(await stale.json()).toMatchObject({ error: "conflict" })
  })
})
