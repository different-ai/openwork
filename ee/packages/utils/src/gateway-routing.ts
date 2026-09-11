import { type DenTypeId, typeId } from "./typeid"

export type GatewayWireModelId = `gwm_${string}_${string}_${string}`

export interface GatewayModelSelection {
  modelGroupId: DenTypeId<"gatewayModelGroup">
  credentialSetId: DenTypeId<"gatewayCredentialSet">
  gatewayProviderModelId: DenTypeId<"inferenceProviderModel">
}

/** Produces an SDK wire ID, not an authorization token. */
export function createGatewayModelAlias(selection: GatewayModelSelection): GatewayWireModelId {
  const modelGroupId = typeId.schema("gatewayModelGroup").parse(selection.modelGroupId)
  const credentialSetId = typeId.schema("gatewayCredentialSet").parse(selection.credentialSetId)
  const modelId = typeId.schema("inferenceProviderModel").parse(selection.gatewayProviderModelId)
  return `gwm_${modelGroupId.slice(4)}_${credentialSetId.slice(4)}_${modelId.slice(4)}`
}

/**
 * Canonical 128-bit TypeID suffixes only (first character 0-7).
 * Callers MUST reauthorize provider/org, membership, active group/set/model,
 * grants and credential subject on every request. No raw-ID fallback on failure.
 */
export function parseGatewayModelAlias(value: unknown): GatewayModelSelection | null {
  if (typeof value !== "string" || value.length !== 84) return null
  const match = /^gwm_([0-7][0-9a-hjkmnp-tv-z]{25})_([0-7][0-9a-hjkmnp-tv-z]{25})_([0-7][0-9a-hjkmnp-tv-z]{25})$/.exec(value)
  if (!match) return null
  const [, groupSuffix, setSuffix, modelSuffix] = match
  if (!groupSuffix || !setSuffix || !modelSuffix) return null
  return {
    modelGroupId: typeId.fromString("gatewayModelGroup", `gmg_${groupSuffix}`),
    credentialSetId: typeId.fromString("gatewayCredentialSet", `gcs_${setSuffix}`),
    gatewayProviderModelId: typeId.fromString("inferenceProviderModel", `ipm_${modelSuffix}`),
  }
}

/** Matches gateway_provider_access.audience_key; foreign-org checks are required separately. */
export function gatewayAudienceKey(audience:
  | { type: "organization" }
  | { type: "team"; teamId: string }
  | { type: "member"; memberId: string }
): string {
  switch (audience.type) {
    case "organization": return "organization"
    case "team": return `team:${typeId.schema("team").parse(audience.teamId)}`
    case "member": return `member:${typeId.schema("member").parse(audience.memberId)}`
  }
}
