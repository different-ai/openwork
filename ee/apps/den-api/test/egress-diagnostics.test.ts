import { describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { randomUUID } from "node:crypto"
import path from "node:path"
import { fileURLToPath } from "node:url"
import {
  EGRESS_DIAGNOSTIC_ID_HEADER,
  EGRESS_DIAGNOSTIC_RUN_HEADER,
  EGRESS_DIAGNOSTIC_SIGNATURE_HEADER,
  egressDiagnosticRunSchema,
} from "@openwork/types/den/egress-diagnostics"
import { runEgressDiagnostic } from "../src/egress-diagnostics"

const origin = "https://diagnostic.openwork.test"
const denApiRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")

function expectConfiguredOrigin(expectedOrigin: string, configuredOrigin?: string): void {
  const result = spawnSync(process.execPath, ["--conditions", "development", "--eval", `
    const { env } = await import("./src/env.ts")
    if (env.diagnostics.origin !== process.env.TEST_EXPECTED_ORIGIN) {
      throw new Error(\`Expected diagnostics origin \${process.env.TEST_EXPECTED_ORIGIN}, got \${env.diagnostics.origin}\`)
    }
  `], {
    cwd: denApiRoot,
    encoding: "utf8",
    env: {
      PATH: process.env.PATH ?? "",
      HOME: process.env.HOME ?? "",
      TMPDIR: process.env.TMPDIR ?? "",
      DATABASE_URL: "mysql://root:password@127.0.0.1:3306/openwork_test",
      DB_MODE: "mysql",
      DEN_DB_ENCRYPTION_KEY: "x".repeat(32),
      BETTER_AUTH_SECRET: "y".repeat(32),
      BETTER_AUTH_URL: "https://den.openwork.test",
      OPENWORK_DEV_MODE: "0",
      PROVISIONER_MODE: "stub",
      TEST_EXPECTED_ORIGIN: expectedOrigin,
      ...(configuredOrigin ? { DEN_DIAGNOSTICS_ORIGIN: configuredOrigin } : {}),
    },
  })

  if (result.status !== 0) {
    throw new Error(["Diagnostics origin probe failed", result.stdout, result.stderr].join("\n"))
  }
}

function json(value: unknown, status = 200, headers: HeadersInit = {}): Response {
  return Response.json(value, { status, headers: { [EGRESS_DIAGNOSTIC_ID_HEADER]: randomUUID(), ...headers } })
}

function healthyDiagnosticFetch(seen: Request[]): typeof fetch {
  const session = "synthetic-mcp-session-token-that-is-long-enough"
  return async (input, init) => {
    const request = new Request(input, init)
    seen.push(request.clone())
    const url = new URL(request.url)
    if (url.pathname === "/diagnostics/egress" && request.method === "HEAD") {
      return new Response(null, { status: 204, headers: { [EGRESS_DIAGNOSTIC_ID_HEADER]: randomUUID() } })
    }
    if (url.pathname === "/diagnostics/egress" && request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: { allow: "GET, HEAD, OPTIONS, POST", [EGRESS_DIAGNOSTIC_ID_HEADER]: randomUUID() } })
    }
    if (url.pathname === "/diagnostics/egress" && request.method === "POST") return json({ method: "POST", ok: true })
    if (url.pathname === "/diagnostics/egress") return json({ method: "GET", ok: true })
    if (url.pathname === "/diagnostics/redirect") {
      return new Response(null, { status: 302, headers: { location: `${origin}/diagnostics/egress?redirected=1`, [EGRESS_DIAGNOSTIC_ID_HEADER]: randomUUID() } })
    }
    if (url.pathname === "/.well-known/oauth-protected-resource/mcp") {
      return json({ authorization_servers: [origin], resource: `${origin}/mcp` })
    }
    if (url.pathname === "/.well-known/oauth-authorization-server") {
      return json({ issuer: origin, token_endpoint: `${origin}/oauth/token` })
    }
    if (url.pathname === "/oauth/token") return json({ access_token: "synthetic-access-token-that-is-long-enough", token_type: "Bearer" })
    if (url.pathname === "/mcp") {
      const body: unknown = await request.json()
      const method = typeof body === "object" && body !== null && "method" in body ? body.method : null
      if (method === "initialize") {
        return json({ id: 1, jsonrpc: "2.0", result: { protocolVersion: "2025-11-25" } }, 200, {
          "mcp-protocol-version": "2025-11-25",
          "mcp-session-id": session,
        })
      }
      if (method === "notifications/initialized") {
        return new Response(null, { status: 202, headers: { [EGRESS_DIAGNOSTIC_ID_HEADER]: randomUUID() } })
      }
      if (method === "tools/list") return json({ id: 2, jsonrpc: "2.0", result: { tools: [{ name: "profile_specific_tool" }] } })
      if (method === "tools/call") return json({ id: 3, jsonrpc: "2.0", result: { isError: false } })
    }
    return json({ error: "not_found" }, 404)
  }
}

describe("Den private-cloud egress diagnostic", () => {
  test("defaults to the OpenWork Labs diagnostic host and accepts an operator override", () => {
    expectConfiguredOrigin("https://diagnostic.openworklabs.com")
    expectConfiguredOrigin("https://diagnostic.customer.example", "https://diagnostic.customer.example/")
  })

  test("attributes a healthy HTTP, redirect, OAuth, and MCP story to one run", async () => {
    const seen: Request[] = []
    let clock = Date.parse("2026-07-13T12:00:00.000Z")
    const result = await runEgressDiagnostic({
      bearerToken: "synthetic-diagnostics-secret",
      fetchImpl: healthyDiagnosticFetch(seen),
      now: () => { clock += 5; return clock },
      origin,
      runId: randomUUID(),
    })

    expect(egressDiagnosticRunSchema.safeParse(result).success).toBe(true)
    expect(result.overallStatus).toBe("passed")
    expect(result.failedStep).toBeNull()
    expect(result.highestPassingStep).toBe("mcp-handshake")
    expect(result.steps.every((step) => step.status === "passed")).toBe(true)
    expect(seen).toHaveLength(13)
    expect(seen.every((request) => request.headers.get(EGRESS_DIAGNOSTIC_RUN_HEADER) === result.runId)).toBe(true)
    expect(seen.every((request) => /^[0-9a-f]{64}$/u.test(request.headers.get(EGRESS_DIAGNOSTIC_SIGNATURE_HEADER) ?? ""))).toBe(true)
    const seenBodies = await Promise.all(seen.map((request) => request.text()))
    const toolCallBody = seenBodies.find((body) => body.includes("tools/call"))
    expect(toolCallBody).toContain("profile_specific_tool")
  })

  test("stops specifically at OAuth token authorization and skips MCP", async () => {
    const seen: Request[] = []
    const baseFetch = healthyDiagnosticFetch(seen)
    const result = await runEgressDiagnostic({
      bearerToken: "wrong-synthetic-diagnostics-secret",
      fetchImpl: async (input, init) => {
        const request = new Request(input, init)
        if (new URL(request.url).pathname === "/oauth/token") {
          seen.push(request.clone())
          return json({ error: "invalid_client" }, 401)
        }
        return baseFetch(input, init)
      },
      origin,
      runId: randomUUID(),
    })

    expect(result.overallStatus).toBe("failed")
    expect(result.highestPassingStep).toBe("oauth-discovery")
    expect(result.failedStep).toBe("oauth-token")
    expect(result.steps.find((step) => step.id === "oauth-token")).toMatchObject({
      code: "http_401",
      owner: "den-operator",
      status: "failed",
    })
    expect(result.steps.find((step) => step.id === "mcp-handshake")?.status).toBe("skipped")
    expect(seen.some((request) => new URL(request.url).pathname === "/mcp")).toBe(false)
  })

  test("identifies DNS failure before HTTP reaches OpenWork", async () => {
    const cause = Object.assign(new Error("lookup failed"), { code: "ENOTFOUND" })
    const result = await runEgressDiagnostic({
      bearerToken: "synthetic-diagnostics-secret",
      fetchImpl: async () => { throw new TypeError("fetch failed", { cause }) },
      origin,
      runId: randomUUID(),
    })

    expect(result.failedStep).toBe("reachability")
    expect(result.highestPassingStep).toBeNull()
    expect(result.steps[0]).toMatchObject({
      code: "ENOTFOUND",
      diagnosticIds: [],
      owner: "network-administrator",
      status: "failed",
    })
    expect(result.steps.slice(1).every((step) => step.status === "skipped")).toBe(true)
  })

  test("identifies a proxy-replaced response that lacks OpenWork receipt proof", async () => {
    const result = await runEgressDiagnostic({
      bearerToken: "synthetic-diagnostics-secret",
      fetchImpl: async () => Response.json({ ok: true }),
      origin,
      runId: randomUUID(),
    })

    expect(result.steps[0]).toMatchObject({
      code: "diagnostic_reference_missing",
      diagnosticIds: [],
      owner: "network-administrator",
      status: "failed",
    })
  })
})
