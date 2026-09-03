"use client";

import { useCallback, useEffect, useState } from "react";
import { getErrorMessage, getRequestError, requestJson } from "../../_lib/den-flow";
import {
  buildMigrateFromLlmProviderBody,
  readInferenceProviderFromPayload,
  readInferenceProvidersFromPayload,
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
  const [provider, setProvider] = useState<DenInferenceProvider | null>(null);
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
      const next = readInferenceProviderFromPayload(payload);
      if (!next) {
        throw new Error("The provider could not be parsed.");
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
  body: InferenceProviderRequestBody;
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
