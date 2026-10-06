import { parseOrgMetadata, readRecord } from "../org-row"

/** `ORGANIZATION_CAPABILITY_KEYS` in den-api `organization-capabilities.ts`. */
export const LEGACY_CAPABILITY_KEYS = [
  "installLinks",
  "mcpConnections",
  "modelsAnalytics",
  "auditLogs",
  "orgManagedDashboards",
  "slackAssistant",
  "slackAssistantHeadless",
  "headlessAutomations",
  "workbot",
] as const
export type LegacyCapabilityKey = (typeof LEGACY_CAPABILITY_KEYS)[number]

export const LEGACY_PLAN_TIERS = ["free", "team", "enterprise"] as const
export type LegacyPlanTier = (typeof LEGACY_PLAN_TIERS)[number]

/**
 * The per-org legacy inputs, read from `organization.metadata` (R7: platform
 * admin grants stay in `metadata.capabilities` until Phase 5).
 */
export interface LegacyOrgInputs {
  /** `parseOrganizationPlan(metadata).tier`. */
  readonly planTier: LegacyPlanTier
  /** Only literal booleans are kept; anything else is `undefined`. */
  readonly capabilities: Readonly<Record<LegacyCapabilityKey, boolean | undefined>>
  /** Historical flat `mcpConnections` aliases (literal booleans only). */
  readonly aliases: { readonly connectEnabled?: boolean; readonly mcpConnectionsEnabled?: boolean }
  /** `hasOpenWorkWebComplimentaryAccess(metadata)`. */
  readonly complimentaryOpenworkWeb: boolean
  /** `memberFacingMcpConnectionsEnabled(metadata)`. */
  readonly connectOn: boolean
  /** `organizationInstallLinksEnabled(metadata)`. */
  readonly installLinksOn: boolean
}

function literalBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined
}

function isPlanTier(value: unknown): value is LegacyPlanTier {
  return LEGACY_PLAN_TIERS.some((tier) => tier === value)
}

/** 00-legacy-mapping §B row 2 (I2): the capability outranks the flat aliases; default on. */
function connectEnabled(capability: boolean | undefined, aliases: LegacyOrgInputs["aliases"]): boolean {
  if (capability !== undefined) return capability
  if (aliases.connectEnabled === true || aliases.mcpConnectionsEnabled === true) return true
  if (aliases.connectEnabled === false || aliases.mcpConnectionsEnabled === false) return false
  return true
}

/** Reads the legacy inputs from an org's metadata. Never throws. */
export function extractLegacyOrgInputs(metadata: unknown): LegacyOrgInputs {
  const parsed = parseOrgMetadata(metadata)
  const raw = readRecord(parsed.capabilities)
  const capabilities: Record<LegacyCapabilityKey, boolean | undefined> = {
    installLinks: literalBoolean(raw.installLinks),
    mcpConnections: literalBoolean(raw.mcpConnections),
    modelsAnalytics: literalBoolean(raw.modelsAnalytics),
    auditLogs: literalBoolean(raw.auditLogs),
    orgManagedDashboards: literalBoolean(raw.orgManagedDashboards),
    slackAssistant: literalBoolean(raw.slackAssistant),
    slackAssistantHeadless: literalBoolean(raw.slackAssistantHeadless),
    headlessAutomations: literalBoolean(raw.headlessAutomations),
    workbot: literalBoolean(raw.workbot),
  }
  const aliases = {
    connectEnabled: literalBoolean(parsed.connectEnabled),
    mcpConnectionsEnabled: literalBoolean(parsed.mcpConnectionsEnabled),
  }
  const plan = readRecord(parsed.plan)
  const complimentary = readRecord(parsed.complimentaryAccess)
  return {
    planTier: isPlanTier(plan.tier) ? plan.tier : "free",
    capabilities,
    aliases,
    complimentaryOpenworkWeb: complimentary.openworkWeb === true,
    connectOn: connectEnabled(capabilities.mcpConnections, aliases),
    installLinksOn: capabilities.installLinks !== false,
  }
}

/** `capTrue(k)` of 00-legacy-mapping: an explicit literal `true`. */
export function capabilityGranted(inputs: LegacyOrgInputs, key: LegacyCapabilityKey): boolean {
  return inputs.capabilities[key] === true
}

/** §E.2 `legacyDisabled(metadata)`: the kill switches an explicit `false` turns off, in MODULE_IDS order. */
export function legacyDisabledModules(inputs: LegacyOrgInputs): Array<"connect" | "installLinks"> {
  const disabled: Array<"connect" | "installLinks"> = []
  if (!inputs.connectOn) disabled.push("connect")
  if (!inputs.installLinksOn) disabled.push("installLinks")
  return disabled
}

function tri(value: boolean | undefined): string {
  return value === undefined ? "-" : value ? "1" : "0"
}

/** Compact canonical form of the inputs, for the memo key (metadata changes don't bump `revision`). */
export function legacyInputsDigest(inputs: LegacyOrgInputs): string {
  const capabilities = LEGACY_CAPABILITY_KEYS.map((key) => tri(inputs.capabilities[key])).join("")
  return `t:${inputs.planTier};c:${capabilities};a:${tri(inputs.aliases.connectEnabled)}${tri(inputs.aliases.mcpConnectionsEnabled)};w:${inputs.complimentaryOpenworkWeb ? 1 : 0}`
}
