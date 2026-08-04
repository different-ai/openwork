import { afterAll, beforeAll, beforeEach, expect, mock, test } from "bun:test"

type OrganizationRecord = {
  id: string
  name: string
  slug: string
  metadata: Record<string, unknown> | null
}

type UpdateValues = {
  metadata?: Record<string, unknown>
}

type AdminToolResult = {
  isError?: boolean
  content: { type: "text"; text: string }[]
}

type CapabilityInput = {
  org: string
  capability: "cloud"
  enabled: boolean
}

let selectBatches: OrganizationRecord[][] = []
let updates: UpdateValues[] = []
let adminCapabilities: typeof import("../src/mcp/admin-capabilities.js") | null = null
let testUnavailable: string | null = null

function seedRequiredEnv() {
  process.env.DATABASE_URL = process.env.DATABASE_URL ?? "mysql://root:password@127.0.0.1:3306/openwork_test"
  process.env.DEN_DB_ENCRYPTION_KEY = process.env.DEN_DB_ENCRYPTION_KEY ?? "x".repeat(32)
  process.env.BETTER_AUTH_SECRET = process.env.BETTER_AUTH_SECRET ?? "y".repeat(32)
  process.env.BETTER_AUTH_URL = process.env.BETTER_AUTH_URL ?? "http://127.0.0.1:8790"
  process.env.DEN_ORG_MODE = "multi_org"
}

function shouldRunFocusedCoverage() {
  const testFiles = process.argv.filter((argument) => argument.endsWith(".test.ts"))
  return testFiles.length <= 2 && testFiles.some((argument) => argument.endsWith("admin-mcp-org-capability.test.ts"))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function installDbMock() {
  mock.module("../src/db.js", () => ({
    db: {
      select: () => ({
        from: () => ({
          where: () => ({
            limit: () => Promise.resolve(selectBatches.shift() ?? []),
          }),
        }),
      }),
      update: () => ({
        set: (values: UpdateValues) => ({
          where: () => {
            updates.push(values)
            return Promise.resolve()
          },
        }),
      }),
      execute: () => Promise.resolve([]),
    },
  }))
}

async function configureAdminCapabilityEnv() {
  const { env } = await import("../src/env.js")
  env.orgMode = "multi_org"
}

function capabilitiesModule() {
  if (!adminCapabilities) {
    throw new Error("admin capabilities module not initialized")
  }
  return adminCapabilities
}

function organizationRecord(input: {
  id: string
  name: string
  slug: string
  metadata?: Record<string, unknown> | null
}): OrganizationRecord {
  return {
    id: input.id,
    name: input.name,
    slug: input.slug,
    metadata: input.metadata ?? null,
  }
}

function resultText(result: AdminToolResult) {
  return result.content.map((entry) => entry.text).join("\n")
}

function payloadRecord(result: AdminToolResult) {
  const payload: unknown = JSON.parse(resultText(result))
  if (!isRecord(payload)) {
    throw new Error("Expected JSON object payload")
  }
  return payload
}

function recordValue(record: Record<string, unknown>, key: string) {
  const value = record[key]
  if (!isRecord(value)) {
    throw new Error(`Expected ${key} to be an object`)
  }
  return value
}

function latestMetadata() {
  const latest = updates[updates.length - 1]
  if (!latest || !isRecord(latest.metadata)) {
    throw new Error("Expected metadata update")
  }
  return latest.metadata
}

async function callSetOrgCapability(input: CapabilityInput) {
  const result = await capabilitiesModule().executeAdminCapability("admin:den_set_org_capability", input)
  if (!result) {
    throw new Error("Expected den_set_org_capability result")
  }
  return result
}

function skipIfUnavailable() {
  if (!testUnavailable) {
    return false
  }
  console.warn(`admin MCP org capability coverage skipped: ${testUnavailable}`)
  return true
}

beforeAll(async () => {
  if (!shouldRunFocusedCoverage()) {
    testUnavailable = "aggregate suite run; covered by the focused admin MCP org capability test"
    return
  }

  seedRequiredEnv()
  await configureAdminCapabilityEnv()
  installDbMock()
  adminCapabilities = await import("../src/mcp/admin-capabilities.js")
})

beforeEach(() => {
  selectBatches = []
  updates = []
})

afterAll(() => {
  mock.restore()
})

test("den_set_org_capability exposes the closed cloud input schema", async () => {
  if (skipIfUnavailable()) return

  const matches = await capabilitiesModule().searchAdminCapabilities("set org capability cloud", 10)
  const match = matches.find((candidate) => candidate.name === "admin:den_set_org_capability")

  expect(match).toBeDefined()
  if (!match || !isRecord(match.argumentsSchema) || !isRecord(match.argumentsSchema.properties)) {
    throw new Error("Expected admin:den_set_org_capability arguments schema")
  }

  expect(match.hasBody).toBe(true)
  expect(match.argumentsSchema.properties.org).toMatchObject({ type: "string" })
  expect(match.argumentsSchema.properties.capability).toMatchObject({ enum: ["cloud"] })
  expect(match.argumentsSchema.properties.enabled).toMatchObject({ type: "boolean" })
})

test("enables cloud when capabilities are absent and preserves other metadata", async () => {
  if (skipIfUnavailable()) return

  const organization = organizationRecord({
    id: "org_cloud_absent",
    name: "Cloud Absent Org",
    slug: "cloud-absent",
    metadata: { brandAppName: "Cloud Absent" },
  })
  selectBatches = [[organization]]

  const result = await callSetOrgCapability({ org: organization.slug, capability: "cloud", enabled: true })

  expect(result.isError).toBeUndefined()
  expect(payloadRecord(result)).toMatchObject({
    ok: true,
    noOp: false,
    organization: { id: organization.id, name: organization.name, slug: organization.slug },
    capability: "cloud",
    previousEffectiveValue: false,
    newEffectiveValue: true,
  })
  expect(updates).toHaveLength(1)
  const metadata = latestMetadata()
  expect(metadata.brandAppName).toBe("Cloud Absent")
  expect(recordValue(metadata, "capabilities").cloud).toBe(true)
})

test("enables cloud by merging with existing metadata and capabilities", async () => {
  if (skipIfUnavailable()) return

  const organization = organizationRecord({
    id: "org_cloud_merge",
    name: "Cloud Merge Org",
    slug: "cloud-merge",
    metadata: {
      billingNote: "preserve me",
      capabilities: { installLinks: true, futureCapability: "keep" },
    },
  })
  selectBatches = [[organization]]

  const result = await callSetOrgCapability({ org: organization.slug, capability: "cloud", enabled: true })

  expect(result.isError).toBeUndefined()
  expect(payloadRecord(result)).toMatchObject({ previousEffectiveValue: false, newEffectiveValue: true })
  const metadata = latestMetadata()
  expect(metadata.billingNote).toBe("preserve me")
  expect(recordValue(metadata, "capabilities")).toMatchObject({
    installLinks: true,
    futureCapability: "keep",
    cloud: true,
  })
})

test("disables cloud by removing the key while preserving other capabilities", async () => {
  if (skipIfUnavailable()) return

  const organization = organizationRecord({
    id: "org_cloud_disable",
    name: "Cloud Disable Org",
    slug: "cloud-disable",
    metadata: {
      capabilities: { cloud: true, installLinks: true, mcpConnections: false, futureCapability: "keep" },
    },
  })
  selectBatches = [[organization]]

  const result = await callSetOrgCapability({ org: organization.slug, capability: "cloud", enabled: false })

  expect(result.isError).toBeUndefined()
  expect(payloadRecord(result)).toMatchObject({ previousEffectiveValue: true, newEffectiveValue: false })
  const capabilities = recordValue(latestMetadata(), "capabilities")
  expect("cloud" in capabilities).toBe(false)
  expect(capabilities).toMatchObject({ installLinks: true, mcpConnections: false, futureCapability: "keep" })
})

test("enable/enable and disable/disable are idempotent", async () => {
  if (skipIfUnavailable()) return

  const organization = organizationRecord({
    id: "org_cloud_idempotent",
    name: "Cloud Idempotent Org",
    slug: "cloud-idempotent",
    metadata: { capabilities: { installLinks: true } },
  })

  selectBatches = [[organization]]
  const firstEnable = await callSetOrgCapability({ org: organization.slug, capability: "cloud", enabled: true })
  organization.metadata = latestMetadata()
  expect(payloadRecord(firstEnable)).toMatchObject({ noOp: false, previousEffectiveValue: false, newEffectiveValue: true })

  updates = []
  selectBatches = [[organization]]
  const secondEnable = await callSetOrgCapability({ org: organization.slug, capability: "cloud", enabled: true })
  expect(payloadRecord(secondEnable)).toMatchObject({ noOp: true, previousEffectiveValue: true, newEffectiveValue: true })
  expect(updates).toHaveLength(0)

  selectBatches = [[organization]]
  const firstDisable = await callSetOrgCapability({ org: organization.slug, capability: "cloud", enabled: false })
  organization.metadata = latestMetadata()
  expect(payloadRecord(firstDisable)).toMatchObject({ noOp: false, previousEffectiveValue: true, newEffectiveValue: false })

  updates = []
  selectBatches = [[organization]]
  const secondDisable = await callSetOrgCapability({ org: organization.slug, capability: "cloud", enabled: false })
  expect(payloadRecord(secondDisable)).toMatchObject({ noOp: true, previousEffectiveValue: false, newEffectiveValue: false })
  expect(updates).toHaveLength(0)
})

test("ambiguous organization name returns candidates and does not write", async () => {
  if (skipIfUnavailable()) return

  const first = organizationRecord({ id: "org_cloud_ambiguous_one", name: "Ambiguous Cloud Org", slug: "ambiguous-cloud-one" })
  const second = organizationRecord({ id: "org_cloud_ambiguous_two", name: "Ambiguous Cloud Org Labs", slug: "ambiguous-cloud-two" })
  selectBatches = [[], [first, second]]

  const result = await callSetOrgCapability({ org: "Ambiguous Cloud Org", capability: "cloud", enabled: true })

  expect(result.isError).toBeUndefined()
  expect(payloadRecord(result)).toMatchObject({
    ok: false,
    error: "ambiguous_organization",
    candidates: [
      { id: first.id, name: first.name, slug: first.slug },
      { id: second.id, name: second.name, slug: second.slug },
    ],
  })
  expect(updates).toHaveLength(0)
})

test("unknown organization returns a clear error and does not write", async () => {
  if (skipIfUnavailable()) return

  selectBatches = [[], []]

  const result = await callSetOrgCapability({ org: "missing-cloud-org", capability: "cloud", enabled: true })

  expect(result.isError).toBe(true)
  expect(resultText(result)).toContain('No organization matching "missing-cloud-org"')
  expect(updates).toHaveLength(0)
})
