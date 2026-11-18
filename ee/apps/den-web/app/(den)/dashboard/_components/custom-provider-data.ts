/**
 * den-api requests for AI Gateway custom OpenAI-compatible providers
 * (`/v1/inference-providers/custom/*`). Bodies and answers use the shared
 * schemas in @openwork/types/den/gateway-custom-providers. Keys are write-only.
 */

import { auditOperationHeaders, type AuditOperationContext } from "@openwork/types/den/audit";
import {
  gatewayCustomDiscoverResponseSchema,
  gatewayCustomTestResponseSchema,
  type GatewayCustomCreateRequest,
  type GatewayCustomDiscoverRequest,
  type GatewayCustomDiscoverResponse,
  type GatewayCustomTestRequest,
  type GatewayCustomTestResponse,
  type GatewayCustomUpdateRequest,
} from "@openwork/types/den/gateway-custom-providers";
import { getRequestError, requestJson } from "../../_lib/den-flow";
import { deleteGatewayResource, saveGatewayResource } from "./inference-provider-data";
import { accessGrantChanges } from "./custom-provider-models";
import { readInferenceProviderFromPayload, type DenInferenceProvider, type DenInferenceProviderDetails } from "./inference-provider-request";

/** Asks den-api to read `GET {baseUrl}/models` with the key (or a saved provider's key). */
export async function discoverCustomProviderModels(body: GatewayCustomDiscoverRequest): Promise<GatewayCustomDiscoverResponse> {
  const { response, payload } = await requestJson("/v1/inference-providers/custom/discover-models", { method: "POST", body: JSON.stringify(body) }, 30000);
  if (!response.ok) throw getRequestError(payload, response, `Could not fetch models (${response.status}).`);
  const parsed = gatewayCustomDiscoverResponseSchema.safeParse(payload);
  if (!parsed.success) throw new Error("The server returned an unexpected answer. Try again.");
  return parsed.data;
}

/** One short prompt through AI Gateway with these unsaved settings. Nothing is stored. */
export async function testCustomProvider(body: GatewayCustomTestRequest): Promise<GatewayCustomTestResponse> {
  const { response, payload } = await requestJson("/v1/inference-providers/custom/test-connection", { method: "POST", body: JSON.stringify(body) }, 45000);
  if (!response.ok) throw getRequestError(payload, response, `Could not test the provider (${response.status}).`);
  const parsed = gatewayCustomTestResponseSchema.safeParse(payload);
  if (!parsed.success) throw new Error("The test finished without a result. Try again.");
  return parsed.data;
}

export async function createCustomProvider(body: GatewayCustomCreateRequest, auditContext?: AuditOperationContext): Promise<DenInferenceProvider> {
  const { response, payload } = await requestJson("/v1/inference-providers/custom", {
    method: "POST", body: JSON.stringify(body), headers: auditOperationHeaders(auditContext),
  }, 30000);
  if (!response.ok) throw getRequestError(payload, response, `Could not add the provider (${response.status}).`);
  const provider = readInferenceProviderFromPayload(payload);
  if (!provider) throw new Error("The provider was added, but no provider was returned. Reload AI Providers.");
  return provider;
}

export async function updateCustomProvider(inferenceProviderId: string, body: GatewayCustomUpdateRequest, auditContext?: AuditOperationContext): Promise<DenInferenceProvider> {
  const { response, payload } = await requestJson(`/v1/inference-providers/${encodeURIComponent(inferenceProviderId)}/custom`, {
    method: "PATCH", body: JSON.stringify(body), headers: auditOperationHeaders(auditContext),
  }, 30000);
  if (!response.ok) throw getRequestError(payload, response, `Could not save the provider (${response.status}).`);
  const provider = readInferenceProviderFromPayload(payload);
  if (!provider) throw new Error("The provider was saved, but no provider was returned. Reload the page.");
  return provider;
}

/** A failed test from a request that never got a result (network, rate limit at Den, reauth cancelled). */
export function testRequestFailure(model: string, cause: unknown): GatewayCustomTestResponse {
  return { ok: false, model, status: null, code: "test_failed", message: cause instanceof Error ? cause.message : "Could not test the provider. Try again.", step: null };
}

/** Applies "Who can use it" through the existing access-grant routes. */
export async function syncCustomProviderAccess(
  provider: Pick<DenInferenceProviderDetails, "id" | "accessGrants" | "modelGroups" | "credentialSets">,
  access: { orgWide: boolean; memberIds: readonly string[]; teamIds: readonly string[] },
  auditContext?: AuditOperationContext,
) {
  const [group] = provider.modelGroups;
  const [set] = provider.credentialSets;
  if (!group || !set) throw new Error("This provider has no model group or key yet. Reload the page and try again.");
  const { add, remove } = accessGrantChanges(provider, group.id, set.id, access);
  for (const id of remove) await deleteGatewayResource(provider.id, "access-grants", id, auditContext);
  for (const audience of add) await saveGatewayResource(provider.id, null, { resource: "access-grants", body: { audience, modelGroupId: group.id, credentialSetId: set.id } }, auditContext);
}
