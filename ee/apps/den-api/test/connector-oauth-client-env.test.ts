import { describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import path from "node:path"
import { fileURLToPath } from "node:url"

const denApiRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")

function probeConnectorClients(overrides: Record<string, string>) {
  return spawnSync(process.execPath, ["--conditions", "development", "--eval", `
    const { env } = await import("./src/env.ts")
    console.log(JSON.stringify(env.connectorOAuthClients))
  `], {
    cwd: denApiRoot,
    encoding: "utf8",
    env: {
      PATH: process.env.PATH ?? "",
      HOME: process.env.HOME ?? "",
      TMPDIR: process.env.TMPDIR ?? "",
      DATABASE_URL: "mysql://root:password@127.0.0.1:3306/openwork_test",
      DB_MODE: "mysql",
      DEN_BASE_URL: "http://127.0.0.1:8790",
      DEN_DB_ENCRYPTION_KEY: "x".repeat(32),
      BETTER_AUTH_SECRET: "y".repeat(32),
      OPENWORK_DEV_MODE: "0",
      PROVISIONER_MODE: "stub",
      ...overrides,
    },
  })
}

describe("OpenWork-provided connector OAuth clients (env)", () => {
  test("is absent when neither variable is set", () => {
    const result = probeConnectorClients({})
    expect(result.stderr).toBe("")
    expect(result.status).toBe(0)
    expect(JSON.parse(result.stdout)).toEqual({})
  })

  test("exposes the Google Workspace client when both halves are set", () => {
    const result = probeConnectorClients({
      DEN_CONNECTOR_GOOGLE_WORKSPACE_CLIENT_ID: " 1234.apps.googleusercontent.com ",
      DEN_CONNECTOR_GOOGLE_WORKSPACE_CLIENT_SECRET: "GOCSPX-test-secret",
    })
    expect(result.stderr).toBe("")
    expect(result.status).toBe(0)
    expect(JSON.parse(result.stdout)).toEqual({
      "google-workspace": { clientId: "1234.apps.googleusercontent.com", clientSecret: "GOCSPX-test-secret" },
    })
  })

  test("refuses to start with a client id but no secret", () => {
    const result = probeConnectorClients({ DEN_CONNECTOR_GOOGLE_WORKSPACE_CLIENT_ID: "1234.apps.googleusercontent.com" })
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain("DEN_CONNECTOR_GOOGLE_WORKSPACE_CLIENT_ID and DEN_CONNECTOR_GOOGLE_WORKSPACE_CLIENT_SECRET must be set together")
  })

  test("does not treat Den sign-in credentials as a connector client", () => {
    const result = probeConnectorClients({ GOOGLE_CLIENT_ID: "signin-client", GOOGLE_CLIENT_SECRET: "signin-secret" })
    expect(result.stderr).toBe("")
    expect(result.status).toBe(0)
    expect(JSON.parse(result.stdout)).toEqual({})
  })
})
