import { parseInstanceConfig, type InstanceConfig } from "@openwork-ee/den-modules"
import { afterEach, describe, expect, test, vi } from "vitest"
import { workbotOrigin } from "../workbot/config.js"
import { instanceConfigFromDenEnv } from "./instance-config.js"

const BASE_ENV: Record<string, string> = {
  DEN_DB_ENCRYPTION_KEY: "test-den-db-encryption-key-0123456789abcdef",
  BETTER_AUTH_SECRET: "test-better-auth-secret-0123456789abcdef",
  BETTER_AUTH_URL: "http://localhost:3005",
  DATABASE_URL: "mysql://root:password@127.0.0.1:3306/openwork_den_test",
  OPENWORK_DEV_MODE: "1",
}

const VARIED = [
  "DEN_ORG_MODE",
  "GATEWAY_ENABLED",
  "INFERENCE_FREE_ENABLED",
  "DEN_PLAN_GATING_ENABLED",
  "DEN_AUTOMATIONS_RUNTIME_ENABLED",
  "DEN_AUTOMATIONS_ENABLED",
  "DEN_APP_MCP_SERVERS_ENABLED",
  "DEN_DASHBOARDS_ENABLED",
  "DEN_OPENWORK_WEB_ENABLED",
  "DEN_AUDIT_CAPTURE_ENABLED",
  "DEN_AUDIT_VISIBILITY_ENABLED",
  "DEN_AUDIT_SELF_HOSTED_ENABLED",
  "DEN_SLACK_ASSISTANT_WORKER_ENABLED",
] as const

const VALUES: Record<(typeof VARIED)[number], ReadonlyArray<string | undefined>> = {
  DEN_ORG_MODE: [undefined, "single_org", "multi_org", " multi_org ", "garbage"],
  GATEWAY_ENABLED: [undefined, "false", "garbage"],
  INFERENCE_FREE_ENABLED: [undefined, "true", "false", "1", "0"],
  DEN_PLAN_GATING_ENABLED: [undefined, "true", "TRUE", "false", "1", "garbage"],
  DEN_AUTOMATIONS_RUNTIME_ENABLED: [undefined, "true", "false", "on", "garbage"],
  DEN_AUTOMATIONS_ENABLED: [undefined, "true", "false", "yes", "garbage"],
  DEN_APP_MCP_SERVERS_ENABLED: [undefined, "", "true", "false", "off", "garbage"],
  DEN_DASHBOARDS_ENABLED: [undefined, "true", "false", "1", "garbage"],
  DEN_OPENWORK_WEB_ENABLED: [undefined, "true", "false", "ON", "garbage"],
  DEN_AUDIT_CAPTURE_ENABLED: [undefined, "true", "false", "garbage"],
  DEN_AUDIT_VISIBILITY_ENABLED: [undefined, "true", "false", "garbage"],
  DEN_AUDIT_SELF_HOSTED_ENABLED: [undefined, "true", "false", "garbage"],
  DEN_SLACK_ASSISTANT_WORKER_ENABLED: [undefined, "true", "false", "0"],
}

const saved = { ...process.env }

afterEach(() => {
  for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key]
  Object.assign(process.env, saved)
})

const probes = { headlessRunnerConfigured: () => false, workbotConfigured: () => false, cloudRuntimeAvailable: () => false }

type Outcome = { ok: true; config: InstanceConfig } | { ok: false }

/** Re-evaluates den-api's env.ts against `vars`, like a fresh process would. */
async function both(vars: Record<string, string | undefined>): Promise<{ den: Outcome; shared: Outcome }> {
  for (const key of [...VARIED, "GATEWAY_ENABLED"]) delete process.env[key]
  Object.assign(process.env, BASE_ENV)
  for (const [key, value] of Object.entries(vars)) if (value !== undefined) process.env[key] = value
  vi.resetModules()
  let den: Outcome
  try {
    const { env } = await import("../env.js")
    den = { ok: true, config: instanceConfigFromDenEnv(env, probes) }
  } catch {
    den = { ok: false }
  }
  let shared: Outcome
  try {
    shared = { ok: true, config: parseInstanceConfig(process.env) }
  } catch {
    shared = { ok: false }
  }
  return { den, shared }
}

function comparable(outcome: Outcome) {
  if (!outcome.ok) return "throws"
  const { config } = outcome
  return {
    orgMode: config.orgMode,
    gatewayEnabled: config.infra.gatewayEnabled,
    freeInferenceConfigured: config.infra.freeInferenceConfigured,
    deprecatedFlags: config.deprecatedFlags,
  }
}

describe("instanceConfigFromDenEnv matches parseInstanceConfig (the gateway's parser)", () => {
  const cases = VARIED.flatMap((name) => VALUES[name].map((value) => ({ name, value })))

  test.each(cases)("$name=$value", async ({ name, value }) => {
    const { den, shared } = await both({ [name]: value })
    expect(comparable(shared)).toEqual(comparable(den))
  })

  test("combined values", async () => {
    const { den, shared } = await both({
      DEN_ORG_MODE: "multi_org",
      DEN_AUTOMATIONS_ENABLED: "true",
      DEN_AUTOMATIONS_RUNTIME_ENABLED: "false",
      DEN_PLAN_GATING_ENABLED: "true",
      DEN_APP_MCP_SERVERS_ENABLED: "0",
      DEN_AUDIT_SELF_HOSTED_ENABLED: "true",
      INFERENCE_FREE_ENABLED: "1",
    })
    expect(den.ok).toBe(true)
    expect(comparable(shared)).toEqual(comparable(den))
  })

  test.each(["https://workbot.example.com", "http://workbot.example.com", "http://localhost:4000", " https://w.example.com/path ", "nope", ""])("workbot origin %j", (url) => {
    expect(parseInstanceConfig({ DEN_WORKBOT_URL: url }).infra.workbotConfigured).toBe(workbotOrigin({ DEN_WORKBOT_URL: url }) !== null)
  })
})
