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

/**
 * Configuration changes at the installed version. A change is one `configure`
 * run and the snapshot stored on it; the deployment's recorded configuration
 * (`name`, `owner_email`, `target`) follows only when that run verifies health.
 */

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
    /** The latest ready run: the installer and configuration that are installed. */
    base: RunRow
    active: RunRow | null
    /** A change whose command has been issued and has not been run, of any age. */
    pending: RunRow | null
    /** The active run to return to if a new change is withdrawn. */
    restoresRunId: string
    /** The installed installer is the published one. */
    gatewayAvailable: boolean
  }

/** MySQL returns JSON object keys in its own order, so equality and the revision never depend on it. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null"
  return `{${Object.entries(value).filter(([, entry]) => entry !== undefined).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(",")}}`
}

/** The snapshot of a configure run. A run without a valid one must never enroll or be recorded as applied. */
export function configurationChangeRecord(run: RunRow): ConfigurationChangeRecord {
  const record = deploymentConfigurationChangeRecordSchema.safeParse(run.configuration_change)
  if (run.kind !== "configure" || !record.success) throw new Error(`managed deployment run ${run.id} has no configuration change record`)
  return record.data
}

/** An AWS deployment's recorded configuration, with its target as views show it. */
export function recordedConfiguration(row: DeploymentRow): DeploymentConfiguration {
  return { name: row.name, domainName: row.domain_name, ownerEmail: row.owner_email, size: z.literal("small").parse(row.size), target: normalizeAwsTargetForView(row.target) }
}

/** Changes whenever the recorded configuration, the installed version or the active run does. */
export function configurationRevision(row: DeploymentRow): string {
  const target = row.provider === "aws" ? normalizeAwsTargetForView(row.target) : row.target
  return createHash("sha256").update(canonicalJson([row.name, row.owner_email, target, row.active_run_id, row.installed_version])).digest("hex")
}

function reachedCloud(run: RunRow) {
  return run.token_hash !== null
}

/**
 * Whether the approval command has claimed this change: it asked OpenWork to
 * confirm the run and was told to go ahead, so `update-stack` may follow.
 *
 * The mark is the run's `last_seen_at`. Only the customer's side writes that
 * column: the approval check while the run awaits approval, then enrollment and
 * each installer milestone. On a configure run that still awaits approval it can
 * therefore only be the approval check's mark. It is set once, under the
 * deployment and run locks, and nothing clears it: a claimed change leaves this
 * state only by enrolling.
 */
export function approvalClaimed(run: RunRow) {
  return run.kind === "configure" && run.state === "awaiting_approval" && run.last_seen_at !== null
}

/**
 * A change the customer's AWS account may be applying: claimed by its approval
 * command or enrolled, with no final report. A passed deadline says nothing about
 * what AWS did or is still doing, so such a run holds the deployment at any age:
 * no other change, install, retry or update is prepared until it reports
 * success or failure.
 */
export function heldByCloud(run: RunRow) {
  return run.kind === "configure" && (run.state === "provisioning" || approvalClaimed(run))
}

function sameCoordinates(run: RunRow, release: Coordinates | null) {
  return Boolean(release) && run.version === release?.version && run.template_url === release.templateUrl && run.bundle_url === release.bundleUrl && run.bundle_sha256 === release.bundleSha256
}

/**
 * Whether the deployment's configuration can change now and, when it can, the
 * installer a change re-runs. `runs` is every run of the deployment.
 */
export function configurationBasis(row: DeploymentRow, runs: RunRow[], published: Coordinates | null, now: Date): ConfigurationBasis {
  if (row.provider !== "aws") return { lock: "aws_only" }
  if (!row.installed_version) return { lock: "not_installed" }
  const active = runs.find((run) => run.id === row.active_run_id) ?? null
  if (active && heldByCloud(active)) return { lock: "run_in_progress" }
  if (active && active.kind !== "configure" && active.expires_at > now && (active.state === "provisioning" || active.state === "awaiting_approval")) return { lock: "run_in_progress" }
  const base = runs.filter((run) => run.state === "ready").sort((left, right) => right.created_at.getTime() - left.created_at.getTime())[0]
  if (!base || base.version !== row.installed_version) return { lock: "installer_unknown" }
  // An install, retry or update prepared since then may have replaced the installer
  // or the recorded target, whether or not it was approved.
  if (runs.some((run) => run.kind !== "configure" && run.created_at > base.created_at)) return { lock: "unfinished_run" }
  // Re-running the installed release needs the same bytes, so both objects must be exact object
  // versions. The published release is no exception: its unversioned URLs can be republished too.
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
  // Claimed or enrolled, at any age: it is not known to have failed and cannot be replaced or discarded.
  if (heldByCloud(run)) return "applying"
  return run.expires_at < now ? "expired" : "awaiting_approval"
}

/** The `configuration` block of a deployment view. */
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

/**
 * Ends a change that has not reached the cloud. The caller holds the
 * deployment row lock; enrollment then refuses the run because it is no longer active.
 */
export async function withdrawConfigurationChange(tx: Transaction, row: DeploymentRow, run: RunRow): Promise<ConfigurationChangeRecord> {
  const record = configurationChangeRecord(run)
  await tx.update(ManagedDeploymentRunTable).set({ state: "failed" }).where(eq(ManagedDeploymentRunTable.id, run.id))
  await tx.update(ManagedDeploymentTable).set({ active_run_id: record.restoresRunId }).where(eq(ManagedDeploymentTable.id, row.id))
  return record
}

/** What the deployment records once a configure run has verified health. */
export function appliedConfiguration(run: RunRow) {
  const { requested } = configurationChangeRecord(run)
  return { target: requested.target, owner_email: requested.ownerEmail }
}
