"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { CodeXml, Cpu, KeyRound, Plus, Search } from "lucide-react";
import { DashboardPageTemplate } from "../../../../_components/ui/dashboard-page-template";
import { buttonVariants } from "../../../../_components/ui/button";
import { DenInput } from "../../../../_components/ui/input";
import {
  getLlmProviderRoute,
  getNewLlmProviderRoute,
} from "../../../../_lib/den-org";
import { useOrgDashboard } from "../_providers/org-dashboard-provider";
import {
  formatProviderTimestamp,
  getProviderDocUrl,
  getProviderEnvNames,
  useOrgLlmProviders,
} from "./llm-provider-data";

function getProviderSourceLabel(source: "models_dev" | "custom") {
  return source === "custom" ? "Custom" : "Catalog";
}

function getProviderSourceIcon(source: "models_dev" | "custom") {
  return source === "custom" ? CodeXml : Cpu;
}

export function LlmProvidersScreen() {
  const { orgId, orgSlug } = useOrgDashboard();
  const { llmProviders, busy, error } = useOrgLlmProviders(orgId);
  const [query, setQuery] = useState("");

  const filteredProviders = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    if (!normalizedQuery) {
      return llmProviders;
    }

    return llmProviders.filter((provider) => {
      const env = getProviderEnvNames(provider.providerConfig).join(" ").toLowerCase();
      const doc = (getProviderDocUrl(provider.providerConfig) ?? "").toLowerCase();
      return (
        provider.name.toLowerCase().includes(normalizedQuery) ||
        provider.providerId.toLowerCase().includes(normalizedQuery) ||
        provider.models.some((model) => model.name.toLowerCase().includes(normalizedQuery)) ||
        env.includes(normalizedQuery) ||
        doc.includes(normalizedQuery)
      );
    });
  }, [llmProviders, query]);

  return (
    <DashboardPageTemplate
      icon={Cpu}
      badgeLabel="New"
      title="LLM Providers"
      description="Configure catalog-backed or custom providers, choose the exact models each one exposes, and grant access to the right people and teams."
      colors={["#F3FFF9", "#0F766E", "#34D399", "#7DD3FC"]}
    >
      <div className="mb-8 flex flex-col gap-4 xl:flex-row xl:items-center xl:justify-between">
        <DenInput
          type="search"
          icon={Search}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search providers, models, or env keys..."
        />

        <Link href={getNewLlmProviderRoute(orgSlug)} className={buttonVariants({ variant: "primary" })}>
          <Plus className="h-4 w-4" aria-hidden="true" />
          Add Provider
        </Link>
      </div>

      {error ? (
        <div className="mb-6 rounded-[24px] border border-red-200 bg-red-50 px-5 py-4 text-[14px] text-red-700">
          {error}
        </div>
      ) : null}

      {busy ? (
        <div className="rounded-[28px] border border-gray-200 bg-white px-6 py-10 text-[15px] text-gray-500">
          Loading your provider library...
        </div>
      ) : filteredProviders.length === 0 ? (
        <div className="rounded-[32px] border border-dashed border-gray-200 bg-white px-6 py-12 text-center">
          <p className="text-[16px] font-medium tracking-[-0.03em] text-gray-900">
            {llmProviders.length === 0 ? "No providers configured yet." : "No providers match that search yet."}
          </p>
          <p className="mx-auto mt-3 max-w-[560px] text-[15px] leading-8 text-gray-500">
            {llmProviders.length === 0
              ? "Start with a models.dev provider, select the models you want to expose, add the credential, and then grant access to the right people or teams."
              : "Try a broader search term, or create a new provider if this org needs a different stack."}
          </p>
        </div>
      ) : (
        <div className="grid gap-4 lg:grid-cols-2 2xl:grid-cols-3">
          {filteredProviders.map((provider) => {
            const SourceIcon = getProviderSourceIcon(provider.source);
            const envNames = getProviderEnvNames(provider.providerConfig);
            const memberAccessCount = provider.access.members.length;
            const teamAccessCount = provider.access.teams.length;
            return (
              <Link
                key={provider.id}
                href={getLlmProviderRoute(orgSlug, provider.id)}
                className="block overflow-hidden rounded-[28px] border border-gray-200 bg-white p-6 transition hover:-translate-y-0.5 hover:border-gray-300 hover:shadow-[0_18px_40px_-24px_rgba(15,23,42,0.25)]"
              >
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <div className="inline-flex items-center gap-2 rounded-full border border-emerald-100 bg-emerald-50 px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.14em] text-emerald-700">
                      <SourceIcon className="h-3.5 w-3.5" />
                      {getProviderSourceLabel(provider.source)}
                    </div>
                    <h2 className="mt-4 text-[22px] font-semibold tracking-[-0.05em] text-gray-950">{provider.name}</h2>
                    <p className="mt-2 text-[14px] text-gray-500">{provider.providerId}</p>
                  </div>

                  <div className="rounded-full border border-gray-200 bg-gray-50 px-3 py-1 text-[12px] font-medium text-gray-600">
                    {provider.models.length} {provider.models.length === 1 ? "model" : "models"}
                  </div>
                </div>

                <div className="mt-5 flex flex-wrap gap-2">
                  <span className={`inline-flex items-center gap-1 rounded-full px-3 py-1 text-[12px] font-medium ${provider.hasApiKey ? "bg-emerald-50 text-emerald-700" : "bg-amber-50 text-amber-700"}`}>
                    <KeyRound className="h-3.5 w-3.5" />
                    {provider.hasApiKey ? "Credential saved" : "Credential missing"}
                  </span>
                  {envNames.slice(0, 2).map((envName) => (
                    <span key={envName} className="rounded-full bg-gray-100 px-3 py-1 text-[12px] font-medium text-gray-600">
                      {envName}
                    </span>
                  ))}
                  {envNames.length > 2 ? (
                    <span className="rounded-full bg-gray-100 px-3 py-1 text-[12px] font-medium text-gray-600">
                      +{envNames.length - 2} more keys
                    </span>
                  ) : null}
                </div>

                <div className="mt-6 grid gap-3 rounded-[24px] bg-gray-50 p-4 text-[13px] text-gray-600 sm:grid-cols-2">
                  <div>
                    <p className="font-medium text-gray-900">Access</p>
                    <p className="mt-1">{memberAccessCount} people · {teamAccessCount} teams</p>
                  </div>
                  <div>
                    <p className="font-medium text-gray-900">Updated</p>
                    <p className="mt-1">{formatProviderTimestamp(provider.updatedAt)}</p>
                  </div>
                </div>
              </Link>
            );
          })}
        </div>
      )}
    </DashboardPageTemplate>
  );
}
