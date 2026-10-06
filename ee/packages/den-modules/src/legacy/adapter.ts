import type { Deployment } from "@openwork/license-contracts/modules"
import type { AvailabilityMap, EntitlementInput, ResolverInputs } from "@openwork/license-contracts/resolver"
import type { InstanceConfig } from "../instance/config"
import type { OrgModulesDocument } from "../org-row"
import { extractLegacyOrgInputs, legacyDisabledModules, type LegacyOrgInputs } from "./inputs"
import { legacyEntitlementModules } from "./mapping"

export type DisabledSource = "column" | "metadata"

/** One org's module inputs, parsed once per memo miss. */
export interface PreparedOrg {
  readonly legacy: LegacyOrgInputs
  readonly document: OrgModulesDocument
  /** Org opt-outs the resolver receives. */
  readonly disabled: readonly string[]
  /**
   * `column` when `organization.modules` holds a valid document (authoritative,
   * kept in step by the W0-02 dual-write); `metadata` when it is NULL or
   * invalid, so the legacy kill switches are derived from metadata (§E.2).
   */
  readonly disabledSource: DisabledSource
}

export function prepareOrg(metadata: unknown, document: OrgModulesDocument): PreparedOrg {
  const legacy = extractLegacyOrgInputs(metadata)
  if (document.status === "valid") return { legacy, document, disabled: document.doc.disabled, disabledSource: "column" }
  return { legacy, document, disabled: legacyDisabledModules(legacy), disabledSource: "metadata" }
}

export function legacyEntitlementInput(legacy: LegacyOrgInputs, config: InstanceConfig): EntitlementInput {
  return { source: "static", modules: legacyEntitlementModules(legacy, config) }
}

/** 00-legacy-mapping §E.2: resolver inputs whose result equals today's gates (except §F). */
export function legacyResolverInputs(prepared: PreparedOrg, context: {
  deployment: Deployment
  availability: AvailabilityMap
  config: InstanceConfig
  now: Date
}): ResolverInputs {
  return {
    deployment: context.deployment,
    availability: context.availability,
    entitlement: legacyEntitlementInput(prepared.legacy, context.config),
    disabled: prepared.disabled,
    now: context.now,
  }
}
