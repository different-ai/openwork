import { expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import path from "node:path"
import { fileURLToPath } from "node:url"

const denApiRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")

function seedRequiredEnv() {
  process.env.DATABASE_URL = process.env.DATABASE_URL ?? "mysql://root:password@127.0.0.1:3306/openwork_test"
  process.env.DB_MODE = process.env.DB_MODE ?? "mysql"
  process.env.DEN_DB_ENCRYPTION_KEY = process.env.DEN_DB_ENCRYPTION_KEY ?? "x".repeat(32)
  process.env.BETTER_AUTH_SECRET = process.env.BETTER_AUTH_SECRET ?? "y".repeat(32)
  process.env.BETTER_AUTH_URL = process.env.BETTER_AUTH_URL ?? "http://127.0.0.1:8790"
}

function probeAccessTokenLifetime(overrides: Record<string, string>) {
  return spawnSync(process.execPath, ["--conditions", "development", "--eval", `
    const { DEN_MCP_ACCESS_TOKEN_EXPIRES_IN_SECONDS } = await import("./src/mcp/token-lifetime.ts")
    console.log(DEN_MCP_ACCESS_TOKEN_EXPIRES_IN_SECONDS)
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
      BETTER_AUTH_URL: "http://127.0.0.1:8790",
      OPENWORK_DEV_MODE: "0",
      PROVISIONER_MODE: "stub",
      ...overrides,
    },
  })
}

test("MCP OAuth access tokens use a short lifetime", () => {
  const result = probeAccessTokenLifetime({})
  expect(result.status).toBe(0)
  expect(result.stdout.trim()).toBe(String(45 * 60))
})

test("MCP OAuth access-token test override can shorten the lifetime", () => {
  const result = probeAccessTokenLifetime({
    DEN_MCP_TEST_ACCESS_TOKEN_EXPIRES_IN_SECONDS: "2",
    OPENWORK_DEV_MODE: "1",
  })
  expect(result.status).toBe(0)
  expect(result.stdout.trim()).toBe("2")
})

test("MCP OAuth access-token test override is ignored outside dev mode", () => {
  const result = probeAccessTokenLifetime({
    DEN_MCP_TEST_ACCESS_TOKEN_EXPIRES_IN_SECONDS: "2",
    OPENWORK_DEV_MODE: "0",
  })
  expect(result.status).toBe(0)
  expect(result.stdout.trim()).toBe(String(45 * 60))
})

test("MCP OAuth access-token test override rejects invalid lifetimes", () => {
  for (const value of ["0", "1.5", "abc", String(45 * 60 + 1)]) {
    const result = probeAccessTokenLifetime({
      DEN_MCP_TEST_ACCESS_TOKEN_EXPIRES_IN_SECONDS: value,
      OPENWORK_DEV_MODE: "1",
    })
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain("DEN_MCP_TEST_ACCESS_TOKEN_EXPIRES_IN_SECONDS")
  }
})

test("invalid MCP OAuth access-token test override is ignored outside dev mode", () => {
  const result = probeAccessTokenLifetime({
    DEN_MCP_TEST_ACCESS_TOKEN_EXPIRES_IN_SECONDS: "abc",
    OPENWORK_DEV_MODE: "0",
  })
  expect(result.status).toBe(0)
  expect(result.stdout.trim()).toBe(String(45 * 60))
})

test("MCP OAuth access-token lifetime stays below the JWKS grace period", async () => {
  seedRequiredEnv()
  const [{ DEN_MCP_DEFAULT_ACCESS_TOKEN_EXPIRES_IN_SECONDS }, { DEN_JWKS_GRACE_PERIOD_SECONDS }] = await Promise.all([
    import("../src/mcp/token-lifetime.js"),
    import("../src/mcp/jwt-policy.js"),
  ])
  expect(DEN_MCP_DEFAULT_ACCESS_TOKEN_EXPIRES_IN_SECONDS).toBeLessThan(DEN_JWKS_GRACE_PERIOD_SECONDS)
})

test("rotating MCP refresh grants use a thirty-day inactivity window", async () => {
  seedRequiredEnv()
  const { DEN_MCP_REFRESH_TOKEN_EXPIRES_IN_SECONDS } = await import("../src/mcp/token-lifetime.js")
  expect(DEN_MCP_REFRESH_TOKEN_EXPIRES_IN_SECONDS).toBe(30 * 24 * 60 * 60)
})

test("first-party MCP bearer tokens retain a bounded seven-day lifetime", async () => {
  seedRequiredEnv()
  const { DEN_FIRST_PARTY_MCP_TOKEN_TTL_MS } = await import("../src/mcp/token-lifetime.js")
  expect(DEN_FIRST_PARTY_MCP_TOKEN_TTL_MS).toBe(7 * 24 * 60 * 60 * 1000)
})
