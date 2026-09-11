import { createHash } from "node:crypto"
import type { DenTypeId } from "./typeid.js"

export interface GatewayRollupDimensions {
  organization_id: DenTypeId<"organization">
  org_membership_id: DenTypeId<"member">
  gateway_provider_id: DenTypeId<"inferenceProvider"> | null
  model_group_id: DenTypeId<"gatewayModelGroup"> | null
  credential_set_id: DenTypeId<"gatewayCredentialSet"> | null
  access_grant_id: DenTypeId<"inferenceProviderAccess"> | null
  route: string
  protocol: string
  upstream_provider_id: string
  upstream_model: string | null
}

/**
 * New aggregation only. Do not rewrite historical dimension_key values or
 * infer default selections for old rows. JSON preserves null vs empty string
 * and escapes separators in upstream IDs; tuple order and domain are stable.
 */
export function gatewayRollupDimensionKey(dimensions: GatewayRollupDimensions): string {
  return createHash("sha256").update(JSON.stringify([
    "openwork-gateway-rollup-dimensions-v2",
    dimensions.organization_id,
    dimensions.org_membership_id,
    dimensions.gateway_provider_id,
    dimensions.route,
    dimensions.protocol,
    dimensions.upstream_provider_id,
    dimensions.upstream_model,
    dimensions.model_group_id,
    dimensions.credential_set_id,
    dimensions.access_grant_id,
  ])).digest("hex")
}
