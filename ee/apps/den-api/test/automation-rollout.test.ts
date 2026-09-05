import { expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { readFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const denApiRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")

function probeAutomations(options: { enabled?: string; runtimeEnabled?: string } = {}) {
  return spawnSync(process.execPath, ["--conditions", "development", "--eval", `
    const { env } = await import("./src/env.ts")
    console.log(JSON.stringify({
      enabled: env.automations.enabled,
      runtimeEnabled: env.automations.runtimeEnabled,
    }))
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
      ...(options.enabled === undefined ? {} : { DEN_AUTOMATIONS_ENABLED: options.enabled }),
      ...(options.runtimeEnabled === undefined
        ? {}
        : { DEN_AUTOMATIONS_RUNTIME_ENABLED: options.runtimeEnabled }),
    },
  })
}

function probeAutomationRoutes(options: { enabled?: string; runtimeEnabled?: string } = {}) {
  return spawnSync(process.execPath, ["--conditions", "development", "--eval", `
    const { default: app } = await import("./src/app.ts")
    const routes = new Set(app.routes.map((route) => route.method + " " + route.path))
    console.log(JSON.stringify({
      list: routes.has("GET /v1/automations"),
      runnerToken: routes.has("POST /v1/automation-runners/token"),
    }))
    process.exit(0)
  `], {
    cwd: denApiRoot,
    encoding: "utf8",
    env: {
      PATH: process.env.PATH ?? "",
      HOME: process.env.HOME ?? "",
      TMPDIR: process.env.TMPDIR ?? "",
      DATABASE_URL: "mysql://root:password@127.0.0.1:3306/openwork_test",
      DB_MODE: "mysql",
      DEN_DB_ENCRYPTION_KEY: "test-db-encryption-key-with-enough-entropy",
      BETTER_AUTH_SECRET: "test-auth-secret-with-enough-entropy-123456789",
      BETTER_AUTH_URL: "https://den.openwork.test",
      OPENWORK_DEV_MODE: "0",
      PROVISIONER_MODE: "stub",
      ...(options.enabled === undefined ? {} : { DEN_AUTOMATIONS_ENABLED: options.enabled }),
      ...(options.runtimeEnabled === undefined
        ? {}
        : { DEN_AUTOMATIONS_RUNTIME_ENABLED: options.runtimeEnabled }),
    },
  })
}

test("Automation availability fails closed while the legacy runtime remains compatible", () => {
  const unset = probeAutomations()
  const disabled = probeAutomations({ enabled: "false" })
  const compatible = probeAutomations({ enabled: "false", runtimeEnabled: "true" })
  const enabled = probeAutomations({ enabled: "true" })
  const runtimeDisabled = probeAutomations({ enabled: "true", runtimeEnabled: "false" })

  expect(unset.status, unset.stderr).toBe(0)
  expect(unset.stdout.trim()).toBe('{"enabled":false,"runtimeEnabled":true}')
  expect(disabled.status, disabled.stderr).toBe(0)
  expect(disabled.stdout.trim()).toBe('{"enabled":false,"runtimeEnabled":false}')
  expect(compatible.status, compatible.stderr).toBe(0)
  expect(compatible.stdout.trim()).toBe('{"enabled":false,"runtimeEnabled":true}')
  expect(enabled.status, enabled.stderr).toBe(0)
  expect(enabled.stdout.trim()).toBe('{"enabled":true,"runtimeEnabled":true}')
  expect(runtimeDisabled.status, runtimeDisabled.stderr).toBe(0)
  expect(runtimeDisabled.stdout.trim()).toBe('{"enabled":false,"runtimeEnabled":false}')
})

test("Automation routes distinguish legacy defaults, explicit shutdown, and compatibility override", () => {
  const compatible = probeAutomationRoutes()
  const hardDisabled = probeAutomationRoutes({ enabled: "false" })
  const mixedVersion = probeAutomationRoutes({ enabled: "false", runtimeEnabled: "true" })

  expect(compatible.status, compatible.stderr).toBe(0)
  expect(compatible.stdout.trim()).toBe('{"list":true,"runnerToken":true}')
  expect(hardDisabled.status, hardDisabled.stderr).toBe(0)
  expect(hardDisabled.stdout.trim()).toBe('{"list":false,"runnerToken":false}')
  expect(mixedVersion.status, mixedVersion.stderr).toBe(0)
  expect(mixedVersion.stdout.trim()).toBe('{"list":true,"runnerToken":true}')
})

test("the explicit runtime flag gates Automation routes and scheduling in Den", () => {
  const app = readFileSync(path.join(denApiRoot, "src/app.ts"), "utf8")
  const meRoutes = readFileSync(path.join(denApiRoot, "src/routes/me/index.ts"), "utf8")
  const routes = readFileSync(path.join(denApiRoot, "src/routes/automations/index.ts"), "utf8")
  const agentMcp = readFileSync(path.join(denApiRoot, "src/mcp/agent.ts"), "utf8")
  const server = readFileSync(path.join(denApiRoot, "src/server.ts"), "utf8")

  expect(meRoutes).toContain("automationsEnabled: env.automations.enabled")
  expect(app).toContain("registerAutomationRoutes(app, { enabled: env.automations.runtimeEnabled })")
  expect(routes).toContain("if (options.enabled === false) return")
  expect(routes).not.toContain("automationsDisabledResponse")
  expect(agentMcp).toContain("if (env.automations.runtimeEnabled)")
  expect(agentMcp).toContain("registerAgentAutomationResources")
  expect(server).toContain("startAutomationSchedulerLoop({ enabled: env.automations.runtimeEnabled })")
})
