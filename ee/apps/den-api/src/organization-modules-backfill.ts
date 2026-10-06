import type { createDenDb } from "@openwork-ee/den-db"
import { and, asc, eq, gt, inArray, or } from "@openwork-ee/den-db/drizzle"
import {
  compareAndSetOrganizationModules,
  emptyOrganizationModules,
  parseOrganizationModulesColumn,
  repairOrganizationModules,
  type ParsedOrganizationModules,
} from "@openwork-ee/den-db/organization-modules"
import { OrganizationTable } from "@openwork-ee/den-db/schema"
import { normalizeDenTypeId } from "@openwork-ee/utils/typeid"
import { organizationHasCapability } from "./organization-capabilities.js"
import { LEGACY_KILL_SWITCH_MODULES, legacyDisabledModules, type LegacyKillSwitchModule } from "./organization-modules-legacy.js"

/**
 * Backfill of `organization.modules` from legacy kill switches
 * (00-legacy-mapping §G, modules README rule R7). Only orgs whose metadata
 * explicitly turns off `installLinks` or `mcpConnections` (including the flat
 * connect aliases) get a document; NULL already means the same for everyone
 * else. Never touches metadata, never overwrites an existing document.
 */

type Db = ReturnType<typeof createDenDb>["db"]
type Metadata = Record<string, unknown> | string | null

export type BackfillRow = { id: string; metadata: Metadata; modules: unknown }

export type BackfillDecision =
  | { action: "write"; disabled: LegacyKillSwitchModule[] }
  | { action: "nothing_to_copy" }
  | { action: "already_present"; parsed: Extract<ParsedOrganizationModules, { status: "valid" }> }
  | { action: "invalid_document"; parsed: Extract<ParsedOrganizationModules, { status: "invalid" }> }

export function planOrganizationModulesBackfill(row: BackfillRow): BackfillDecision {
  const parsed = parseOrganizationModulesColumn(row.modules)
  if (parsed.status === "valid") return { action: "already_present", parsed }
  if (parsed.status === "invalid") return { action: "invalid_document", parsed }
  const disabled = legacyDisabledModules(row.metadata)
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
  /** 00-legacy-mapping §F data checks that metadata alone can answer (counts only). */
  divergenceChecks: { G1: number; G3: number; G10: number }
  invalidOrganizationIds: string[]
  verifyMismatches: Array<{ organizationId: string; module: LegacyKillSwitchModule; legacyDisabled: boolean; columnDisabled: boolean }>
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
    disabledByModule: { connect: 0, installLinks: 0 },
    divergenceChecks: { G1: 0, G3: 0, G10: 0 },
    invalidOrganizationIds: [],
    verifyMismatches: [],
  }
}

function countDivergenceChecks(report: BackfillReport, metadata: Metadata) {
  const connectKilled = legacyDisabledModules(metadata).includes("connect")
  if (organizationHasCapability(metadata, "orgManagedDashboards") && connectKilled) report.divergenceChecks.G1++
  if (organizationHasCapability(metadata, "workbot") && connectKilled) report.divergenceChecks.G3++
  if (organizationHasCapability(metadata, "slackAssistant") && connectKilled) report.divergenceChecks.G10++
}

async function readPage(db: Db, input: { batchSize: number; after: { createdAt: Date; id: BackfillRow["id"] } | null; organizationIds: string[] | null }) {
  const columns = { id: OrganizationTable.id, createdAt: OrganizationTable.createdAt, metadata: OrganizationTable.metadata, modules: OrganizationTable.modules }
  const filters = []
  if (input.organizationIds) filters.push(inArray(OrganizationTable.id, input.organizationIds.map((id) => normalizeDenTypeId("organization", id))))
  if (input.after) {
    const afterId = normalizeDenTypeId("organization", input.after.id)
    filters.push(or(gt(OrganizationTable.createdAt, input.after.createdAt), and(eq(OrganizationTable.createdAt, input.after.createdAt), gt(OrganizationTable.id, afterId))))
  }
  return db
    .select(columns)
    .from(OrganizationTable)
    .where(filters.length ? and(...filters) : undefined)
    .orderBy(asc(OrganizationTable.createdAt), asc(OrganizationTable.id))
    .limit(input.batchSize)
}

type WriteOutcome = "written" | "repaired" | "skipped"

/**
 * Re-reads the row under `FOR UPDATE` so a concurrent platform-admin metadata
 * write (which takes the same lock) cannot slip between the decision and the
 * write, then writes with a compare-and-set.
 */
async function writeOne(db: Db, organizationId: string, repair: boolean, now: Date): Promise<WriteOutcome> {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .select({ id: OrganizationTable.id, metadata: OrganizationTable.metadata, modules: OrganizationTable.modules })
      .from(OrganizationTable)
      .where(eq(OrganizationTable.id, normalizeDenTypeId("organization", organizationId)))
      .limit(1)
      .for("update")
    if (!row) return "skipped"
    const decision = planOrganizationModulesBackfill(row)
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
        next: { ...emptyOrganizationModules(now), revision: (decision.parsed.revision ?? 0) + 1, disabled: legacyDisabledModules(row.metadata) },
      })
      return result.ok ? "repaired" : "skipped"
    }
    return "skipped"
  })
}

export async function runOrganizationModulesBackfill(db: Db, options: {
  mode: BackfillMode
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
  let after: { createdAt: Date; id: BackfillRow["id"] } | null = null

  for (;;) {
    const page = await readPage(db, { batchSize, after, organizationIds })
    if (!page.length) break
    for (const row of page) {
      report.scanned++
      countDivergenceChecks(report, row.metadata)
      const decision = planOrganizationModulesBackfill(row)
      if (decision.action === "nothing_to_copy") {
        report.nothingToCopy++
        continue
      }
      if (decision.action === "already_present") {
        report.alreadyPresent++
        if (options.mode === "verify") {
          const legacy = legacyDisabledModules(row.metadata)
          for (const module of LEGACY_KILL_SWITCH_MODULES) {
            const legacyDisabled = legacy.includes(module)
            const columnDisabled = decision.parsed.doc.disabled.includes(module)
            if (legacyDisabled !== columnDisabled) report.verifyMismatches.push({ organizationId: row.id, module, legacyDisabled, columnDisabled })
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
