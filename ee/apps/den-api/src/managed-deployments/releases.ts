import { randomUUID } from "node:crypto"
import { and, desc, eq, gt } from "@openwork-ee/den-db/drizzle"
import { ManagedInstallerChangeTable, ManagedInstallerConfigTable, ManagedInstallerValidationTable } from "@openwork-ee/den-db/schema"
import { managedInstallerCoordinatesSchema, managedInstallerValidationSchema, type ManagedInstallerApprovalMode, type ManagedInstallerValidation, type ManagedInstallerProvider, type ManagedInstallerProviderState, type ManagedInstallerQualification, type ManagedInstallerReport } from "@openwork/types/den/managed-installer-releases"
import { db } from "../db.js"
import { awsRelease, gcpRelease, managedDeploymentApiOrigin, releaseReadiness, type ManagedDeploymentRelease } from "./config.js"
import { immutableInstallerUrl, inferInstallerSource, installerSourceBaseUrl, InstallerReleaseError, sha256, verifyFrozenInstallerRelease, verifyInstallerRelease } from "./release-verifier.js"

type Config = typeof ManagedInstallerConfigTable.$inferSelect
type ValidationRow = typeof ManagedInstallerValidationTable.$inferSelect
/**
 * Single-administrator approval removes the second-administrator check on the default installer
 * for every new install, so one administrator session must not be able to turn it on by itself.
 * Only the deployment operator can allow it; without that, a saved `platform_admin` policy is inactive.
 */
const SINGLE_ADMIN_APPROVAL_ENV = "DEN_MANAGED_INSTALLER_SINGLE_ADMIN_APPROVAL"
const singleAdminApprovalAllowed = () => process.env[SINGLE_ADMIN_APPROVAL_ENV] === "true"
const savedApprovalMode = (row?: Config): ManagedInstallerApprovalMode => row?.approval_mode === "platform_admin" ? "platform_admin" : "independent_admin"
const approvalMode = (row?: Config): ManagedInstallerApprovalMode => savedApprovalMode(row) === "platform_admin" && singleAdminApprovalAllowed() ? "platform_admin" : "independent_admin"
function validationForCaller(row: ValidationRow, mode: ManagedInstallerApprovalMode, actor?: string): ManagedInstallerValidation | null {
  const parsed = managedInstallerValidationSchema.safeParse({ ...row.validation, verifiedBy: row.actor, canPin: Boolean(actor && (mode === "platform_admin" || row.actor !== actor)) })
  return parsed.success ? parsed.data : null
}
function requireApproval(mode: ManagedInstallerApprovalMode, verifier: string, actor: string) {
  if (mode === "independent_admin" && verifier === actor) throw new InstallerReleaseError("independent_approval_required", "A different platform administrator must review and pin this release. Ask another platform administrator to open this page, or explicitly change the approval policy before validating again.", 403)
}
type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0]
const providers: ManagedInstallerProvider[] = ["aws", "gcp"]
const sameCoordinates = (a: { version: string, templateUrl: string, bundleUrl: string, bundleSha256: string }, b: { version: string, templateUrl: string, bundleUrl: string, bundleSha256: string }) => a.version === b.version && a.templateUrl === b.templateUrl && a.bundleUrl === b.bundleUrl && a.bundleSha256 === b.bundleSha256
function compareReleaseVersions(next: string, current: string) {
  const a = /^(\d+)\.(\d+)\.(\d+)$/.exec(next)
  const b = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(current)
  if (!a || !b) return null
  for (const index of [1, 2, 3]) {
    const left = a[index]
    const right = b[index]
    if (!left || !right) return null
    if (BigInt(left) !== BigInt(right)) return BigInt(left) < BigInt(right) ? -1 : 1
  }
  return b[4] ? 1 : 0
}
const environmentRelease = (provider: ManagedInstallerProvider) => provider === "aws" ? awsRelease() : gcpRelease()

/** The release prefix the deployment's environment release came from, if any. */
function environmentSourceBaseUrl(provider: ManagedInstallerProvider) {
  const prefix = `DEN_MANAGED_DEPLOYMENT_${provider.toUpperCase()}`
  const template = environmentRelease(provider)?.templateUrl ?? (process.env[`${prefix}_RELEASE`] === undefined ? process.env[`${prefix}_TEMPLATE_URL`] : undefined)
  return inferInstallerSource(provider, template)
}

/** The bucket a normalized release source is in: the regional S3 host, or the Google Cloud Storage bucket path. */
function bucketRoot(provider: ManagedInstallerProvider, base: string) {
  const url = new URL(base)
  return provider === "aws" ? `${url.origin}/` : `${url.origin}/${url.pathname.split("/")[1]}/`
}

/**
 * The pinned template becomes every new install's CloudFormation stack or Cloud Shell tutorial, so an
 * administrator may only choose sources the operator trusts: the environment release's bucket, plus the
 * prefixes listed in DEN_MANAGED_DEPLOYMENT_<PROVIDER>_SOURCE_ALLOWLIST (comma-separated).
 */
function requireAllowedSource(provider: ManagedInstallerProvider, base: string) {
  const variable = `DEN_MANAGED_DEPLOYMENT_${provider.toUpperCase()}_SOURCE_ALLOWLIST`
  const environment = environmentSourceBaseUrl(provider)
  const listed = (process.env[variable] ?? "").split(",").map((entry) => entry.trim()).filter(Boolean).flatMap((entry) => {
    try { return [installerSourceBaseUrl(provider, entry)] } catch { return [] }
  })
  const allowed = [...(environment ? [bucketRoot(provider, environment)] : []), ...listed]
  if (!allowed.some((prefix) => base.startsWith(prefix))) {
    throw new InstallerReleaseError("source_not_allowed", `Choose a release source in this deployment's own release bucket. The deployment operator can allow other release prefixes with ${variable}.`, 400)
  }
}

const emptyRevision = (provider: ManagedInstallerProvider) => provider === "aws" ? "00000000-0000-4000-8000-000000000001" : "00000000-0000-4000-8000-000000000002"
export function installerProviderState(provider: ManagedInstallerProvider, row?: Config): ManagedInstallerProviderState {
  if (row?.revision === emptyRevision(provider) && !row.source_base_url && !row.release && approvalMode(row) === "independent_admin") row = undefined
  const environment = environmentRelease(provider)
  const readiness = releaseReadiness(provider)
  const parsed = row?.release == null ? null : managedInstallerCoordinatesSchema.safeParse(row.release)
  let release = parsed ? parsed.success ? parsed.data : null : environment ? { version: environment.version, templateUrl: environment.templateUrl, bundleUrl: environment.bundleUrl, bundleSha256: environment.bundleSha256 } : null
  let source: ManagedInstallerProviderState["source"] = row?.release != null ? parsed?.success ? "admin" : "invalid_configuration" : environment ? "environment" : readiness.reason === "invalid_configuration" ? "invalid_configuration" : "unconfigured"
  const prefix = `DEN_MANAGED_DEPLOYMENT_${provider.toUpperCase()}`
  let sourceBaseUrl = row?.source_base_url ?? environmentSourceBaseUrl(provider)
  if (sourceBaseUrl) {
    try { sourceBaseUrl = installerSourceBaseUrl(provider, sourceBaseUrl) } catch { sourceBaseUrl = null; release = null; source = "invalid_configuration" }
  }
  if (row?.release != null && release && (!managedDeploymentApiOrigin() || !immutableInstallerUrl(provider, release.templateUrl) || !immutableInstallerUrl(provider, release.bundleUrl))) { release = null; source = "invalid_configuration" }
  const environmentRevision = [process.env[`${prefix}_RELEASE`], process.env[`${prefix}_TEMPLATE_URL`], process.env[`${prefix}_BUNDLE_URL`], process.env[`${prefix}_BUNDLE_SHA256`], process.env[`${prefix}_VERSION`], process.env.DEN_API_PUBLIC_URL]
  return { provider, release, source, available: release !== null, sourceBaseUrl, revision: sha256(JSON.stringify({ row: row ?? null, environmentRevision, approvalMode: approvalMode(row) })), updatedAt: row?.updated_at.toISOString() ?? null, approvalMode: approvalMode(row), pendingValidation: null }
}

/** Always primary: settings must be visible to launches and updates across API replicas. Missing schema fails closed. */
export async function effectiveInstallerRelease(provider: ManagedInstallerProvider): Promise<ManagedDeploymentRelease | null> {
  const [row] = await db.$primary.select().from(ManagedInstallerConfigTable).where(eq(ManagedInstallerConfigTable.provider, provider))
  const state = installerProviderState(provider, row)
  const apiOrigin = managedDeploymentApiOrigin()
  return state.release && apiOrigin ? { ...state.release, apiOrigin } : null
}

export async function effectiveInstallerReadiness(provider: ManagedInstallerProvider) {
  const [row] = await db.$primary.select().from(ManagedInstallerConfigTable).where(eq(ManagedInstallerConfigTable.provider, provider))
  const state = installerProviderState(provider, row)
  if (!row?.release && state.source !== "invalid_configuration") return releaseReadiness(provider)
  return { provider, available: state.available, version: state.release?.version ?? null, reason: state.available ? "ready" : "invalid_configuration", missingFields: state.available ? [] : ["admin_managed_release"] }
}

export async function installerReleaseReport(actor?: string): Promise<ManagedInstallerReport> {
  const [rows, changes] = await Promise.all([
    db.$primary.select().from(ManagedInstallerConfigTable),
    db.$primary.select().from(ManagedInstallerChangeTable).orderBy(desc(ManagedInstallerChangeTable.created_at), desc(ManagedInstallerChangeTable.id)).limit(100),
  ])
  const states = await Promise.all(providers.map(async (provider) => {
    const state = installerProviderState(provider, rows.find((row) => row.provider === provider))
    const [pending] = await db.$primary.select().from(ManagedInstallerValidationTable).where(and(eq(ManagedInstallerValidationTable.provider, provider), eq(ManagedInstallerValidationTable.revision, state.revision), gt(ManagedInstallerValidationTable.expires_at, new Date()))).orderBy(desc(ManagedInstallerValidationTable.expires_at), desc(ManagedInstallerValidationTable.id)).limit(1)
    return { ...state, pendingValidation: pending ? validationForCaller(pending, state.approvalMode, actor) : null }
  }))
  return { providers: states, history: changes.map((change) => ({ id: change.id, provider: change.provider, action: change.action, version: change.version, actor: change.actor, createdAt: change.created_at.toISOString(), manifestSha256: change.manifest_sha256, qualification: change.qualification })) }
}

function requireRevision(state: ManagedInstallerProviderState, revision: string) {
  if (state.revision !== revision) throw new InstallerReleaseError("stale_revision", "Settings changed. Refresh the page and validate again before saving.", 409)
}

async function lockedConfig(tx: Transaction, provider: ManagedInstallerProvider) {
  await tx.insert(ManagedInstallerConfigTable).values({ provider, revision: emptyRevision(provider), updated_at: new Date() }).onDuplicateKeyUpdate({ set: { provider } })
  const [row] = await tx.select().from(ManagedInstallerConfigTable).where(eq(ManagedInstallerConfigTable.provider, provider)).for("update")
  if (!row) throw new InstallerReleaseError("settings_unavailable", "Release settings are unavailable.", 503)
  return row
}

async function changeSetting(input: { provider: ManagedInstallerProvider, expectedRevision: string, actor: string, action: "source_saved" | "approval_saved" | "pinned" | "reset", sourceBaseUrl?: string, approvalMode?: ManagedInstallerApprovalMode, validationId?: string, qualification?: ManagedInstallerQualification }, fetcher: typeof fetch = fetch) {
  const [initial] = await db.$primary.select().from(ManagedInstallerConfigTable).where(eq(ManagedInstallerConfigTable.provider, input.provider))
  requireRevision(installerProviderState(input.provider, initial), input.expectedRevision)
  const candidate = input.validationId ? (await db.$primary.select().from(ManagedInstallerValidationTable).where(eq(ManagedInstallerValidationTable.id, input.validationId)))[0] : undefined
  if (input.action === "pinned") {
    if (!managedDeploymentApiOrigin()) throw new InstallerReleaseError("api_origin_unavailable", "The deployment's public API address is not configured correctly. Correct DEN_API_PUBLIC_URL before pinning.", 503)
    if (!candidate || candidate.provider !== input.provider || candidate.expires_at <= new Date()) throw new InstallerReleaseError("validation_expired", "Validate this release again before pinning.", 409)
    const validation = validationForCaller(candidate, approvalMode(initial), input.actor)
    if (!validation) throw new InstallerReleaseError("invalid_validation", "Validate this release again before pinning.", 409)
    requireApproval(approvalMode(initial), candidate.actor, input.actor)
    const same = initial?.release && sameCoordinates(initial.release, validation.release)
    if (candidate.revision !== input.expectedRevision) {
      const changes = await db.$primary.select().from(ManagedInstallerChangeTable).where(eq(ManagedInstallerChangeTable.provider, input.provider)).orderBy(desc(ManagedInstallerChangeTable.created_at), desc(ManagedInstallerChangeTable.id)).limit(100)
      const lastChange = changes.find((change) => change.after.revision === input.expectedRevision)
      const alreadyPinned = same && lastChange?.action === "pinned" && lastChange.manifest_sha256 === validation.manifestSha256 && lastChange.before.revision === candidate.revision && lastChange.after.revision === input.expectedRevision
      if (!alreadyPinned) throw new InstallerReleaseError("stale_validation", "The release source changed, or the approval policy changed. Validate again.", 409)
    }
    await verifyFrozenInstallerRelease(candidate, fetcher)
  }
  await db.transaction(async (tx) => {
    const row = await lockedConfig(tx, input.provider)
    const before = installerProviderState(input.provider, row)
    requireRevision(before, input.expectedRevision)
    if (!initial && (row.source_base_url !== null || row.release !== null)) throw new InstallerReleaseError("stale_revision", "Settings changed. Refresh and try again.", 409)
    if (candidate && candidate.expires_at <= new Date()) throw new InstallerReleaseError("validation_expired", "Validate this release again before pinning.", 409)
    if (input.action === "pinned" && candidate) {
      requireApproval(before.approvalMode, candidate.actor, input.actor)
      const current = before.release
      const next = candidate.validation.release
      if (current) {
        const order = compareReleaseVersions(next.version, current.version)
        if (order === null || order < 0) throw new InstallerReleaseError("release_downgrade", "Choose a version newer than the current default. Reset is a separate explicit action.", 409)
        if (order === 0 && !sameCoordinates(current, next)) throw new InstallerReleaseError("version_conflict", "This version already identifies different release bytes. Publish a new version.", 409)
        if (order === 0 && row.release) {
          const [previousPin] = await tx.select().from(ManagedInstallerChangeTable).where(and(eq(ManagedInstallerChangeTable.provider, input.provider), eq(ManagedInstallerChangeTable.action, "pinned"), eq(ManagedInstallerChangeTable.version, current.version))).orderBy(desc(ManagedInstallerChangeTable.created_at), desc(ManagedInstallerChangeTable.id)).limit(1)
          if (!previousPin || previousPin.manifest_sha256 !== candidate.validation.manifestSha256) throw new InstallerReleaseError("version_conflict", "This version already identifies different release bytes. Publish a new version.", 409)
          return
        }
      }
    }
    if (input.action === "source_saved" && row.source_base_url === input.sourceBaseUrl) return
    // Compare the saved policy: choosing a second administrator also clears a saved policy the operator no longer allows.
    if (input.action === "approval_saved" && savedApprovalMode(row) === input.approvalMode) return
    if (input.action === "reset" && !row.release && initial) return
    const updated = { ...row, ...(input.action === "approval_saved" && input.approvalMode ? { approval_mode: input.approvalMode } : {}), ...(input.action === "source_saved" ? { source_base_url: input.sourceBaseUrl ?? null } : {}), ...(input.action === "pinned" && candidate ? { release: candidate.validation.release } : {}), ...(input.action === "reset" ? { release: null } : {}), revision: randomUUID(), updated_at: new Date() }
    await tx.update(ManagedInstallerConfigTable).set(updated).where(eq(ManagedInstallerConfigTable.provider, input.provider))
    const after = installerProviderState(input.provider, updated)
    await tx.insert(ManagedInstallerChangeTable).values({ id: randomUUID(), provider: input.provider, action: input.action, actor: input.actor, version: after.release?.version ?? null, manifest_sha256: candidate?.validation.manifestSha256 ?? null, qualification: input.qualification ?? null, before, after, created_at: updated.updated_at })
  })
  return installerReleaseReport(input.actor)
}

export async function saveInstallerSource(provider: ManagedInstallerProvider, source: string, expectedRevision: string, actor: string) {
  const sourceBaseUrl = installerSourceBaseUrl(provider, source)
  requireAllowedSource(provider, sourceBaseUrl)
  return changeSetting({ provider, sourceBaseUrl, expectedRevision, actor, action: "source_saved" })
}
export async function saveInstallerApproval(provider: ManagedInstallerProvider, mode: ManagedInstallerApprovalMode, expectedRevision: string, actor: string) {
  if (mode === "platform_admin" && !singleAdminApprovalAllowed()) {
    throw new InstallerReleaseError("single_admin_approval_disabled", `A second platform administrator must pin installer releases on this deployment. The deployment operator can allow single-administrator approval with ${SINGLE_ADMIN_APPROVAL_ENV}=true.`, 400)
  }
  return changeSetting({ provider, approvalMode: mode, expectedRevision, actor, action: "approval_saved" })
}
export async function resetInstallerRelease(provider: ManagedInstallerProvider, expectedRevision: string, actor: string) {
  return changeSetting({ provider, expectedRevision, actor, action: "reset" })
}
export async function pinInstallerRelease(input: { provider: ManagedInstallerProvider, validationId: string, expectedRevision: string, qualification: ManagedInstallerQualification }, actor: string, fetcher: typeof fetch = fetch) {
  return changeSetting({ ...input, actor, action: "pinned" }, fetcher)
}
export async function validateInstallerRelease(input: { provider: ManagedInstallerProvider, version: string, expectedRevision: string }, actor: string, verifier: typeof verifyInstallerRelease = verifyInstallerRelease) {
  const [row] = await db.$primary.select().from(ManagedInstallerConfigTable).where(eq(ManagedInstallerConfigTable.provider, input.provider))
  const state = installerProviderState(input.provider, row)
  requireRevision(state, input.expectedRevision)
  if (!state.sourceBaseUrl) throw new InstallerReleaseError("source_required", "Save a public release source before validating.")
  requireAllowedSource(input.provider, state.sourceBaseUrl)
  const verified = await verifier(input.provider, state.sourceBaseUrl, input.version)
  const now = new Date()
  const validation = { id: randomUUID(), provider: input.provider, release: verified.release, manifestSha256: verified.manifestSha256, services: verified.services, verifiedAt: now.toISOString(), expiresAt: new Date(now.getTime() + 15 * 60 * 1000).toISOString() }
  await db.transaction(async (tx) => {
    const locked = await lockedConfig(tx, input.provider)
    requireRevision(installerProviderState(input.provider, locked), input.expectedRevision)
    await tx.insert(ManagedInstallerValidationTable).values({ id: validation.id, provider: input.provider, revision: input.expectedRevision, validation, manifest_url: verified.manifestUrl, template_sha256: verified.templateSha256, actor, expires_at: new Date(validation.expiresAt) })
  })
  return { ...validation, verifiedBy: actor, canPin: state.approvalMode === "platform_admin" }
}
