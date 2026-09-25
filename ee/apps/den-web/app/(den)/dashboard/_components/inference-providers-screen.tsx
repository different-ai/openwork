"use client";

import { CUSTOM_GATEWAY_PROVIDER_ID } from "@openwork/types/den/gateway-custom-provider";
import Link from "next/link";
import { useMemo, useState } from "react";
import { ArrowRight, Box, Plus, Search } from "lucide-react";
import { DenBrandMark } from "../../_components/ui/brand-mark";
import { buttonVariants } from "../../_components/ui/button";
import { DenInput } from "../../_components/ui/input";
import { DenNotice } from "../../_components/ui/notice";
import { getAiGatewayProviderRoute, getNewAiGatewayProviderRoute } from "../../_lib/den-org";
import { useOrgDashboard } from "../_providers/org-dashboard-provider";
import { GatewayWhoCanUseModels } from "./gateway-who-can-use-models";
import { useOrgInferenceProviders } from "./inference-provider-data";
import { describeGatewayAccess, type DenInferenceProvider } from "./inference-provider-request";
import { getProviderDocUrl, getProviderIconSlug } from "./llm-provider-data";

const ROW = "flex items-center gap-4 px-4 py-3";

function modelsLabel(provider: DenInferenceProvider) {
  if (provider.modelIds === null) return `${provider.models.length} models`;
  if (provider.modelIds.length === 0) return "All models";
  return `${provider.modelIds.length} ${provider.modelIds.length === 1 ? "model" : "models"}`;
}

function ProviderRow({ provider, orgSlug }: { provider: DenInferenceProvider; orgSlug: string | null }) {
  const { orgContext } = useOrgDashboard();
  const audience = describeGatewayAccess(provider, {
    organization: null,
    teamName: (teamId) => orgContext?.teams.find((team) => team.id === teamId)?.name,
    memberName: (memberId) => orgContext?.members.find((member) => member.id === memberId)?.user.name,
  });
  const nobody = audience === "No one has access yet";
  const ready = provider.status === "active" && provider.credentialStatus === "ready" && !nobody;
  const status = provider.status === "disabled"
    ? { label: "Off", dot: "bg-gray-300", text: "text-gray-500" }
    : provider.credentialStatus !== "ready"
      ? { label: "Add a key", dot: "bg-amber-500", text: "text-amber-700" }
      : nobody
        ? { label: "Give access", dot: "bg-amber-500", text: "text-amber-700" }
        : { label: "Ready", dot: "bg-emerald-500", text: "text-gray-600" };
  return (
    <div className={ROW} data-testid="gateway-provider-row">
      <DenBrandMark
        name={provider.providerId}
        simpleIconSlug={getProviderIconSlug(provider.providerId)}
        serviceUrl={getProviderDocUrl(provider.providerConfig)}
        className="h-8 w-8 shrink-0 rounded-[8px]"
        imageClassName="h-4 w-4"
      />
      <div className="min-w-0 w-[200px] shrink-0">
        <p className="truncate text-[13px] font-medium text-gray-900">{provider.name}</p>
        <p className="truncate font-mono text-[11px] text-gray-400">{providerSubtitle(provider)}</p>
      </div>
      <p className="w-[140px] shrink-0 text-[13px] text-gray-600">{modelsLabel(provider)}</p>
      <p className={`min-w-0 flex-1 truncate text-[13px] ${nobody ? "text-gray-400" : "text-gray-600"}`} data-testid="gateway-provider-audience">
        {nobody ? "No one yet" : audience}
      </p>
      <p className={`flex w-[110px] shrink-0 items-center gap-2 text-[12px] ${status.text}`} aria-label={`Status: ${status.label}`}>
        <span className={`h-1.5 w-1.5 rounded-full ${status.dot}`} aria-hidden="true" />
        {status.label}
      </p>
      <Link
        href={getAiGatewayProviderRoute(orgSlug, provider.id)}
        data-testid="gateway-provider-open"
        aria-label={`Manage ${provider.name}`}
        className={buttonVariants({ variant: "secondary", size: "sm" })}
      >
        {ready ? "Manage" : "Set up"}
      </Link>
    </div>
  );
}

function EmptyState({ orgSlug }: { orgSlug: string | null }) {
  const steps = [
    ["Pick a provider", "OpenRouter, Anthropic, OpenAI, Google…"],
    ["Paste its key, pick models", "All of them, or just the ones you want"],
    ["Choose who gets them", "Everyone, specific teams, or specific people"],
  ];
  return (
    <div data-testid="gateway-providers-empty" className="rounded-[16px] border border-dashed border-gray-200 bg-white px-8 py-12">
      <div className="mx-auto flex max-w-[420px] flex-col items-center text-center">
        <span className="flex h-10 w-10 items-center justify-center rounded-[10px] bg-gray-100 text-gray-500"><Box className="h-4 w-4" aria-hidden="true" /></span>
        <h2 className="mt-5 text-[15px] font-medium text-gray-900">No providers yet</h2>
        <p className="mt-2 text-[13px] leading-5 text-gray-500">Add a provider once. Its models show up in the picker for whoever you choose. Nobody but you sees the key.</p>
        <Link href={getNewAiGatewayProviderRoute(orgSlug)} className={buttonVariants({ variant: "primary", className: "mt-6" })} data-testid="gateway-provider-create">
          <Plus className="h-4 w-4" aria-hidden="true" />
          Add a provider
        </Link>
      </div>
      <ol className="mx-auto mt-10 flex max-w-[640px] items-start justify-between gap-2">
        {steps.map(([title, detail], index) => (
          <li key={title} className="flex flex-1 items-start gap-2">
            <div className="flex flex-1 flex-col items-center text-center">
              <span className="flex h-5 w-5 items-center justify-center rounded-full bg-gray-100 text-[11px] font-medium text-gray-600">{index + 1}</span>
              <p className="mt-3 text-[12px] font-medium text-gray-900">{title}</p>
              <p className="mt-1 text-[11px] leading-4 text-gray-400">{detail}</p>
            </div>
            {index < steps.length - 1 ? <ArrowRight className="mt-1 h-3.5 w-3.5 shrink-0 text-gray-300" aria-hidden="true" /> : null}
          </li>
        ))}
      </ol>
    </div>
  );
}

/** The AI Providers tab of AI Gateway: who can use models, then one row per provider. */
/** Catalog providers show their catalog id; a custom provider shows where it sends requests. */
function providerSubtitle(provider: { providerId: string; settings?: Record<string, unknown> }) {
  if (provider.providerId !== CUSTOM_GATEWAY_PROVIDER_ID) return provider.providerId;
  const endpoint = provider.settings?.upstreamBaseUrl;
  if (typeof endpoint !== "string") return "Custom endpoint";
  try { return new URL(endpoint).host; } catch { return "Custom endpoint"; }
}

export function GatewayProvidersSection() {
  const { orgId, orgSlug } = useOrgDashboard();
  const { inferenceProviders, busy, error } = useOrgInferenceProviders(orgId);
  const [query, setQuery] = useState("");
  const modelCount = inferenceProviders.reduce((total, provider) => total + provider.models.length, 0);
  const filtered = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    return normalized ? inferenceProviders.filter((provider) => provider.name.toLowerCase().includes(normalized) || provider.providerId.includes(normalized)) : inferenceProviders;
  }, [inferenceProviders, query]);
  const empty = !busy && inferenceProviders.length === 0;

  return (
    <div>
      {error ? <DenNotice message={error} tone="error" className="mb-6" /> : null}

      {empty ? <EmptyState orgSlug={orgSlug} /> : (
        <>
          <GatewayWhoCanUseModels />

          <section aria-labelledby="gateway-providers-heading" className="mt-8">
            <div className="mb-3 flex items-center justify-between gap-4">
              <h2 id="gateway-providers-heading" className="text-[14px] font-medium text-gray-900">
                Providers
                {!busy ? <span className="ml-2 font-normal text-gray-400">{inferenceProviders.length} · {modelCount} models</span> : null}
              </h2>
              <div className="flex items-center gap-2">
                <div className="w-[200px]">
                  <DenInput type="search" icon={Search} value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Filter by name" className="h-8 text-[12px]" />
                </div>
                <Link href={getNewAiGatewayProviderRoute(orgSlug)} data-testid="gateway-provider-create" className={buttonVariants({ variant: "primary", size: "sm" })}>
                  <Plus className="h-4 w-4" aria-hidden="true" />
                  Add provider
                </Link>
              </div>
            </div>
            <div className="divide-y divide-gray-100 rounded-[12px] border border-gray-100 bg-white">
              {busy ? <p className="px-4 py-6 text-[13px] text-gray-500">Loading providers…</p>
                : filtered.length === 0 ? <p className="px-4 py-6 text-[13px] text-gray-500">No providers match that filter.</p>
                : filtered.map((provider) => <ProviderRow key={provider.id} provider={provider} orgSlug={orgSlug} />)}
            </div>
          </section>
        </>
      )}
    </div>
  );
}
