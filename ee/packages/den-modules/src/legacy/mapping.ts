import { mapModuleIds } from "@openwork/license-contracts"
import type { Deployment, ModuleId } from "@openwork/license-contracts/modules"
import type { InstanceConfig } from "../instance/config"
import { capabilityGranted, type LegacyOrgInputs } from "./inputs"

export interface LegacyEntitlementRule {
  readonly entitled: (inputs: LegacyOrgInputs, config: InstanceConfig) => boolean
  /** Today's formula, for logs and reviews. */
  readonly doc: string
}

const ALWAYS: LegacyEntitlementRule = { entitled: () => true, doc: "no per-org gate today" }

function capability(key: Parameters<typeof capabilityGranted>[1]): LegacyEntitlementRule {
  return { entitled: (inputs) => capabilityGranted(inputs, key), doc: `metadata.capabilities.${key} === true` }
}

function planIncludesHeadlessAutomations(inputs: LegacyOrgInputs, config: InstanceConfig): boolean {
  return !config.deprecatedFlags.planGatingEnabled || inputs.planTier === "team" || inputs.planTier === "enterprise"
}

/**
 * Per-module legacy entitlement (00-legacy-mapping §E.4 column E, the
 * authoritative table). Kill switches (`connect`, `installLinks`) are not
 * entitlement: they reach the resolver through `disabled` (§E.2, R7). Plan
 * entitlements that only gate operations stay `legacyPlanAllows` (§C) and
 * leave the module on.
 */
const RULES: Partial<Record<ModuleId, LegacyEntitlementRule>> = {
  dashboards: capability("orgManagedDashboards"),
  "automations.headless": {
    entitled: (inputs, config) => capabilityGranted(inputs, "headlessAutomations") && planIncludesHeadlessAutomations(inputs, config),
    doc: "metadata.capabilities.headlessAutomations === true ∧ (¬DEN_PLAN_GATING_ENABLED ∨ tier ∈ {team, enterprise})",
  },
  openworkWeb: {
    entitled: (inputs, config) => config.deprecatedFlags.openworkWebEnabled || inputs.complimentaryOpenworkWeb,
    doc: "DEN_OPENWORK_WEB_ENABLED ∨ metadata.complimentaryAccess.openworkWeb === true",
  },
  workbot: capability("workbot"),
  slackAssistant: capability("slackAssistant"),
  "slackAssistant.headless": capability("slackAssistantHeadless"),
  "openworkModels.analytics": capability("modelsAnalytics"),
  auditLogs: capability("auditLogs"),
}

export const LEGACY_ENTITLEMENT_RULES: Readonly<Record<ModuleId, LegacyEntitlementRule>> = Object.freeze(
  mapModuleIds((id) => RULES[id] ?? ALWAYS),
)

export function legacyEntitlementModules(inputs: LegacyOrgInputs, config: InstanceConfig): Record<ModuleId, boolean> {
  return mapModuleIds((id) => LEGACY_ENTITLEMENT_RULES[id].entitled(inputs, config))
}

/**
 * Operation-level legacy plan gates (00-legacy-mapping §C, LP1-LP7). The
 * module stays on; module code keeps answering 402 until Phase 5. LP5
 * (`analytics`) was retired with the legacy reporting endpoints.
 */
export const LEGACY_PLAN_OPERATIONS = [
  "sso.configure",
  "versionPinning.write",
  "desktopPolicies.write",
  "branding.write",
  "audit.entitlement",
  "audit.capture",
  "audit.read",
] as const
export type LegacyPlanOperation = (typeof LEGACY_PLAN_OPERATIONS)[number]

export function legacyPlanAllows(operation: LegacyPlanOperation, inputs: LegacyOrgInputs, config: InstanceConfig): boolean {
  const gating = config.deprecatedFlags.planGatingEnabled
  const enterprise = inputs.planTier === "enterprise"
  const auditEntitled = config.deprecatedFlags.auditSelfHostedEnabled || enterprise
  switch (operation) {
    case "sso.configure":
      return !gating || inputs.planTier === "team" || enterprise
    case "versionPinning.write":
    case "desktopPolicies.write":
    case "branding.write":
      return !gating || enterprise
    case "audit.entitlement":
      return auditEntitled
    case "audit.capture":
      return config.deprecatedFlags.auditCaptureEnabled && auditEntitled
    case "audit.read":
      return config.deprecatedFlags.auditVisibilityEnabled
  }
}

export type LegacyDivergenceCode = "G2" | "G3" | "G4" | "G5" | "G11"

export interface LegacyDivergenceContext {
  readonly inputs: LegacyOrgInputs
  readonly config: InstanceConfig
  readonly deployment: Deployment
  /** The `disabled` list the resolver received (column, or the metadata kill switches). */
  readonly disabled: readonly string[]
}

export interface KnownLegacyDivergence {
  readonly code: LegacyDivergenceCode
  readonly moduleId: ModuleId
  /** The hard dependency legacy gates never checked, when that is the cause. */
  readonly requires?: ModuleId
  readonly summary: string
  /** True exactly when today's gate says "on" and the resolver can't agree. */
  readonly applies: (context: LegacyDivergenceContext) => boolean
}

function connectDisabled(context: LegacyDivergenceContext): boolean {
  return context.disabled.includes("connect")
}

/**
 * Cases where the resolver is stricter than today because of the module
 * graph or `deployments` (00-legacy-mapping §F). The adapter does not paper
 * over them: decisions win, the shadow log tags them, and each owning module
 * plan adopts or resolves them before flipping its gate. G1 is gone
 * (`dashboards → mcpApps` became soft, Q-B2); G10 never shows because the
 * Slack oracle compares entitlement only.
 */
export const KNOWN_LEGACY_DIVERGENCES: readonly KnownLegacyDivergence[] = Object.freeze([
  {
    code: "G2",
    moduleId: "openworkWeb",
    requires: "connect",
    summary: "OpenWork Web hard-depends on connect (D26); today it ignores the connect kill switch.",
    applies: (context) => (context.config.deprecatedFlags.openworkWebEnabled || context.inputs.complimentaryOpenworkWeb) && connectDisabled(context),
  },
  {
    code: "G3",
    moduleId: "workbot",
    requires: "connect",
    summary: "Workbot hard-depends on connect (D26); today it ignores the connect kill switch.",
    applies: (context) => capabilityGranted(context.inputs, "workbot") && context.config.infra.workbotConfigured === true && connectDisabled(context),
  },
  {
    code: "G4",
    moduleId: "automations.remoteSessions",
    requires: "automations",
    summary: "Remote sessions sit under automations; today they stay on through the Cloud path when the automations runtime is off.",
    applies: (context) => !context.config.deprecatedFlags.automationsRuntimeEnabled
      && context.config.orgMode === "multi_org"
      && context.config.infra.cloudRuntimeAvailable === true,
  },
  {
    code: "G5",
    moduleId: "openworkModels.analytics",
    summary: "Cloud-only module: not part of a self-hosted deployment (D3).",
    applies: (context) => context.deployment === "selfHosted" && capabilityGranted(context.inputs, "modelsAnalytics"),
  },
  {
    code: "G5",
    moduleId: "freeInference",
    summary: "Cloud-only module: not part of a self-hosted deployment (D3).",
    applies: (context) => context.deployment === "selfHosted" && context.config.infra.freeInferenceConfigured === true,
  },
  {
    code: "G11",
    moduleId: "automations.headless",
    requires: "automations",
    summary: "Headless automations sit under automations; today the runtime selection ignores the automations runtime flag.",
    applies: (context) => !context.config.deprecatedFlags.automationsRuntimeEnabled
      && capabilityGranted(context.inputs, "headlessAutomations")
      && planIncludesHeadlessAutomations(context.inputs, context.config)
      && context.config.infra.headlessRunnerConfigured === true,
  },
])

export function matchKnownDivergence(moduleId: ModuleId, context: LegacyDivergenceContext): KnownLegacyDivergence | null {
  return KNOWN_LEGACY_DIVERGENCES.find((divergence) => divergence.moduleId === moduleId && divergence.applies(context)) ?? null
}
