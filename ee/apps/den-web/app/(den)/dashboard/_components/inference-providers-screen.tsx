"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { Plus, Search } from "lucide-react";
import { DenBrandMark } from "../../_components/ui/brand-mark";
import { DenButton, buttonVariants } from "../../_components/ui/button";
import { DenInput } from "../../_components/ui/input";
import { DenNotice } from "../../_components/ui/notice";
import { DenSkeleton } from "../../_components/ui/skeleton";
import { getAiGatewayProviderRoute, getNewAiGatewayProviderRoute } from "../../_lib/den-org";
import { useOrgDashboard } from "../_providers/org-dashboard-provider";
import { GatewayWhoCanUseModels } from "./gateway-who-can-use-models";
import { useOrgInferenceProviders } from "./inference-provider-data";
import { describeGatewayAccess, type DenInferenceProvider } from "./inference-provider-request";
import { getProviderDocUrl, getProviderIconSlug } from "./llm-provider-data";
import { LITELLM_DOC_URL, liteLlmAccessGroupId } from "./litellm-provider-data";

const ROW = "flex items-center gap-4 px-4 py-3";

function modelsLabel(provider: DenInferenceProvider) {
  if (provider.modelIds === null) return `${provider.models.length} models`;
  if (provider.modelIds.length === 0) return "All models";
  return `${provider.modelIds.length} ${provider.modelIds.length === 1 ? "model" : "models"}`;
}

function ProviderRow({ provider, orgSlug }: { provider: DenInferenceProvider; orgSlug: string | null }) {
  const { orgContext } = useOrgDashboard();
  // LiteLLM per-person keys add automatic member grants; only the access group says who may use it.
  const accessGroupId = provider.litellm ? liteLlmAccessGroupId(provider) : null;
  const audience = describeGatewayAccess(accessGroupId ? { ...provider, accessGrants: (provider.accessGrants ?? []).filter((grant) => grant.modelGroupId === accessGroupId) } : provider, {
    organization: null,
    teamName: (teamId) => orgContext?.teams.find((team) => team.id === teamId)?.name,
    memberName: (memberId) => orgContext?.members.find((member) => member.id === memberId)?.user.name,
  });
  const nobody = audience === "No one has access yet";
  const litellm = provider.litellm;
  // Per-person LiteLLM keys are ready once the admin key syncs; each person adds their own key.
  const keyReady = litellm ? litellm.hasSyncKey && (litellm.mode === "member" || provider.credentialStatus === "ready") : provider.credentialStatus === "ready";
  const ready = provider.status === "active" && keyReady && !litellm?.lastSyncError && !nobody;
  const status = provider.status === "disabled"
    ? { label: "Off", dot: "bg-gray-300", text: "text-gray-500" }
    : litellm?.lastSyncError
      ? { label: "Sync failed", dot: "bg-amber-500", text: "text-amber-700" }
      : !keyReady
      ? { label: "Add a key", dot: "bg-amber-500", text: "text-amber-700" }
      : nobody
        ? { label: "Give access", dot: "bg-amber-500", text: "text-amber-700" }
        : { label: "Ready", dot: "bg-emerald-500", text: "text-gray-600" };
  return (
    <div className={ROW} data-testid="gateway-provider-row">
      <DenBrandMark
        name={provider.providerId}
        simpleIconSlug={getProviderIconSlug(provider.providerId)}
        serviceUrl={litellm ? LITELLM_DOC_URL : getProviderDocUrl(provider.providerConfig)}
        className="h-8 w-8 shrink-0 rounded-[8px]"
        imageClassName="h-4 w-4"
      />
      <div className="min-w-0 w-[200px] shrink-0">
        <p className="truncate text-[13px] font-medium text-gray-900">{provider.name}</p>
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
  return (
    <div data-testid="gateway-providers-empty" className="flex flex-col items-center gap-4 py-12 text-center">
      <h2 className="text-[15px] font-medium text-gray-900">No providers yet</h2>
      <Link href={getNewAiGatewayProviderRoute(orgSlug)} className={buttonVariants({ variant: "primary" })} data-testid="gateway-provider-create">
        <Plus className="h-4 w-4" aria-hidden="true" />
        Add a provider
      </Link>
    </div>
  );
}

/** The AI Providers tab of AI Gateway: who can use models, then one row per provider. */
export function GatewayProvidersSection() {
  const { orgId, orgSlug } = useOrgDashboard();
  const { inferenceProviders, busy, error, reloadProviders } = useOrgInferenceProviders(orgId);
  const [query, setQuery] = useState("");
  const filtered = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    return normalized ? inferenceProviders.filter((provider) => provider.name.toLowerCase().includes(normalized) || provider.providerId.includes(normalized)) : inferenceProviders;
  }, [inferenceProviders, query]);
  const empty = !busy && !error && inferenceProviders.length === 0;

  return (
    <div>
      {error ? <DenNotice message="Could not load your providers. Your saved configuration has not changed." tone="error" presentation="inline" className="mb-6" action={<DenButton size="sm" variant="secondary" onClick={() => void reloadProviders()}>Retry</DenButton>} /> : null}

      {empty ? <EmptyState orgSlug={orgSlug} /> : (
        <>
          <GatewayWhoCanUseModels />

          <section aria-labelledby="gateway-providers-heading" className="mt-8">
            <div className="mb-3 flex items-center justify-between gap-4">
              <h2 id="gateway-providers-heading" className="text-[14px] font-medium text-gray-900">
                Providers
              </h2>
              <div className="flex items-center gap-2">
                <div className="w-[200px]">
                  <DenInput type="search" icon={Search} value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Filter by name" aria-label="Filter by name" className="h-8 text-[12px]" />
                </div>
                <Link href={getNewAiGatewayProviderRoute(orgSlug)} data-testid="gateway-provider-create" className={buttonVariants({ variant: "primary", size: "sm" })}>
                  <Plus className="h-4 w-4" aria-hidden="true" />
                  Add a provider
                </Link>
              </div>
            </div>
            <div className="divide-y divide-gray-100 rounded-[12px] border border-gray-100 bg-white" aria-busy={busy}>
              {busy && inferenceProviders.length === 0 ? Array.from({ length: 3 }, (_, index) => (
                <div key={index} className={ROW} aria-hidden="true">
                  <DenSkeleton className="size-8 shrink-0 rounded-lg" />
                  <DenSkeleton className="h-4 w-[200px] shrink-0" />
                  <DenSkeleton className="h-4 w-[140px] shrink-0" />
                  <DenSkeleton className="h-4 flex-1" />
                  <DenSkeleton className="h-4 w-[110px] shrink-0" />
                  <DenSkeleton className="h-8 w-20 shrink-0 rounded-lg" />
                </div>
              )) : filtered.length === 0 ? !error && !busy ? <p className="px-4 py-6 text-[13px] text-gray-500">No providers match that filter. Try another name.</p> : null
                : filtered.map((provider) => <ProviderRow key={provider.id} provider={provider} orgSlug={orgSlug} />)}
            </div>
          </section>
        </>
      )}
    </div>
  );
}
