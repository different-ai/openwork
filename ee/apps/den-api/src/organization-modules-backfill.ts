import type { createDenDb } from "@openwork-ee/den-db"
import { and, asc, eq, gt, inArray, or } from "@openwork-ee/den-db/drizzle"
import {
  readFeatureRollouts,
  readOrganizationFeatureOverrides,
  readOrganizationFeatureOverridesForMany,
} from "@openwork-ee/den-db/organization-features"
import {
  compareAndSetOrganizationModules,
  emptyOrganizationModules,
  parseOrganizationModulesColumn,
  repairOrganizationModules,
  type ParsedOrganizationModules,
} from "@openwork-ee/den-db/organization-modules"
import { OrganizationTable } from "@openwork-ee/den-db/schema"
import { normalizeDenTypeId } from "@openwork-ee/utils/typeid"
import { resolveFeatures, type FeatureEnvironment, type FeatureOverrides, type FeatureRollouts } from "@openwork/features"
import { LEGACY_KILL_SWITCH_MODULES, legacyDisabledModules, type LegacyKillSwitchModule } from "./organization-modules-legacy.js"

/**
 * Backfill of `organization.modules` from per-organization feature overrides
 * (00-legacy-mapping §G, discovery D43). Only orgs with an explicit
 * `organization_feature` row `enabled = false` for `installLinks` or
 * `mcpConnections` get a document (disabling `org.installLinks` /
 * `library.connectors`, D44); NULL already means the same for everyone
 * else. `feature_rollout` and DEN_FEATURE_* locks are platform rollout state,
 * not org choices, and are never copied. Never touches metadata or the feature
 * tables, and never overwrites an existing document.
 */

type Db = ReturnType<typeof createDenDb>["db"]

export type BackfillRow = { id: string; modules: unknown; overrides: FeatureOverrides }

export type BackfillDecision =
  | { action: "write"; disabled: LegacyKillSwitchModule[] }
  | { action: "nothing_to_copy" }
  | { action: "already_present"; parsed: Extract<ParsedOrganizationModules, { status: "valid" }> }
  | { action: "invalid_document"; parsed: Extract<ParsedOrganizationModules, { status: "invalid" }> }

export function planOrganizationModulesBackfill(row: BackfillRow): BackfillDecision {
  const parsed = parseOrganizationModulesColumn(row.modules)
  if (parsed.status === "valid") return { action: "already_present", parsed }
  if (parsed.status === "invalid") return { action: "invalid_document", parsed }
  const disabled = legacyDisabledModules(row.overrides)
  return disabled.length ? { action: "write", disabled } : { action: "nothing_to_copy" }
}

export type BackfillMode = "dry-run" | "write" | "verify"

export type BackfillReport = {
  mode: BackfillMode
  repair: boolean
  startedAt: string
  scanned: number
  written: number
  wouldWrite: number
  nothingToCopy: number
  alreadyPresent: number
  invalidDocument: number
  repaired: number
  skippedConcurrent: number
  disabledByModule: Record<LegacyKillSwitchModule, number>
  /** 00-legacy-mapping §F data checks answered from the resolved features (counts only). */
  divergenceChecks: { G1: number; G3: number; G10: number }
  invalidOrganizationIds: string[]
  verifyMismatches: Array<{ organizationId: string; module: LegacyKillSwitchModule; overrideDisabled: boolean; columnDisabled: boolean }>
}

function emptyReport(mode: BackfillMode, repair: boolean, now: Date): BackfillReport {
  return {
    mode,
    repair,
    startedAt: now.toISOString(),
    scanned: 0,
    written: 0,
    wouldWrite: 0,
    nothingToCopy: 0,
    alreadyPresent: 0,
    invalidDocument: 0,
    repaired: 0,
    skippedConcurrent: 0,
    disabledByModule: { "library.connectors": 0, "org.installLinks": 0 },
    divergenceChecks: { G1: 0, G3: 0, G10: 0 },
    invalidOrganizationIds: [],
    verifyMismatches: [],
  }
}

function countDivergenceChecks(report: BackfillReport, context: { environment: FeatureEnvironment; rollouts: FeatureRollouts; overrides: FeatureOverrides }) {
  const features = resolveFeatures({ ...context.environment, rollouts: context.rollouts, overrides: context.overrides })
  if (features.mcpConnections) return
  if (features.orgManagedDashboards) report.divergenceChecks.G1++
  if (features.workbot) report.divergenceChecks.G3++
  if (features.slackAssistant) report.divergenceChecks.G10++
}

async function readPage(db: Db, input: { batchSize: number; after: { createdAt: Date; id: string } | null; organizationIds: string[] | null }) {
  const columns = { id: OrganizationTable.id, createdAt: OrganizationTable.createdAt, modules: OrganizationTable.modules }
  const filters = []
  if (input.organizationIds) filters.push(inArray(OrganizationTable.id, input.organizationIds.map((id) => normalizeDenTypeId("organization", id))))
  if (input.after) {
    const afterId = normalizeDenTypeId("organization", input.after.id)
    filters.push(or(gt(OrganizationTable.createdAt, input.after.createdAt), and(eq(OrganizationTable.createdAt, input.after.createdAt), gt(OrganizationTable.id, afterId))))
  }
  const rows = await db
    .select(columns)
    .from(OrganizationTable)
    .where(filters.length ? and(...filters) : undefined)
    .orderBy(asc(OrganizationTable.createdAt), asc(OrganizationTable.id))
    .limit(input.batchSize)
  const overrides = await readOrganizationFeatureOverridesForMany(db, rows.map((row) => row.id))
  return rows.map((row) => ({ ...row, overrides: overrides.get(row.id) ?? {} }))
}

type WriteOutcome = "written" | "repaired" | "skipped"

/**
 * Re-reads the org row under `FOR UPDATE` (the lock every per-org feature
 * override write takes too) and its overrides inside the same transaction, so a
 * concurrent /admin change cannot slip between the decision and the write.
 */
async function writeOne(db: Db, organizationId: string, repair: boolean, now: Date): Promise<WriteOutcome> {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .select({ id: OrganizationTable.id, modules: OrganizationTable.modules })
      .from(OrganizationTable)
      .where(eq(OrganizationTable.id, normalizeDenTypeId("organization", organizationId)))
      .limit(1)
      .for("update")
    if (!row) return "skipped"
    const overrides = await readOrganizationFeatureOverrides(tx, row.id)
    const decision = planOrganizationModulesBackfill({ ...row, overrides })
    if (decision.action === "write") {
      const result = await compareAndSetOrganizationModules(tx, {
        organizationId,
        expectedRevision: 0,
        kind: "legacy",
        next: { ...emptyOrganizationModules(now), revision: 1, disabled: decision.disabled },
      })
      return result.ok ? "written" : "skipped"
    }
    if (decision.action === "invalid_document" && repair) {
      const result = await repairOrganizationModules(tx, {
        organizationId,
        observed: row.modules,
        next: { ...emptyOrganizationModules(now), revision: (decision.parsed.revision ?? 0) + 1, disabled: legacyDisabledModules(overrides) },
      })
      return result.ok ? "repaired" : "skipped"
    }
    return "skipped"
  })
}

export async function runOrganizationModulesBackfill(db: Db, options: {
  mode: BackfillMode
  /** Deployment and operator locks, used only for the §F divergence counts. */
  featureEnvironment: FeatureEnvironment
  repair?: boolean
  batchSize?: number
  organizationIds?: string[]
  now?: Date
}): Promise<BackfillReport> {
  const now = options.now ?? new Date()
  const repair = options.repair === true && options.mode === "write"
  const batchSize = Math.max(1, Math.min(options.batchSize ?? 500, 5_000))
  const organizationIds = options.organizationIds?.length ? options.organizationIds : null
  const report = emptyReport(options.mode, repair, now)
  const rollouts = await readFeatureRollouts(db)
  let after: { createdAt: Date; id: string } | null = null

  for (;;) {
    const page = await readPage(db, { batchSize, after, organizationIds })
    if (!page.length) break
    for (const row of page) {
      report.scanned++
      countDivergenceChecks(report, { environment: options.featureEnvironment, rollouts, overrides: row.overrides })
      const decision = planOrganizationModulesBackfill(row)
      if (decision.action === "nothing_to_copy") {
        report.nothingToCopy++
        continue
      }
      if (decision.action === "already_present") {
        report.alreadyPresent++
        if (options.mode === "verify") {
          const overrideDisabledModules = legacyDisabledModules(row.overrides)
          for (const module of LEGACY_KILL_SWITCH_MODULES) {
            const overrideDisabled = overrideDisabledModules.includes(module)
            const columnDisabled = decision.parsed.doc.disabled.includes(module)
            if (overrideDisabled !== columnDisabled) report.verifyMismatches.push({ organizationId: row.id, module, overrideDisabled, columnDisabled })
          }
        }
        continue
      }
      if (decision.action === "invalid_document") {
        report.invalidDocument++
        report.invalidOrganizationIds.push(row.id)
        if (repair) {
          const outcome = await writeOne(db, row.id, true, now)
          if (outcome === "repaired") report.repaired++
          else report.skippedConcurrent++
        }
        continue
      }
      for (const module of decision.disabled) report.disabledByModule[module]++
      if (options.mode !== "write") {
        report.wouldWrite++
        continue
      }
      const outcome = await writeOne(db, row.id, false, now)
      if (outcome === "written") report.written++
      else report.skippedConcurrent++
    }
    const last = page[page.length - 1]
    after = { createdAt: last.createdAt, id: last.id }
    if (page.length < batchSize) break
  }
  return report
}
