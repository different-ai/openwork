"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { GatewayAccessGrantWrite, GatewayCredentialSetWrite, GatewayModelGroupWrite, GatewayProviderTestResult } from "@openwork/types/den/gateway";
import { auditOperationHeaders, type AuditOperationContext } from "@openwork/types/den/audit";
import { gatewayProviderHasUsageLimitsSchema, type GatewayProviderRemovalLimitChoice, type GatewayProviderRemovalUsageLimit } from "@openwork/types/den/gateway-usage-limits";
import { getErrorMessage, getRequestError, requestJson } from "../../_lib/den-flow";
import { ORG_SCOPE_HEADER } from "../../_lib/org-scope";
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
  const generation = useRef(0);
  const [inferenceProviders, setInferenceProviders] = useState<DenInferenceProvider[]>([]);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadProviders = useCallback(async () => {
    const request = ++generation.current;
    if (!orgId) {
      setInferenceProviders([]);
      setBusy(false);
      setError("Organization not found.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const { response, payload } = await requestJson(`/v1/inference-providers?scope=manageable`, { method: "GET", headers: { [ORG_SCOPE_HEADER]: orgId } }, 15000);
      if (request !== generation.current) return;
      if (!response.ok) {
        throw new Error(getErrorMessage(payload, `Failed to load gateway providers (${response.status}).`));
      }
      setInferenceProviders(readInferenceProvidersFromPayload(payload));
    } catch (loadError) {
      if (request !== generation.current) return;
      setError(loadError instanceof Error ? loadError.message : "Failed to load gateway providers.");
    } finally {
      if (request === generation.current) setBusy(false);
    }
  }, [orgId]);

  useEffect(() => {
    void loadProviders();
    return () => { generation.current += 1; };
  }, [loadProviders]);

  return { inferenceProviders, busy, error, reloadProviders: loadProviders };
}

/** One provider with its access grants and credential list (no secret values). */
export function useInferenceProvider(orgId: string | null, inferenceProviderId: string | null) {
  const generation = useRef(0);
  const [provider, setProvider] = useState<DenInferenceProviderDetails | null>(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const request = ++generation.current;
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
        { method: "GET", headers: { [ORG_SCOPE_HEADER]: orgId } },
        15000,
      );
      if (request !== generation.current) return;
      if (!response.ok) {
        throw new Error(getErrorMessage(payload, `Failed to load the provider (${response.status}).`));
      }
      const catalog = await requestJson(`/v1/inference-providers/${encodeURIComponent(inferenceProviderId)}/models`, { method: "GET", headers: { [ORG_SCOPE_HEADER]: orgId } }, 15000);
      if (request !== generation.current) return;
      if (!catalog.response.ok) throw new Error(getErrorMessage(catalog.payload, "Could not load configured catalog models."));
      const next = readInferenceProviderDetails(payload, catalog.payload);
      if (!next) {
        throw new Error("The server did not return valid model groups, credential sets and access rules. Matrix editing is unavailable until the API is updated.");
      }
      setProvider(next);
    } catch (loadError) {
      if (request !== generation.current) return;
      setProvider(null);
      setError(loadError instanceof Error ? loadError.message : "Failed to load the provider.");
    } finally {
      if (request === generation.current) setBusy(false);
    }
  }, [orgId, inferenceProviderId]);

  useEffect(() => {
    void load();
    return () => { generation.current += 1; };
  }, [load]);

  return { provider, busy, error, reload: load };
}

export async function saveInferenceProvider(input: {
  inferenceProviderId: string | null;
  body: Partial<InferenceProviderRequestBody>;
  auditContext?: AuditOperationContext;
}): Promise<DenInferenceProvider> {
  const path = input.inferenceProviderId
    ? `/v1/inference-providers/${encodeURIComponent(input.inferenceProviderId)}`
    : `/v1/inference-providers`;
  const { response, payload } = await requestJson(
    path,
    { method: input.inferenceProviderId ? "PATCH" : "POST", body: JSON.stringify(input.body), headers: auditOperationHeaders(input.auditContext) },
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

export type InferenceProviderTestBody = Pick<InferenceProviderRequestBody, "providerId" | "settings" | "credential" | "apiKeys" | "reuseCredentialFrom"> & { model: string };

function readProviderTestResult(value: unknown): GatewayProviderTestResult | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const ok: unknown = Reflect.get(value, "ok");
  const model: unknown = Reflect.get(value, "model");
  const status: unknown = Reflect.get(value, "status");
  const code: unknown = Reflect.get(value, "code");
  const message: unknown = Reflect.get(value, "message");
  if (typeof model !== "string") return null;
  if (ok === true && typeof status === "number") return { ok: true, model, status, code: null, message: null };
  if (ok === false && typeof code === "string" && typeof message === "string") return { ok: false, model, status: typeof status === "number" ? status : null, code, message };
  return null;
}

/** Asks AI Gateway to send one short prompt with these unsaved settings. Nothing is stored. */
export async function testInferenceProvider(body: InferenceProviderTestBody): Promise<GatewayProviderTestResult> {
  const { response, payload } = await requestJson(`/v1/inference-providers/test-connection`, { method: "POST", body: JSON.stringify(body) }, 45000);
  if (!response.ok) {
    throw getRequestError(payload, response, `Could not test the provider (${response.status}).`);
  }
  const result = readProviderTestResult(payload);
  if (!result) throw new Error("The test finished without a result. Try again.");
  return result;
}

type GatewayResourceWrite =
  | { resource: "model-groups"; body: GatewayModelGroupWrite }
  | { resource: "credential-sets"; body: GatewayCredentialSetWrite }
  | { resource: "access-grants"; body: GatewayAccessGrantWrite };

export async function saveGatewayResource(providerId: string, id: string | null, input: GatewayResourceWrite, auditContext?: AuditOperationContext) {
  const path = `/v1/inference-providers/${encodeURIComponent(providerId)}/${input.resource}${id ? `/${encodeURIComponent(id)}` : ""}`;
  const { response, payload } = await requestJson(path, {
    method: id ? "PATCH" : "POST", body: JSON.stringify(input.body), headers: auditOperationHeaders(auditContext),
  }, 20000);
  if (!response.ok) throw getRequestError(payload, response, `Could not save ${input.resource} (${response.status}).`);
}

export async function deleteGatewayResource(providerId: string, resource: GatewayResourceWrite["resource"], id: string, auditContext?: AuditOperationContext) {
  const { response, payload } = await requestJson(
    `/v1/inference-providers/${encodeURIComponent(providerId)}/${resource}/${encodeURIComponent(id)}`,
    { method: "DELETE", headers: auditOperationHeaders(auditContext) }, 20000,
  );
  if (!response.ok) throw getRequestError(payload, response, `Could not delete ${resource} (${response.status}).`);
}

/** The provider still has usage limits; the person chooses where they go before it is removed. */
export class ProviderHasUsageLimitsError extends Error {
  constructor(message: string, readonly usageLimits: GatewayProviderRemovalUsageLimit[]) {
    super(message);
  }
}

export async function deleteInferenceProvider(inferenceProviderId: string, auditContext?: AuditOperationContext, usageLimits?: GatewayProviderRemovalLimitChoice) {
  const query = new URLSearchParams();
  if (usageLimits) query.set("usageLimits", usageLimits.action);
  if (usageLimits?.action === "move") query.set("moveUsageLimitsTo", usageLimits.providerId);
  const { response, payload } = await requestJson(
    `/v1/inference-providers/${encodeURIComponent(inferenceProviderId)}${query.size ? `?${query}` : ""}`,
    { method: "DELETE", headers: auditOperationHeaders(auditContext) },
    12000,
  );
  if (response.status === 409) {
    const conflict = gatewayProviderHasUsageLimitsSchema.safeParse(payload);
    if (conflict.success) throw new ProviderHasUsageLimitsError(conflict.data.message, conflict.data.usageLimits);
  }
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
