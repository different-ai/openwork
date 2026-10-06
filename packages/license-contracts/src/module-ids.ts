import { z } from "zod"

/**
 * Every module id, in dependency-map order. APPEND-ONLY: never remove,
 * rename or reorder an id. Retire one with `stability: "deprecated"` in the
 * registry. `module-ids.snapshot.json` must stay a prefix of this list.
 */
export const MODULE_IDS = [
  "connect",
  "connect.nativeProviders",
  "marketplace",
  "marketplace.githubSync",
  "workflows",
  "mcpApps",
  "dashboards",
  "automations",
  "automations.headless",
  "automations.remoteSessions",
  "openworkWeb",
  "workbot",
  "slackAssistant",
  "slackAssistant.headless",
  "aiGateway",
  "aiGateway.usageLimits",
  "openworkModels",
  "openworkModels.analytics",
  "freeInference",
  "customProviders",
  "desktopPolicies",
  "versionPinning",
  "branding",
  "analytics",
  "auditLogs",
  "auditLogs.export",
  "teams",
  "advancedPermissions",
  "diagnostics",
  "billing",
  "enterpriseAuth",
  "enterpriseAuth.sso",
  "enterpriseAuth.scim",
  "installLinks",
  "webOrigins",
] as const

export type ModuleId = (typeof MODULE_IDS)[number]

/** Strict id schema, for authoring (license server writes). Den parsing uses tolerant string keys. */
export const moduleIdSchema = z.enum(MODULE_IDS)

const MODULE_ID_SET: ReadonlySet<string> = new Set(MODULE_IDS)
const MODULE_ID_ORDER: ReadonlyMap<string, number> = new Map(MODULE_IDS.map((id, index) => [id, index]))

export function isModuleId(value: unknown): value is ModuleId {
  return typeof value === "string" && MODULE_ID_SET.has(value)
}

function isCompleteModuleRecord<T>(record: Partial<Record<ModuleId, T>>): record is Record<ModuleId, T> {
  return MODULE_IDS.every((id) => Object.prototype.hasOwnProperty.call(record, id))
}

/** Builds a record with one entry per module id, in MODULE_IDS order. */
export function mapModuleIds<T>(build: (id: ModuleId) => T): Record<ModuleId, T> {
  const record: Partial<Record<ModuleId, T>> = {}
  for (const id of MODULE_IDS) record[id] = build(id)
  if (!isCompleteModuleRecord(record)) throw new Error("Module record is incomplete")
  return record
}

/** Keeps known ids, drops unknown or retired strings, dedupes, and preserves MODULE_IDS order. */
export function parseModuleIdList(values: readonly unknown[]): ModuleId[] {
  const seen = new Set<ModuleId>()
  for (const value of values) {
    if (isModuleId(value)) seen.add(value)
  }
  return [...seen].sort((a, b) => (MODULE_ID_ORDER.get(a) ?? 0) - (MODULE_ID_ORDER.get(b) ?? 0))
}
