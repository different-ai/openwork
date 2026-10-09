import { createHash, timingSafeEqual } from "node:crypto"
import { deploymentStepSchema, type DeploymentEventInput, type DeploymentHealth, type HealthCheck } from "./schema.js"

/** Health reports arrive every 5 minutes; three missed reports mean not reporting. */
export const HEALTH_STALE_AFTER_MS = 16 * 60 * 1000
const CRITICAL_CHECKS = new Set<HealthCheck["id"]>(["api_health", "database_ready", "services_running", "web_available"])

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

type ParsedVersion = { release: number[]; prerelease: string[] }
function parseVersion(value: string): ParsedVersion | null {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(value)
  if (!match) return null
  return { release: [Number(match[1]), Number(match[2]), Number(match[3])], prerelease: match[4]?.split(".") ?? [] }
}

/** Semantic version comparison; returns null when either value is not a version. */
export function compareVersions(left: string, right: string): number | null {
  const a = parseVersion(left)
  const b = parseVersion(right)
  if (!a || !b) return null
  for (let index = 0; index < 3; index += 1) {
    if (a.release[index] !== b.release[index]) return a.release[index] < b.release[index] ? -1 : 1
  }
  if (!a.prerelease.length || !b.prerelease.length) return a.prerelease.length === b.prerelease.length ? 0 : a.prerelease.length ? -1 : 1
  for (let index = 0; index < Math.max(a.prerelease.length, b.prerelease.length); index += 1) {
    const x = a.prerelease[index]
    const y = b.prerelease[index]
    if (x === undefined) return -1
    if (y === undefined) return 1
    if (x === y) continue
    const xn = /^\d+$/.test(x) ? Number(x) : null
    const yn = /^\d+$/.test(y) ? Number(y) : null
    if (xn !== null && yn !== null) return xn < yn ? -1 : 1
    if (xn !== null) return -1
    if (yn !== null) return 1
    return x < y ? -1 : 1
  }
  return 0
}
