import type { GatewayUsableModel } from "@openwork/types/den/gateway";

const GATEWAY_MODEL_ID = /^gwm_[0-7][0-9a-hjkmnp-tv-z]{25}_[0-7][0-9a-hjkmnp-tv-z]{25}_[0-7][0-9a-hjkmnp-tv-z]{25}$/;

/**
 * One Gateway model combination, or null when any identity field is missing or
 * its `gwm_` id does not encode its own model group and credential set. Pass
 * `credentialSetId` to also require the model to belong to that set.
 */
export function parseGatewayUsableModel(value: unknown, credentialSetId?: unknown): GatewayUsableModel | null {
  if (!value || typeof value !== "object"
    || !("id" in value) || typeof value.id !== "string" || !GATEWAY_MODEL_ID.test(value.id)
    || !("name" in value) || typeof value.name !== "string"
    || !("config" in value) || !value.config || typeof value.config !== "object" || Array.isArray(value.config)
    || !("id" in value.config) || value.config.id !== value.id
    || !("upstreamModelId" in value) || typeof value.upstreamModelId !== "string"
    || !("modelGroupId" in value) || typeof value.modelGroupId !== "string"
    || !("modelGroupName" in value) || typeof value.modelGroupName !== "string"
    || !("credentialSetId" in value) || typeof value.credentialSetId !== "string"
    || (credentialSetId !== undefined && value.credentialSetId !== credentialSetId)
    || value.id.split("_")[2] !== value.credentialSetId.slice(4)
    || value.id.split("_")[1] !== value.modelGroupId.slice(4)
    || !("credentialSetName" in value) || typeof value.credentialSetName !== "string") return null;
  return {
    id: value.id, name: value.name, config: { ...value.config, id: value.id },
    upstreamModelId: value.upstreamModelId, modelGroupId: value.modelGroupId, modelGroupName: value.modelGroupName,
    credentialSetId: value.credentialSetId, credentialSetName: value.credentialSetName,
  };
}
