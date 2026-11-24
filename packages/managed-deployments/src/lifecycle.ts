import { createHash, timingSafeEqual } from "node:crypto"
import { deploymentStepSchema, type DeploymentEventInput, type DeploymentHealth, type HealthCheck } from "@openwork/managed-deployments/schema"

export { compareInstallerRelease, compareVersions, installerRevisionOf } from "@openwork/managed-deployments/installer-release"

/** Health reports arrive every 5 minutes; three missed reports mean not reporting. */
export const HEALTH_STALE_AFTER_MS = 16 * 60 * 1000
const CRITICAL_CHECKS = new Set<HealthCheck["id"]>(["api_health", "database_ready", "services_running", "web_available", "ai_gateway_available"])

export function hashToken(token: string) {
  return createHash("sha256").update(token).digest("hex")
}

export function tokenMatches(storedHash: string | null, token: string) {
  if (!storedHash || !/^[a-f0-9]{64}$/.test(storedHash)) return false
  return timingSafeEqual(new Uint8Array(Buffer.from(storedHash, "hex")), new Uint8Array(Buffer.from(hashToken(token), "hex")))
}

/** Milestones arrive strictly in order; a failure carries an allowlisted code. */
export function validateEventTransition(input: DeploymentEventInput, lastSequence: number) {
  if (input.sequence !== lastSequence + 1) return false
  if (deploymentStepSchema.options[lastSequence] !== input.step) return false
  return input.outcome === "failed" ? Boolean(input.errorCode) : !input.errorCode
}

/** Summarize the latest report; a stale report keeps its checks but is not current. */
export function summarizeHealth(input: { checks: HealthCheck[]; reportedAt: Date | null; version: string | null }, now = new Date()): DeploymentHealth {
  const reportedAt = input.reportedAt ? input.reportedAt.toISOString() : null
  if (!input.reportedAt) return { state: "awaiting_report", reportedAt, version: input.version, checks: input.checks }
  if (now.getTime() - input.reportedAt.getTime() > HEALTH_STALE_AFTER_MS) return { state: "not_reporting", reportedAt, version: input.version, checks: input.checks }
  const failing = input.checks.filter((check) => check.status === "failing")
  const state = failing.some((check) => CRITICAL_CHECKS.has(check.id)) ? "down"
    : failing.length || input.checks.some((check) => check.status === "warning" || check.status === "unknown") ? "degraded"
      : "operational"
  return { state, reportedAt, version: input.version, checks: input.checks }
}
