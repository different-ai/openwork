import { createHash } from "node:crypto"
import { eq } from "@openwork-ee/den-db/drizzle"
import { ManagedDeploymentRunTable, ManagedDeploymentTable } from "@openwork-ee/den-db/schema"
import type { DeploymentConfiguration } from "@openwork/managed-deployments/configuration"
import {
  deploymentConfigurationChangeRecordSchema, deploymentConfigurationLockSchema, deploymentConfigurationViewSchema, normalizeAwsTargetForView,
} from "@openwork/managed-deployments/schema"
import { z } from "zod"
import type { db } from "../db.js"
import type { ManagedDeploymentRelease } from "./config.js"
import { immutableInstallerUrl } from "./release-verifier.js"

export type DeploymentRow = typeof ManagedDeploymentTable.$inferSelect
export type RunRow = typeof ManagedDeploymentRunTable.$inferSelect
export type ConfigurationChangeRecord = z.infer<typeof deploymentConfigurationChangeRecordSchema>
export type ConfigurationLock = z.infer<typeof deploymentConfigurationLockSchema>
type ConfigurationView = z.infer<typeof deploymentConfigurationViewSchema>
type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0]
type Coordinates = Pick<ManagedDeploymentRelease, "version" | "templateUrl" | "bundleUrl" | "bundleSha256">

export type ConfigurationBasis =
  | { lock: ConfigurationLock }
  | {
    lock: null
    base: RunRow
    active: RunRow | null
    pending: RunRow | null
    restoresRunId: string
    gatewayAvailable: boolean
  }

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null"
  return `{${Object.entries(value).filter(([, entry]) => entry !== undefined).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(",")}}`
}

export function configurationChangeRecord(run: RunRow): ConfigurationChangeRecord {
  const record = deploymentConfigurationChangeRecordSchema.safeParse(run.configuration_change)
  if (run.kind !== "configure" || !record.success) throw new Error(`managed deployment run ${run.id} has no configuration change record`)
  return record.data
}

export function recordedConfiguration(row: DeploymentRow): DeploymentConfiguration {
  return { name: row.name, domainName: row.domain_name, ownerEmail: row.owner_email, size: z.literal("small").parse(row.size), target: normalizeAwsTargetForView(row.target) }
}

export function configurationRevision(row: DeploymentRow): string {
  const target = row.provider === "aws" ? normalizeAwsTargetForView(row.target) : row.target
  return createHash("sha256").update(canonicalJson([row.name, row.owner_email, target, row.active_run_id, row.installed_version])).digest("hex")
}

function reachedCloud(run: RunRow) {
  return run.token_hash !== null
}

export function approvalClaimed(run: RunRow) {
  return run.kind === "configure" && run.state === "awaiting_approval" && run.last_seen_at !== null
}

export function heldByCloud(run: RunRow) {
  return run.kind === "configure" && (run.state === "provisioning" || approvalClaimed(run))
}

function sameCoordinates(run: RunRow, release: Coordinates | null) {
  return Boolean(release) && run.version === release?.version && run.template_url === release.templateUrl && run.bundle_url === release.bundleUrl && run.bundle_sha256 === release.bundleSha256
}

export function configurationBasis(row: DeploymentRow, runs: RunRow[], published: Coordinates | null, now: Date): ConfigurationBasis {
  if (row.provider !== "aws") return { lock: "aws_only" }
  if (!row.installed_version) return { lock: "not_installed" }
  const active = runs.find((run) => run.id === row.active_run_id) ?? null
  if (active && heldByCloud(active)) return { lock: "run_in_progress" }
  if (active && active.kind !== "configure" && active.expires_at > now && (active.state === "provisioning" || active.state === "awaiting_approval")) return { lock: "run_in_progress" }
  const base = runs.filter((run) => run.state === "ready").sort((left, right) => right.created_at.getTime() - left.created_at.getTime())[0]
  if (!base || base.version !== row.installed_version) return { lock: "installer_unknown" }
  if (runs.some((run) => run.kind !== "configure" && run.created_at > base.created_at)) return { lock: "unfinished_run" }
  if (!immutableInstallerUrl("aws", base.template_url) || !immutableInstallerUrl("aws", base.bundle_url)) return { lock: "installer_unavailable" }
  const gatewayAvailable = sameCoordinates(base, published)
  const unapproved = active && active.kind === "configure" && !reachedCloud(active) ? active : null
  return {
    lock: null, base, active, gatewayAvailable,
    pending: unapproved?.state === "awaiting_approval" ? unapproved : null,
    restoresRunId: unapproved ? configurationChangeRecord(unapproved).restoresRunId : active?.id ?? base.id,
  }
}

function changeState(run: RunRow, now: Date): NonNullable<ConfigurationView["change"]>["state"] {
  if (run.state === "failed") return "failed"
  if (heldByCloud(run)) return "applying"
  return run.expires_at < now ? "expired" : "awaiting_approval"
}

export function configurationView(row: DeploymentRow, runs: RunRow[], published: Coordinates | null, now: Date): ConfigurationView {
  const basis = configurationBasis(row, runs, published, now)
  const active = runs.find((run) => run.id === row.active_run_id) ?? null
  const change = row.provider === "aws" && active?.kind === "configure" && active.state !== "ready" ? { run: active, record: configurationChangeRecord(active) } : null
  return {
    revision: configurationRevision(row), lock: basis.lock, gatewayAvailable: basis.lock === null && basis.gatewayAvailable,
    change: change ? {
      runId: change.run.id, state: changeState(change.run, now), requestedAt: change.run.created_at.toISOString(), expiresAt: change.run.expires_at.toISOString(),
      changes: change.record.changes,
      requested: {
        provider: "aws", name: row.name, domainName: row.domain_name, ownerEmail: change.record.requested.ownerEmail, size: z.literal("small").parse(row.size),
        target: normalizeAwsTargetForView(change.record.requested.target),
      },
    } : null,
  }
}

export async function withdrawConfigurationChange(tx: Transaction, row: DeploymentRow, run: RunRow): Promise<ConfigurationChangeRecord> {
  const record = configurationChangeRecord(run)
  await tx.update(ManagedDeploymentRunTable).set({ state: "failed" }).where(eq(ManagedDeploymentRunTable.id, run.id))
  await tx.update(ManagedDeploymentTable).set({ active_run_id: record.restoresRunId }).where(eq(ManagedDeploymentTable.id, row.id))
  return record
}

export function appliedConfiguration(run: RunRow) {
  const { requested } = configurationChangeRecord(run)
  return { target: requested.target, owner_email: requested.ownerEmail }
}
