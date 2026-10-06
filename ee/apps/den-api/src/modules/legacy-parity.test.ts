import {
  createModuleRuntime,
  describeDeployment,
  extractLegacyOrgInputs,
  KNOWN_LEGACY_DIVERGENCES,
  LEGACY_CAPABILITY_KEYS,
  legacyDisabledModules,
  matchKnownDivergence,
  type OrgModuleRow,
} from "@openwork-ee/den-modules"
import { createMemoryLogger, testOrganizationModules } from "@openwork-ee/den-modules/testing"
import { afterEach, describe, expect, test, vi } from "vitest"

/**
 * The main behavior-identity proof for the legacy adapter (plan W0-03,
 * 00-legacy-mapping §H): for a generated matrix of org metadata and instance
 * env, every den-api helper (registered as a shadow oracle) equals the
 * resolver's answer, except exactly the combinations a
 * `KNOWN_LEGACY_DIVERGENCES` entry describes.
 */

const BASE_ENV: Record<string, string> = {
  DEN_DB_ENCRYPTION_KEY: "test-den-db-encryption-key-0123456789abcdef",
  BETTER_AUTH_SECRET: "test-better-auth-secret-0123456789abcdef",
  BETTER_AUTH_URL: "http://localhost:3005",
  DATABASE_URL: "mysql://root:password@127.0.0.1:3306/openwork_den_test",
  OPENWORK_DEV_MODE: "1",
}

const RUNNER = { DEN_HEADLESS_RUNNER_URL: "http://127.0.0.1:9999", DEN_HEADLESS_RUNNER_TOKEN: "runner-token-0123456789abcdef0123456789" }
const CLOUD_RUNTIME = { CLOUD_RUNTIME_PROVIDER: "daytona", DAYTONA_API_KEY: "test-daytona-key" }

const ENV_VARIANTS: Array<{ name: string; vars: Record<string, string>; codes: string[] }> = [
  { name: "self-hosted defaults", vars: {}, codes: ["G2", "G5"] },
  { name: "cloud defaults with runner and Workbot", vars: { DEN_ORG_MODE: "multi_org", DEN_WORKBOT_URL: "https://workbot.example.com", INFERENCE_FREE_ENABLED: "true", ...RUNNER }, codes: ["G2", "G3"] },
  {
    name: "cloud with every legacy flag flipped",
    vars: {
      DEN_ORG_MODE: "multi_org",
      DEN_PLAN_GATING_ENABLED: "true",
      DEN_OPENWORK_WEB_ENABLED: "true",
      DEN_APP_MCP_SERVERS_ENABLED: "false",
      DEN_AUTOMATIONS_RUNTIME_ENABLED: "false",
      DEN_AUDIT_VISIBILITY_ENABLED: "false",
      DEN_AUDIT_CAPTURE_ENABLED: "false",
      DEN_AUDIT_SELF_HOSTED_ENABLED: "true",
      DEN_WORKBOT_URL: "https://workbot.example.com",
      INFERENCE_FREE_ENABLED: "true",
      ...RUNNER,
      ...CLOUD_RUNTIME,
    },
    codes: ["G11", "G2", "G3", "G4"],
  },
  { name: "self-hosted with gating, free inference and runner", vars: { DEN_PLAN_GATING_ENABLED: "true", INFERENCE_FREE_ENABLED: "true", DEN_WORKBOT_URL: "http://localhost:4000", ...RUNNER }, codes: ["G2", "G3", "G5"] },
  { name: "explicit self-hosted deployment on multi_org", vars: { DEN_ORG_MODE: "multi_org", DEN_DEPLOYMENT: "self_hosted", DEN_PLAN_GATING_ENABLED: "true", ...RUNNER }, codes: ["G2", "G5"] },
]

const ENV_KEYS = [...new Set(ENV_VARIANTS.flatMap((variant) => Object.keys(variant.vars)))]

function seeded(seed: number): () => number {
  let state = seed
  return () => {
    state = (state + 0x6d2b79f5) | 0
    let value = Math.imul(state ^ (state >>> 15), 1 | state)
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296
  }
}

const TRI = [true, false, undefined]
const TIERS = ["free", "team", "enterprise", undefined]

function metadataMatrix(): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [{}]
  for (const key of LEGACY_CAPABILITY_KEYS) for (const value of [true, false, "true", 1]) out.push({ capabilities: { [key]: value } })
  for (const tier of TIERS) out.push({ plan: { tier } })
  for (const connectEnabled of TRI) for (const mcpConnectionsEnabled of TRI) for (const mcpConnections of TRI) {
    out.push({ connectEnabled, mcpConnectionsEnabled, capabilities: { mcpConnections } })
  }
  out.push({ complimentaryAccess: { openworkWeb: true } }, { complimentaryAccess: { openworkWeb: "yes" } })
  const random = seeded(5683)
  const pick = <T,>(values: readonly T[]): T => values[Math.floor(random() * values.length)] ?? values[0]
  for (let index = 0; index < 1500; index++) {
    const capabilities = Object.fromEntries(LEGACY_CAPABILITY_KEYS.map((key) => [key, pick(TRI)]))
    out.push({
      capabilities,
      plan: { tier: pick(TIERS) },
      connectEnabled: pick(TRI),
      mcpConnectionsEnabled: pick(TRI),
      ...(random() < 0.3 ? { complimentaryAccess: { openworkWeb: true } } : {}),
    })
  }
  return out
}

const saved = { ...process.env }

afterEach(() => {
  for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key]
  Object.assign(process.env, saved)
})

describe("legacy parity: den-api helpers vs the resolver", () => {
  const metadata = metadataMatrix()

  test.each(ENV_VARIANTS)("$name", async ({ vars, codes }) => {
    for (const key of ENV_KEYS) delete process.env[key]
    Object.assign(process.env, BASE_ENV, vars)
    vi.resetModules()
    const { env } = await import("../env.js")
    const { createDenApiLegacyOracles } = await import("./legacy-oracles.js")
    const { instanceConfigFromDenEnv } = await import("./instance-config.js")
    const { headlessRunnerConfig } = await import("../headless-runner/client.js")
    const { workbotOrigin } = await import("../workbot/config.js")
    const { cloudRuntimeAvailable } = await import("../workers/cloud-runtime.js")

    const instance = instanceConfigFromDenEnv(env, {
      headlessRunnerConfigured: () => headlessRunnerConfig(process.env) !== null,
      workbotConfigured: () => workbotOrigin(process.env) !== null,
      cloudRuntimeAvailable: () => cloudRuntimeAvailable(),
    })
    const { deployment } = describeDeployment({ DEN_DEPLOYMENT: env.modules.deployment }, env.orgMode)
    const logger = createMemoryLogger()
    const modules = createModuleRuntime({
      deployment,
      instance,
      logger,
      isProduction: false,
      shadow: { enabled: true, maxLogsPerMinute: Number.MAX_SAFE_INTEGER, perKeyIntervalMs: 0 },
    })
    const oracles = createDenApiLegacyOracles()
    modules.registerLegacyOracles(oracles)

    let compared = 0
    const divergencesSeen = new Set<string>()
    metadata.forEach((entry, index) => {
      const disabled = legacyDisabledModules(extractLegacyOrgInputs(entry))
      const rows: OrgModuleRow[] = [
        { id: `org_${index}_null`, metadata: entry, modules: null },
        { id: `org_${index}_column`, metadata: JSON.stringify(entry), modules: testOrganizationModules({ disabled }) },
      ]
      for (const row of rows) {
        const mismatches = new Set(modules.shadowCompareNow(row))
        compared += oracles.length
        const inputs = extractLegacyOrgInputs(row.metadata)
        for (const oracle of oracles) {
          const divergence = matchKnownDivergence(oracle.moduleId, { inputs, config: instance, deployment, disabled })
          const legacy = oracle.legacy(row)
          // A divergence describes exactly when today says "on" and the resolver can't agree.
          const expectedMismatch = divergence !== null && legacy
          expect(mismatches.has(oracle.id), `${oracle.id} ${JSON.stringify(entry)} divergence=${divergence?.code ?? "none"}`).toBe(expectedMismatch)
          if (divergence && legacy) divergencesSeen.add(divergence.code)
        }
      }
    })

    expect(logger.named("den_modules_shadow_mismatch").filter((event) => event.level === "warn")).toEqual([])
    expect(logger.named("den_modules_legacy_mirror_mismatch")).toEqual([])
    expect(logger.named("den_modules_shadow_failed")).toEqual([])
    expect(compared).toBeGreaterThan(1000)
    // Every expected divergence shows up in this variant's matrix, and only known codes do.
    expect([...divergencesSeen].sort()).toEqual(codes)
    for (const code of divergencesSeen) expect(KNOWN_LEGACY_DIVERGENCES.map((divergence) => divergence.code)).toContain(code)
  }, 120_000)
})
