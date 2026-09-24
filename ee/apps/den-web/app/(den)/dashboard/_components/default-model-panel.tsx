"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { organizationDefaultModelResponseSchema } from "@openwork/types/den/default-model";
import { useState } from "react";
import { DenSelect } from "../../_components/ui/select";
import { getErrorMessage, requestJson } from "../../_lib/den-flow";
import { ORG_SCOPE_HEADER } from "../../_lib/org-scope";
import { useDenToast } from "./den-toast";
import type { DenInferenceProvider } from "./inference-provider-request";

const NO_DEFAULT = "";

type ModelChoice = { value: string; providerId: string; modelId: string; name: string; providerName: string };

export const defaultModelQueryKey = (orgId: string | null) => ["org", orgId, "default-model"] as const;

async function loadDefault(orgId: string, signal?: AbortSignal) {
  const { response, payload } = await requestJson("/v1/org/default-model", { headers: { [ORG_SCOPE_HEADER]: orgId }, signal }, 15000);
  if (!response.ok) throw new Error(getErrorMessage(payload, "The default model did not load."));
  const parsed = organizationDefaultModelResponseSchema.safeParse(payload);
  if (!parsed.success) throw new Error("The default model did not load.");
  return parsed.data;
}

async function loadChoices(orgId: string, providers: readonly DenInferenceProvider[], signal?: AbortSignal): Promise<ModelChoice[]> {
  const lists = await Promise.all(providers.filter((provider) => provider.status === "active").map(async (provider) => {
    const { response, payload } = await requestJson(`/v1/inference-providers/${encodeURIComponent(provider.id)}/models`, { headers: { [ORG_SCOPE_HEADER]: orgId }, signal }, 15000);
    if (!response.ok || typeof payload !== "object" || payload === null || !("models" in payload) || !Array.isArray(payload.models)) return [];
    return payload.models.flatMap((model: unknown) => {
      if (typeof model !== "object" || model === null || !("id" in model) || !("name" in model)) return [];
      const modelId = typeof model.id === "string" ? model.id : "";
      const name = typeof model.name === "string" ? model.name : modelId;
      return modelId ? [{ value: `${provider.id}|${modelId}`, providerId: provider.id, modelId, name, providerName: provider.name }] : [];
    });
  }));
  return lists.flat().sort((left, right) => left.providerName.localeCompare(right.providerName) || left.name.localeCompare(right.name));
}

/**
 * Manage › Models: the one model everyone starts on in a new chat. People
 * can still pick another model; the desktop keeps their own pick.
 */
export function DefaultModelPanel({ orgId, providers }: { orgId: string; providers: readonly DenInferenceProvider[] }) {
  const queryClient = useQueryClient();
  const toast = useDenToast();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const current = useQuery({ queryKey: defaultModelQueryKey(orgId), queryFn: ({ signal }) => loadDefault(orgId, signal) });
  const providerKey = providers.map((provider) => `${provider.id}:${provider.status}:${provider.updatedAt ?? ""}`).join(",");
  const choices = useQuery({ queryKey: ["org", orgId, "default-model-choices", providerKey], queryFn: ({ signal }) => loadChoices(orgId, providers, signal) });
  const configured = current.data?.configured ?? null;
  const value = configured ? `${configured.providerId}|${configured.modelId}` : NO_DEFAULT;
  const options = choices.data ?? [];
  const missing = configured && !options.some((option) => option.value === value);

  async function save(next: string) {
    if (next === value) return;
    setSaving(true);
    setError(null);
    try {
      const choice = options.find((option) => option.value === next);
      const { response, payload } = choice
        ? await requestJson("/v1/org/default-model", { method: "PUT", headers: { [ORG_SCOPE_HEADER]: orgId }, body: JSON.stringify({ providerId: choice.providerId, modelId: choice.modelId }) }, 15000)
        : await requestJson("/v1/org/default-model", { method: "DELETE", headers: { [ORG_SCOPE_HEADER]: orgId } }, 15000);
      if (!response.ok) throw new Error(getErrorMessage(payload, "The default did not save. Try again."));
      await queryClient.invalidateQueries({ queryKey: defaultModelQueryKey(orgId) });
      toast(choice
        ? { title: `New chats start on ${choice.name}`, description: "People can still pick another model." }
        : { title: "No default for new chats", description: "People start on their own pick, or the free starter model." });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The default did not save. Try again.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <section data-testid="default-model-panel" className="flex items-center gap-4 rounded-2xl border border-gray-100 bg-white px-5 py-4">
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <h2 className="text-[14px] font-medium leading-5 text-gray-900">Default for new chats</h2>
        <p className="text-[13px] leading-[18px] text-gray-500">
          {error ?? "Everyone starts here. People can still pick another model."}
        </p>
      </div>
      <div className="w-60 shrink-0">
        <DenSelect
          aria-label="Default for new chats"
          value={value}
          disabled={saving || current.isLoading || choices.isLoading}
          onChange={(event) => void save(event.target.value)}
        >
          <option value={NO_DEFAULT}>No default</option>
          {missing && configured ? <option value={value}>{configured.name ?? configured.modelId}</option> : null}
          {options.map((option) => (
            <option key={option.value} value={option.value}>{options.some((other) => other !== option && other.name === option.name) ? `${option.name} (${option.providerName})` : option.name}</option>
          ))}
        </DenSelect>
      </div>
    </section>
  );
}
