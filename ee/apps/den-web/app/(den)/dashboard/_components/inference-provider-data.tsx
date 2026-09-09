"use client";

import { useCallback, useEffect, useState } from "react";
import type { GatewayAccessGrantWrite, GatewayCredentialSetWrite, GatewayModelGroupWrite } from "@openwork/types/den/gateway";
import { getErrorMessage, getRequestError, requestJson } from "../../_lib/den-flow";
import {
  buildMigrateFromLlmProviderBody,
  readInferenceProviderFromPayload,
  readInferenceProvidersFromPayload,
  readInferenceProviderDetails,
  type DenInferenceProviderDetails,
  type DenInferenceProvider,
  type InferenceProviderRequestBody,
} from "./inference-provider-request";

export function useOrgInferenceProviders(orgId: string | null) {
  const [inferenceProviders, setInferenceProviders] = useState<DenInferenceProvider[]>([]);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadProviders = useCallback(async () => {
    if (!orgId) {
      setInferenceProviders([]);
      setBusy(false);
      setError("Organization not found.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const { response, payload } = await requestJson(`/v1/inference-providers?scope=manageable`, { method: "GET" }, 15000);
      if (!response.ok) {
        throw new Error(getErrorMessage(payload, `Failed to load gateway providers (${response.status}).`));
      }
      setInferenceProviders(readInferenceProvidersFromPayload(payload));
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Failed to load gateway providers.");
    } finally {
      setBusy(false);
    }
  }, [orgId]);

  useEffect(() => {
    void loadProviders();
  }, [loadProviders]);

  return { inferenceProviders, busy, error, reloadProviders: loadProviders };
}

/** One provider with its access grants and credential list (no secret values). */
export function useInferenceProvider(orgId: string | null, inferenceProviderId: string | null) {
  const [provider, setProvider] = useState<DenInferenceProviderDetails | null>(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!orgId || !inferenceProviderId) {
      setProvider(null);
      setBusy(false);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const { response, payload } = await requestJson(
        `/v1/inference-providers/${encodeURIComponent(inferenceProviderId)}`,
        { method: "GET" },
        15000,
      );
      if (!response.ok) {
        throw new Error(getErrorMessage(payload, `Failed to load the provider (${response.status}).`));
      }
      const catalog = await requestJson(`/v1/inference-providers/${encodeURIComponent(inferenceProviderId)}/models`, { method: "GET" }, 15000);
      if (!catalog.response.ok) throw new Error(getErrorMessage(catalog.payload, "Could not load configured catalog models."));
      const next = readInferenceProviderDetails(payload, catalog.payload);
      if (!next) {
        throw new Error("The server did not return valid model groups, credential sets and access rules. Matrix editing is unavailable until the API is updated.");
      }
      setProvider(next);
    } catch (loadError) {
      setProvider(null);
      setError(loadError instanceof Error ? loadError.message : "Failed to load the provider.");
    } finally {
      setBusy(false);
    }
  }, [orgId, inferenceProviderId]);

  useEffect(() => {
    void load();
  }, [load]);

  return { provider, busy, error, reload: load };
}

export async function saveInferenceProvider(input: {
  inferenceProviderId: string | null;
  body: Partial<InferenceProviderRequestBody>;
}): Promise<DenInferenceProvider> {
  const path = input.inferenceProviderId
    ? `/v1/inference-providers/${encodeURIComponent(input.inferenceProviderId)}`
    : `/v1/inference-providers`;
  const { response, payload } = await requestJson(
    path,
    { method: input.inferenceProviderId ? "PATCH" : "POST", body: JSON.stringify(input.body) },
    20000,
  );
  if (!response.ok) {
    throw getRequestError(payload, response, `Failed to save the gateway provider (${response.status}).`);
  }
  const provider = readInferenceProviderFromPayload(payload);
  if (!provider) {
    throw new Error("The provider was saved, but no provider was returned.");
  }
  return provider;
}

type GatewayResourceWrite =
  | { resource: "model-groups"; body: GatewayModelGroupWrite }
  | { resource: "credential-sets"; body: GatewayCredentialSetWrite }
  | { resource: "access-grants"; body: GatewayAccessGrantWrite };

export async function saveGatewayResource(providerId: string, id: string | null, input: GatewayResourceWrite) {
  const path = `/v1/inference-providers/${encodeURIComponent(providerId)}/${input.resource}${id ? `/${encodeURIComponent(id)}` : ""}`;
  const { response, payload } = await requestJson(path, {
    method: id ? "PATCH" : "POST", body: JSON.stringify(input.body),
  }, 20000);
  if (!response.ok) throw getRequestError(payload, response, `Could not save ${input.resource} (${response.status}).`);
}

export async function deleteGatewayResource(providerId: string, resource: GatewayResourceWrite["resource"], id: string) {
  const { response, payload } = await requestJson(
    `/v1/inference-providers/${encodeURIComponent(providerId)}/${resource}/${encodeURIComponent(id)}`,
    { method: "DELETE" }, 20000,
  );
  if (!response.ok) throw getRequestError(payload, response, `Could not delete ${resource} (${response.status}).`);
}

export async function deleteInferenceProvider(inferenceProviderId: string) {
  const { response, payload } = await requestJson(
    `/v1/inference-providers/${encodeURIComponent(inferenceProviderId)}`,
    { method: "DELETE" },
    12000,
  );
  if (response.status !== 204 && !response.ok) {
    throw getRequestError(payload, response, `Failed to delete the gateway provider (${response.status}).`);
  }
}

/** Moves a models.dev BYOK provider to the gateway; returns the new gateway provider. */
export async function migrateLlmProviderToGateway(llmProviderId: string): Promise<DenInferenceProvider> {
  const { response, payload } = await requestJson(
    `/v1/inference-providers/migrate-from-llm-provider`,
    { method: "POST", body: JSON.stringify(buildMigrateFromLlmProviderBody(llmProviderId)) },
    20000,
  );
  if (!response.ok) {
    throw getRequestError(payload, response, `Failed to move the provider to the gateway (${response.status}).`);
  }
  const provider = readInferenceProviderFromPayload(payload);
  if (!provider) {
    throw new Error("The provider was moved, but no gateway provider was returned.");
  }
  return provider;
}
