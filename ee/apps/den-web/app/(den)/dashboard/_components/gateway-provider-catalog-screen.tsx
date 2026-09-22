"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { ArrowLeft, ChevronRight, Search } from "lucide-react";
import { DenBrandMark } from "../../_components/ui/brand-mark";
import { DenInput } from "../../_components/ui/input";
import { DenNotice } from "../../_components/ui/notice";
import { getGatewayProvidersRoute, getNewGatewayProviderForCatalogRoute } from "../../_lib/den-org";
import { useOrgDashboard } from "../_providers/org-dashboard-provider";
import { getCatalogProviderBlurb, sortCatalogProviders } from "./gateway-provider-model";
import { isSupportedGatewayNpm } from "./inference-provider-request";
import { getProviderIconSlug, requestLlmProviderCatalog, type DenModelsDevProviderSummary } from "./llm-provider-data";

function CatalogRow({ provider, href }: { provider: DenModelsDevProviderSummary; href: string }) {
  const blurb = getCatalogProviderBlurb(provider.id);
  return (
    <Link href={href} data-testid="gateway-catalog-provider" className="flex min-h-11 items-center gap-3 px-4 py-2 transition-colors hover:bg-gray-50">
      <DenBrandMark name={provider.name} simpleIconSlug={getProviderIconSlug(provider.id)} serviceUrl={provider.doc} className="h-7 w-7 rounded-[8px]" imageClassName="h-4 w-4" />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[13.5px] font-medium text-gray-950">{provider.name}</span>
        {blurb ? <span className="block truncate text-[12.5px] text-gray-500">{blurb}</span> : null}
      </span>
      <ChevronRight className="h-3.5 w-3.5 shrink-0 text-gray-400" aria-hidden />
    </Link>
  );
}

/** "Add a provider": flat list, most common first, inline filter. */
export function GatewayProviderCatalogScreen() {
  const { orgId, orgSlug } = useOrgDashboard();
  const [catalog, setCatalog] = useState<DenModelsDevProviderSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [showAll, setShowAll] = useState(false);

  useEffect(() => {
    if (!orgId) return;
    let cancelled = false;
    void requestLlmProviderCatalog(orgId)
      .then((result) => { if (!cancelled) setCatalog(result.filter((provider) => isSupportedGatewayNpm(provider.npm))); })
      .catch(() => { if (!cancelled) setError("Couldn’t load providers. Reload the page to try again."); });
    return () => { cancelled = true; };
  }, [orgId]);

  const { featured, rest } = useMemo(() => sortCatalogProviders(catalog ?? []), [catalog]);
  const normalized = query.trim().toLowerCase();
  const visible = normalized
    ? [...featured, ...rest].filter((provider) => provider.name.toLowerCase().includes(normalized))
    : showAll ? [...featured, ...rest] : featured;

  return (
    <div className="mx-auto max-w-[1180px] px-6 py-8 md:px-8" data-testid="gateway-provider-catalog">
      <Link href={getGatewayProvidersRoute(orgSlug)} className="mb-3 inline-flex items-center gap-1.5 text-[13px] text-gray-500 hover:text-gray-900">
        <ArrowLeft className="h-3.5 w-3.5" aria-hidden />
        Back to AI Gateway
      </Link>
      <h1 className="mb-6 text-[22px] font-semibold tracking-[-0.3px] text-gray-950">Add a provider</h1>

      {error ? <DenNotice tone="error" message={error} className="mb-4" /> : null}

      <div className="overflow-hidden rounded-2xl border border-gray-100 bg-white">
        <div className="border-b border-gray-100 p-2.5">
          <div className="max-w-[260px]">
            <DenInput type="search" icon={Search} value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Filter by name…" aria-label="Filter by name" className="h-8 text-[13px]" />
          </div>
        </div>
        {!catalog && !error ? (
          <div className="grid gap-2 p-4" aria-label="Loading providers">
            {[0, 1, 2, 3, 4].map((index) => <span key={index} className="h-8 animate-pulse rounded bg-gray-100" />)}
          </div>
        ) : visible.length === 0 ? (
          <p className="px-4 py-6 text-center text-[13px] text-gray-500">No provider called “{query.trim()}”.</p>
        ) : (
          <div className="divide-y divide-gray-100">
            {visible.map((provider) => <CatalogRow key={provider.id} provider={provider} href={getNewGatewayProviderForCatalogRoute(orgSlug, provider.id)} />)}
          </div>
        )}
        {!normalized && !showAll && rest.length > 0 ? (
          <button type="button" onClick={() => setShowAll(true)} className="w-full border-t border-gray-100 px-4 py-2.5 text-left text-[13px] font-medium text-gray-600 hover:bg-gray-50 hover:text-gray-900" data-testid="gateway-catalog-show-more">
            Show {rest.length} more providers
          </button>
        ) : null}
      </div>
    </div>
  );
}
