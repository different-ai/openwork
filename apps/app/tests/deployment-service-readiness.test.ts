import { describe, expect, test } from "bun:test"
import { parseDeploymentCapabilities } from "@openwork/types/den/deployment-capabilities"
import { deploymentServiceReadinessSchema, organizationServiceReadinessSchema } from "@openwork/types/den/service-readiness"
import { headlessServiceHealthSchema, workbotServiceHealthSchema } from "@openwork/types/den/service-health"

const checkedAt = "2026-10-19T12:00:00.000Z"
const service = {
  id: "headlessRunner", configured: false, state: "not_configured", reason: "not_configured",
  dependencies: [], checkedAt, lastSuccessAt: null, stale: false,
}
const projected = { version: 2, checkedAt, checking: false, services: [service] }
const adminStatus = { ...service, required: false, missingSettings: [], notes: ["resume_not_configured"], durationMs: null }
const adminSnapshot = { ...projected, server: { version: "commit abc1234", startedAt: checkedAt, startupMs: 1200 }, services: [adminStatus] }

describe("optional deployment diagnostics do not change existing capabilities", () => {
  test("older version-one responses keep the configured Gateway capability", () => {
    expect(parseDeploymentCapabilities({ version: 1, aiGateway: true })).toEqual({ version: 1, aiGateway: true })
  })
  test("valid readiness stays separate from the configured capability", () => {
    expect(parseDeploymentCapabilities({ version: 1, aiGateway: true, serviceReadiness: projected }))
      .toEqual({ version: 1, aiGateway: true, serviceReadiness: projected })
  })
  test("malformed diagnostics cannot turn off a valid existing Gateway", () => {
    const parsed = parseDeploymentCapabilities({ version: 1, aiGateway: true, serviceReadiness: { version: 9000 } })
    expect(parsed.aiGateway).toBe(true)
    expect(parsed.serviceReadiness).toBeUndefined()
  })
  test("an older server's version-one readiness (Slack, resumable answers) is ignored, not misread", () => {
    const legacy = { version: 1, checkedAt, checking: false, services: [service, { ...service, id: "slack", reason: "organization_setup_required" }] }
    const parsed = parseDeploymentCapabilities({ version: 1, aiGateway: true, serviceReadiness: legacy })
    expect(parsed.aiGateway).toBe(true)
    expect(parsed.serviceReadiness).toBeUndefined()
  })
  test("an unsupported base capability version still fails closed", () => {
    expect(parseDeploymentCapabilities({ version: 9000, aiGateway: true })).toEqual({ version: 1, aiGateway: false })
  })
})

describe("diagnostic contracts never carry raw service configuration", () => {
  test("organization projections reject admin-only settings, notes, durations and server facts", () => {
    expect(organizationServiceReadinessSchema.safeParse(projected).success).toBe(true)
    expect(organizationServiceReadinessSchema.safeParse({ ...projected, services: [{ ...service, missingSettings: ["DEN_HEADLESS_RUNNER_TOKEN"] }] }).success).toBe(false)
    expect(organizationServiceReadinessSchema.safeParse({ ...projected, services: [{ ...service, notes: ["email_smtp"] }] }).success).toBe(false)
    expect(organizationServiceReadinessSchema.safeParse({ ...projected, services: [{ ...service, durationMs: 12 }] }).success).toBe(false)
    expect(organizationServiceReadinessSchema.safeParse({ ...projected, server: adminSnapshot.server }).success).toBe(false)
  })
  test("admin diagnostics accept field names but reject a URL or credential value", () => {
    const snapshot = { ...adminSnapshot, services: [{ ...adminStatus, missingSettings: ["DEN_HEADLESS_RUNNER_TOKEN"] }] }
    expect(deploymentServiceReadinessSchema.safeParse(snapshot).success).toBe(true)
    expect(deploymentServiceReadinessSchema.safeParse({ ...snapshot, server: null }).success).toBe(true)
    expect(deploymentServiceReadinessSchema.safeParse({ ...snapshot, services: [{ ...snapshot.services[0], missingSettings: ["https://private.example.test?token=private"] }] }).success).toBe(false)
  })
  test("Slack assistant and resumable answers are no longer services", () => {
    for (const id of ["slack", "durableTurns"]) {
      expect(deploymentServiceReadinessSchema.safeParse({ ...adminSnapshot, services: [{ ...adminStatus, id }] }).success).toBe(false)
      expect(organizationServiceReadinessSchema.safeParse({ ...projected, services: [{ ...service, id }] }).success).toBe(false)
    }
    expect(deploymentServiceReadinessSchema.safeParse({ ...adminSnapshot, services: [{ ...adminStatus, reason: "callback_unverified" }] }).success).toBe(false)
  })
  test("notes are fixed codes and durations are whole non-negative milliseconds", () => {
    expect(deploymentServiceReadinessSchema.safeParse({ ...adminSnapshot, services: [{ ...adminStatus, notes: ["SMTP via smtp.private.example.test"] }] }).success).toBe(false)
    expect(deploymentServiceReadinessSchema.safeParse({ ...adminSnapshot, services: [{ ...adminStatus, durationMs: 41 }] }).success).toBe(true)
    expect(deploymentServiceReadinessSchema.safeParse({ ...adminSnapshot, services: [{ ...adminStatus, durationMs: -1 }] }).success).toBe(false)
    expect(deploymentServiceReadinessSchema.safeParse({ ...adminSnapshot, services: [{ ...adminStatus, durationMs: 1.5 }] }).success).toBe(false)
    expect(deploymentServiceReadinessSchema.safeParse({ ...adminSnapshot, server: { ...adminSnapshot.server, version: "x".repeat(65) } }).success).toBe(false)
  })
  test("arbitrary downstream error text is not a reason code", () => {
    expect(organizationServiceReadinessSchema.safeParse({ ...projected, services: [{ ...service, reason: "upstream printed a private credential" }] }).success).toBe(false)
  })
  test("service health responses contain facts rather than endpoint or token values", () => {
    const runner = { version: 1, service: "headless-runner", modelConfigured: true, resumeConfigured: false, denOriginMatches: null }
    const workbot = { version: 1, service: "workbot", runnerConfigured: true, denOriginMatches: true }
    expect(headlessServiceHealthSchema.safeParse(runner).success).toBe(true)
    expect(workbotServiceHealthSchema.safeParse(workbot).success).toBe(true)
    expect(headlessServiceHealthSchema.safeParse({ ...runner, token: "private" }).success).toBe(false)
    expect(workbotServiceHealthSchema.safeParse({ ...workbot, denApiUrl: "https://private.example.test" }).success).toBe(false)
  })
})
