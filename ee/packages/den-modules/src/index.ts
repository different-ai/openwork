export type {
  AvailabilityMap,
  EffectiveModules,
  EntitlementInput,
  ModuleOffState,
  ModuleState,
} from "@openwork/license-contracts/resolver"
export type { Deployment, ModuleId } from "@openwork/license-contracts/modules"
export type { EntitlementSnapshot, OrganizationModules } from "@openwork/license-contracts/org-modules"

export { type OrgModuleRow } from "./org-row"
export {
  describeDeployment,
  parseInstanceConfig,
  parseOrgMode,
  resolveDeployment,
  DEPLOYMENT_ENV,
  type DeploymentSource,
  type InstanceConfig,
  type OrgMode,
} from "./instance/config"
export {
  AVAILABILITY_PROBES,
  computeInstanceAvailability,
  unavailableModules,
  UnknownInfrastructureError,
  type AvailabilityProbe,
  type AvailabilitySnapshot,
} from "./instance/availability"
export {
  capabilityGranted,
  extractLegacyOrgInputs,
  LEGACY_CAPABILITY_KEYS,
  LEGACY_PLAN_TIERS,
  legacyDisabledModules,
  legacyInputsDigest,
  type LegacyCapabilityKey,
  type LegacyOrgInputs,
  type LegacyPlanTier,
} from "./legacy/inputs"
export {
  KNOWN_LEGACY_DIVERGENCES,
  LEGACY_ENTITLEMENT_RULES,
  LEGACY_PLAN_OPERATIONS,
  legacyEntitlementModules,
  legacyPlanAllows,
  matchKnownDivergence,
  type KnownLegacyDivergence,
  type LegacyDivergenceCode,
  type LegacyDivergenceContext,
  type LegacyEntitlementRule,
  type LegacyPlanOperation,
} from "./legacy/mapping"
export { legacyResolverInputs, prepareOrg, type DisabledSource, type PreparedOrg } from "./legacy/adapter"
export { EffectiveModulesMemo, internEffectiveModules, internModuleState } from "./memo"
export {
  becameUsable,
  diffEffectiveModules,
  type ModuleStateChange,
  type ModuleTransition,
  type ModuleTransitionListener,
  type TransitionCause,
} from "./transitions"
export { granted, usable, type LegacyOracle, type ShadowView } from "./shadow"
export { createConsoleModuleLogger, type ModuleLogger } from "./logger"
export { moduleDisabledResponse } from "./module-off-response"
export { DEV_OVERRIDE_ENV, parseDevOverride } from "./entitlement/dev-override"
export {
  createDisabledLicenseClient,
  type LicenseCheckResult,
  type LicenseClient,
  type LicenseRequestContext,
  type LicenseScope,
} from "./entitlement/license-client"
export {
  createDenDbInstanceSnapshotStore,
  createDenDbOrgEntitlementStore,
  createDenDbOrgRowLoader,
  licenseKeyFingerprint,
  type DenModulesDatabase,
  type InstanceSnapshotStore,
  type LeaseStore,
  type OrgEntitlementPersistResult,
  type OrgEntitlementStore,
  type OrgRowLoader,
} from "./entitlement/stores"
export type { EntitlementMode } from "./entitlement/sources"
export type { RefreshOutcome } from "./entitlement/refresher"
export {
  createModuleRuntime,
  type LicenseRuntimeOptions,
  type ModuleRuntime,
  type ModuleRuntimeOptions,
} from "./runtime"
