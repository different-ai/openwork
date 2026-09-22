"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { Layers3, Plus, Search } from "lucide-react";
import { DenBrandMark } from "../../_components/ui/brand-mark";
import { buttonVariants } from "../../_components/ui/button";
import { DenInput } from "../../_components/ui/input";
import { DenNotice } from "../../_components/ui/notice";
import { DenPageHeader } from "../../_components/ui/page-header";
import { getGatewayProviderRoute, getLlmProvidersRoute, getNewGatewayProviderRoute, getOrgAccessFlags } from "../../_lib/den-org";
import { useOrgDashboard } from "../_providers/org-dashboard-provider";
import { GatewayModelAccessRow } from "./gateway-model-access-sheet";
import { ROW_STATUS_LABEL, describeProviderRow, type GatewayRowStatus } from "./gateway-provider-model";
import { GatewayUsageLimitsSection } from "./gateway-usage-limits-section";
import { GatewayUsageResetRequests } from "./gateway-usage-reset-requests";
import { GatewayUsageSection } from "./gateway-usage-section";
import { useOrgInferenceProviders } from "./inference-provider-data";
import type { DenInferenceProvider } from "./inference-provider-request";
import { getProviderDocUrl, getProviderIconSlug, useOrgLlmProviders } from "./llm-provider-data";

const STATUS_DOT: Record<GatewayRowStatus, string> = {
  ready: "bg-emerald-600",
  give_access: "bg-amber-600",
  key_missing: "bg-amber-600",
  sign_in: "bg-gray-400",
  off: "bg-gray-300",
};

function ProviderRow({ provider }: { provider: DenInferenceProvider }) {
  const { orgSlug, orgContext } = useOrgDashboard();
  const row = describeProviderRow(provider, orgContext);
  const attention = row.status === "give_access" || row.status === "key_missing";
  return (
    <Link
      href={getGatewayProviderRoute(orgSlug, provider.id)}
      data-testid="gateway-provider-open"
      aria-label={`Manage ${provider.name}`}
      className="flex min-h-14 flex-wrap items-center gap-x-4 gap-y-1 px-4 py-2.5 transition-colors hover:bg-gray-50"
    >
      <div className="flex min-w-0 items-center gap-3 md:w-[260px]">
        <DenBrandMark
          name={provider.name}
          simpleIconSlug={getProviderIconSlug(provider.providerId)}
          serviceUrl={getProviderDocUrl(provider.providerConfig)}
          className="h-8 w-8 rounded-[8px]"
          imageClassName="h-4 w-4"
        />
        <div className="min-w-0">
          <p className="truncate text-[13.5px] font-medium text-gray-950">{provider.name}</p>
          <p className="truncate font-mono text-[11.5px] text-gray-400">{provider.providerId}</p>
        </div>
      </div>
      <span className="w-[140px] truncate text-[13px] text-gray-700" data-testid="gateway-provider-models">{row.models}</span>
      <span className="min-w-0 flex-1 truncate text-[13px] text-gray-500" data-testid="gateway-provider-who">{row.who}</span>
      <span className={`inline-flex w-[120px] items-center gap-1.5 text-[12.5px] ${attention ? "text-amber-700" : "text-gray-600"}`} data-testid="gateway-provider-status">
        <span aria-hidden className={`h-1.5 w-1.5 rounded-full ${STATUS_DOT[row.status]}`} />
        {ROW_STATUS_LABEL[row.status]}
      </span>
      <span className={buttonVariants({ variant: "secondary", size: "sm" })}>Manage</span>
    </Link>
  );
}

/** First visit, nothing set up. */
function EmptyState({ addHref }: { addHref: string }) {
  const steps = [
    { title: "Pick a provider", body: "OpenRouter, Anthropic, OpenAI, Google…" },
    { title: "Paste its key, pick models", body: "All of them, or just the ones you want" },
    { title: "Choose who gets them", body: "Everyone, specific teams, or specific people" },
  ];
  return (
    <section data-testid="gateway-empty" className="flex flex-col items-center rounded-2xl border border-gray-100 bg-white px-6 py-14 text-center">
      <span className="flex h-12 w-12 items-center justify-center rounded-[14px] bg-gray-50 text-gray-500">
        <Layers3 className="h-6 w-6" aria-hidden />
      </span>
      <h2 className="mt-4 text-[16px] font-semibold text-gray-950">No providers yet</h2>
      <p className="mt-2 max-w-[520px] text-[13.5px] leading-6 text-gray-500">
        Add a provider once. Its models show up in the picker for whoever you choose, on Desktop and the web.
      </p>
      <Link href={addHref} data-testid="gateway-provider-create" className={`${buttonVariants({ variant: "primary" })} mt-6`}>
        <Plus className="h-4 w-4" aria-hidden />
        Add a provider
      </Link>
      <ol className="mt-10 grid w-full max-w-[720px] gap-6 text-left md:grid-cols-3">
        {steps.map((step, index) => (
          <li key={step.title} className="flex flex-col gap-1.5">
            <span className="flex h-6 w-6 items-center justify-center rounded-full bg-gray-100 text-[12px] font-semibold text-gray-700">{index + 1}</span>
            <span className="text-[13.5px] font-medium text-gray-950">{step.title}</span>
            <span className="text-[12.5px] text-gray-500">{step.body}</span>
          </li>
        ))}
      </ol>
    </section>
  );
}

/** AI Gateway: org rule on top, one row per provider, usage below. */
export function InferenceProvidersScreen() {
  const { orgId, orgSlug, orgContext } = useOrgDashboard();
  const access = getOrgAccessFlags(orgContext?.currentMember.role ?? "member", orgContext?.currentMember.isOwner ?? false, orgContext?.roles);
  const { inferenceProviders, busy, error } = useOrgInferenceProviders(orgId);
  const { llmProviders } = useOrgLlmProviders(orgId);
  const [query, setQuery] = useState("");
  const legacyCount = llmProviders.filter((provider) => provider.source !== "openwork").length;
  const addHref = getNewGatewayProviderRoute(orgSlug);

  const filtered = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    if (!normalized) return inferenceProviders;
    return inferenceProviders.filter((provider) => provider.name.toLowerCase().includes(normalized) || provider.providerId.toLowerCase().includes(normalized));
  }, [inferenceProviders, query]);

  const empty = !busy && !error && inferenceProviders.length === 0;

  return (
    <div className="mx-auto grid max-w-[1180px] gap-6 px-6 py-8 md:px-8" data-testid="gateway-providers-page">
      <DenPageHeader
        title="AI Gateway"
        action={empty ? null : (
          <Link href={addHref} data-testid="gateway-provider-create" className={buttonVariants({ variant: "primary" })}>
            <Plus className="h-4 w-4" aria-hidden />
            Add provider
          </Link>
        )}
      />

      {orgId && orgContext && access.isAdmin ? <GatewayUsageResetRequests key={`resets-${orgId}`} orgId={orgId} members={orgContext.members} /> : null}

      {empty ? (
        <EmptyState addHref={addHref} />
      ) : (
        <>
          {access.isAdmin ? <GatewayModelAccessRow /> : null}

          <section aria-labelledby="gateway-providers-heading" className="grid gap-3">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h2 id="gateway-providers-heading" className="text-[16px] font-semibold text-gray-950">Providers</h2>
              <div className="w-[200px]">
                <DenInput type="search" icon={Search} value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Filter by name" aria-label="Filter by name" className="h-8 text-[13px]" />
              </div>
            </div>
            {error ? <DenNotice message={error} tone="error" /> : null}
            <div className="overflow-hidden rounded-2xl border border-gray-100 bg-white">
              {busy ? (
                <div className="grid gap-2 p-4" aria-label="Loading providers">
                  {[0, 1].map((index) => <span key={index} className="h-10 animate-pulse rounded bg-gray-100" />)}
                </div>
              ) : filtered.length === 0 ? (
                <p className="px-4 py-6 text-center text-[13px] text-gray-500">No provider called “{query.trim()}”.</p>
              ) : (
                <div className="divide-y divide-gray-100">
                  {filtered.map((provider) => <ProviderRow key={provider.id} provider={provider} />)}
                </div>
              )}
            </div>
          </section>
        </>
      )}

      {legacyCount > 0 ? (
        <p className="flex flex-wrap items-center gap-2 text-[13px] text-gray-500" data-testid="gateway-legacy-note">
          {legacyCount} {legacyCount === 1 ? "provider still uses" : "providers still use"} Bring Your Own Keys.
          <Link href={getLlmProvidersRoute(orgSlug)} className="font-medium text-gray-900 underline underline-offset-2">
            Move them to AI Gateway
          </Link>
        </p>
      ) : null}

      {orgId ? <GatewayUsageSection key={orgId} orgId={orgId} /> : null}
      {orgId && orgContext && access.isAdmin ? <GatewayUsageLimitsSection key={`limits-${orgId}`} orgId={orgId} teams={orgContext.teams} members={orgContext.members} /> : null}
    </div>
  );
}
