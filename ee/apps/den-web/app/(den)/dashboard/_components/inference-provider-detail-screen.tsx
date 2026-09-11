"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { DenBadge } from "../../_components/ui/badge";
import { DenButton } from "../../_components/ui/button";
import { DenNotice } from "../../_components/ui/notice";
import { getEditGatewayProviderRoute, getGatewayProvidersRoute } from "../../_lib/den-org";
import { useOrgDashboard } from "../_providers/org-dashboard-provider";
import { saveInferenceProvider, useInferenceProvider } from "./inference-provider-data";
import { GatewayAccessMatrix } from "./inference-provider-matrix";
import { GatewayModelUniverse } from "./inference-provider-model-universe";
import { getSettingLabel, type DenInferenceProviderDetails } from "./inference-provider-request";
import { formatProviderTimestamp, requestLlmProviderCatalogDetail, type DenModelsDevProviderDetail } from "./llm-provider-data";

export const GATEWAY_EXPLAINER = "Members call this provider with their own AI Gateway key. Access rules select a model group and credential set; upstream credentials never reach their devices.";
const SECTION_CLASS = "mb-8 border-b border-gray-200 pb-8";

function ProviderModelUniverseEditor({ provider, reload }: { provider: DenInferenceProviderDetails; reload: () => Promise<void> }) {
  const { orgId, runReauthableAction } = useOrgDashboard();
  const [catalog, setCatalog] = useState<DenModelsDevProviderDetail | null>(null);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [draft, setDraft] = useState<{ allowAllModels: boolean; modelIds: string[] } | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!orgId) return;
    let cancelled = false;
    setCatalog(null);
    setCatalogError(null);
    void requestLlmProviderCatalogDetail(orgId, provider.providerId).then((detail) => {
      if (!cancelled) setCatalog(detail);
    }).catch(() => {
      if (!cancelled) setCatalogError("Could not load the provider catalog. Your model policy has not changed.");
    });
    return () => { cancelled = true; };
  }, [orgId, provider.providerId]);

  const savedModelIds = provider.modelIds ?? provider.catalogModels.map((model) => model.id);
  const savedAllowAll = provider.modelIds !== null && provider.modelIds.length === 0;
  // Catalog and matrix reloads can update the saved view, but never replace a draft.
  const value = draft ?? { allowAllModels: savedAllowAll, modelIds: savedModelIds };
  const dirty = value.allowAllModels !== savedAllowAll || (!value.allowAllModels && (
    value.modelIds.length !== savedModelIds.length || value.modelIds.some((id) => !savedModelIds.includes(id))
  ));

  async function save() {
    if (!dirty || saving) return;
    setError(null);
    if (!catalog) return setError("Wait for the provider catalog to load before saving.");
    if (!value.allowAllModels && !value.modelIds.length) return setError("Select at least one model, or turn on Allow all models.");
    setSaving(true);
    try {
      await runReauthableAction("save-inference-provider-model-universe", async () => {
        await saveInferenceProvider({ inferenceProviderId: provider.id, body: { modelIds: value.allowAllModels ? [] : value.modelIds } });
      });
      await reload();
      setDraft(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not save the model universe.");
    } finally { setSaving(false); }
  }

  return <section className={SECTION_CLASS}>
    <GatewayModelUniverse
      models={catalog?.models ?? null}
      allowAllModels={value.allowAllModels}
      modelIds={value.modelIds}
      disabled={saving}
      warning={provider.catalogWarning}
      onChange={(allowAllModels, modelIds) => { setDraft({ allowAllModels, modelIds }); setError(null); }}
    />
    {catalogError ? <DenNotice className="mt-4" tone="error" message={catalogError} /> : null}
    {error ? <DenNotice className="mt-4" tone="error" message={error} /> : null}
    {dirty ? <div className="mt-5 flex flex-wrap items-center gap-3">
      <DenButton loading={saving} disabled={!catalog} onClick={() => void save()}>Save model universe</DenButton>
      <DenButton variant="secondary" disabled={saving} onClick={() => { setDraft(null); setError(null); }}>Cancel</DenButton>
      <span className="text-sm text-gray-500">Unsaved changes</span>
    </div> : null}
  </section>;
}

export function InferenceProviderDetailScreen({ inferenceProviderId }: { inferenceProviderId: string }) {
  const { orgId, orgSlug } = useOrgDashboard();
  const { provider, busy, error, reload } = useInferenceProvider(orgId, inferenceProviderId);
  if (!provider) return <div className="p-8">{busy ? "Loading provider..." : <DenNotice tone="error" message={error ?? "Provider not found."} />}</div>;
  return <div className="mx-auto max-w-[1180px] px-6 py-8 md:px-8">
    <Link href={getGatewayProvidersRoute(orgSlug)} className="text-sm text-gray-500">Back to AI Gateway</Link>
    <div className="my-8 flex flex-wrap items-center justify-between gap-4">
      <h1 className="text-3xl font-semibold">{provider.name}</h1>
      <Link href={getEditGatewayProviderRoute(orgSlug, provider.id)}><DenButton variant="secondary" data-testid="gateway-provider-edit">Edit provider and models</DenButton></Link>
    </div>
    <p className="mb-8 text-gray-500">{GATEWAY_EXPLAINER}</p>
    <section className={SECTION_CLASS}>
      <h2 className="mb-4 text-xl font-semibold">Provider</h2>
      <div className="flex flex-wrap gap-3"><span>{provider.providerId}</span><DenBadge tone={provider.status === "active" ? "success" : "neutral"}>{provider.status}</DenBadge><span className="text-gray-500">Updated {formatProviderTimestamp(provider.updatedAt)}</span></div>
      <dl className="mt-4 grid gap-4 md:grid-cols-2">{Object.entries(provider.settings).map(([key, value]) => <div key={key}><dt className="text-sm text-gray-500">{getSettingLabel(key)}</dt><dd className="break-words">{value}</dd></div>)}</dl>
    </section>
    <ProviderModelUniverseEditor key={`universe:${orgId}:${provider.id}`} provider={provider} reload={reload} />
    <GatewayAccessMatrix key={`access:${orgId}:${provider.id}`} provider={provider} reload={reload} />
  </div>;
}
