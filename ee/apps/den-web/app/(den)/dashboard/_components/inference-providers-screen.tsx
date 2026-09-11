"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { ChevronRight, KeyRound, Layers3, Plus, Search, Shield } from "lucide-react";
import { DashboardPageTemplate } from "../../_components/ui/dashboard-page-template";
import { DenBadge } from "../../_components/ui/badge";
import { DenBrandMark } from "../../_components/ui/brand-mark";
import { DenCard } from "../../_components/ui/card";
import { buttonVariants } from "../../_components/ui/button";
import { DenInput } from "../../_components/ui/input";
import { DenNotice } from "../../_components/ui/notice";
import { getGatewayProviderRoute, getNewGatewayProviderRoute } from "../../_lib/den-org";
import { useOrgDashboard } from "../_providers/org-dashboard-provider";
import { useOrgInferenceProviders } from "./inference-provider-data";
import { GatewayUsageSection } from "./gateway-usage-section";
import {
  getCredentialStatusLabel,
  getCredentialStatusTone,
  getProviderStatusLabel,
  type DenInferenceProvider,
} from "./inference-provider-request";
import { formatProviderTimestamp, getProviderDocUrl, getProviderIconSlug } from "./llm-provider-data";

/** Credential status pill shared by the list and detail screens. */
export function InferenceCredentialStatusBadge({
  provider,
}: {
  provider: Pick<DenInferenceProvider, "credentialMode" | "credentialStatus">;
}) {
  return (
    <DenBadge tone={getCredentialStatusTone(provider)} icon={KeyRound}>
      {getCredentialStatusLabel(provider)}
    </DenBadge>
  );
}

function GatewayProviderCard({ provider, orgSlug }: { provider: DenInferenceProvider; orgSlug: string | null }) {
  const keyCount = provider.credentialSets?.filter((set) => set.credentialMode === "org" && set.configured).length;
  const groupCount = provider.modelGroups?.length;

  return (
    <Link
      href={getGatewayProviderRoute(orgSlug, provider.id)}
      aria-label={`Open ${provider.name}`}
      data-testid="gateway-provider-open"
      className="group block min-w-0 rounded-[30px] outline-none focus-visible:ring-2 focus-visible:ring-emerald-600 focus-visible:ring-offset-2"
    >
      <DenCard className="flex h-full min-w-0 flex-col gap-5 transition-colors group-hover:border-gray-300 group-hover:bg-gray-50">
        <div className="flex items-start justify-between gap-3">
          <div className="flex min-w-0 items-center gap-3">
            <DenBrandMark
              name={provider.providerId}
              simpleIconSlug={getProviderIconSlug(provider.providerId)}
              serviceUrl={getProviderDocUrl(provider.providerConfig)}
              className="h-10 w-10 shrink-0 rounded-xl"
              imageClassName="h-5 w-5"
            />
            <div className="min-w-0">
              <h2 className="truncate text-base font-semibold text-gray-950" title={provider.name}>{provider.name}</h2>
              <p className="mt-1 truncate text-xs text-gray-400" title={provider.providerId}>{provider.providerId}</p>
            </div>
          </div>
          <DenBadge tone={provider.status === "active" ? "success" : "neutral"} className="shrink-0">
            {getProviderStatusLabel(provider.status)}
          </DenBadge>
        </div>

        <div className="flex flex-wrap gap-2">
          <DenBadge icon={KeyRound}>
            {keyCount === undefined ? "Keys unavailable" : `${keyCount} ${keyCount === 1 ? "key" : "keys"}`}
          </DenBadge>
          <DenBadge icon={Layers3}>
            {groupCount === undefined ? "Model groups unavailable" : `${groupCount} model ${groupCount === 1 ? "group" : "groups"}`}
          </DenBadge>
        </div>

        <div className="mt-auto flex items-center justify-between gap-3 border-t border-gray-100 pt-4 text-xs text-gray-400">
          <span>Updated {formatProviderTimestamp(provider.updatedAt)}</span>
          <ChevronRight className="h-4 w-4 shrink-0 text-gray-400 transition-colors group-hover:text-gray-700" aria-hidden="true" />
        </div>
      </DenCard>
    </Link>
  );
}

export function InferenceProvidersScreen() {
  const { orgId, orgSlug } = useOrgDashboard();
  const { inferenceProviders, busy, error } = useOrgInferenceProviders(orgId);
  const [query, setQuery] = useState("");

  const filtered = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    if (!normalized) return inferenceProviders;
    return inferenceProviders.filter(
      (provider) =>
        provider.name.toLowerCase().includes(normalized) ||
        provider.providerId.toLowerCase().includes(normalized) ||
        provider.modelGroups?.some((group) => group.name.toLowerCase().includes(normalized)) ||
        provider.credentialSets?.some((set) => set.name.toLowerCase().includes(normalized)) ||
        provider.models.some((model) => model.name.toLowerCase().includes(normalized)),
    );
  }, [inferenceProviders, query]);

  return (
    <DashboardPageTemplate
      icon={Shield}
      title="Gateway"
      description="Configure your organizations AI Model Providers once, track and control each user's access and usage individually"
      colors={["#F1F5FF", "#1D4ED8", "#60A5FA", "#A7F3D0"]}
    >
      {orgId ? <GatewayUsageSection key={orgId} orgId={orgId} /> : null}

      <section aria-labelledby="gateway-providers-heading">
        <h2 id="gateway-providers-heading" className="mb-4 text-lg font-semibold tracking-tight text-gray-950">Providers</h2>
        <div className="mb-6 flex flex-col gap-4 xl:flex-row xl:items-center xl:justify-between">
          <DenInput
            type="search"
            icon={Search}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search providers or models..."
          />
          <Link
            href={getNewGatewayProviderRoute(orgSlug)}
            data-testid="gateway-provider-create"
            className={buttonVariants({ variant: "primary" })}
          >
            <Plus className="h-4 w-4" aria-hidden="true" />
            Add gateway provider
          </Link>
        </div>

        {error ? <DenNotice message={error} tone="error" className="mb-6" /> : null}

        {busy ? (
          <div className="rounded-[28px] border border-gray-200 bg-white px-6 py-10 text-[15px] text-gray-500">
            Loading gateway providers...
          </div>
        ) : (
          <section aria-label="Configured providers">
            {filtered.length === 0 ? (
              <DenCard className="px-6 py-12 text-center">
                <p className="text-[16px] font-medium tracking-[-0.03em] text-gray-900">
                  {inferenceProviders.length === 0 ? "No gateway providers yet." : "No providers match that search."}
                </p>
                <p className="mx-auto mt-3 max-w-[560px] text-[15px] leading-8 text-gray-500">
                  {inferenceProviders.length === 0
                    ? "Add a catalog provider, create model groups and named credential sets, then grant people or teams access through explicit rules."
                    : "Try a broader search term."}
                </p>
              </DenCard>
            ) : (
              <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
                {filtered.map((provider) => <GatewayProviderCard key={provider.id} provider={provider} orgSlug={orgSlug} />)}
              </div>
            )}
          </section>
        )}
      </section>
    </DashboardPageTemplate>
  );
}
