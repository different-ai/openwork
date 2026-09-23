"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { ArrowLeft, ChevronRight, Plus, Search } from "lucide-react";
import { CUSTOM_GATEWAY_PROVIDER_ID } from "@openwork/types/den/gateway-custom-provider";
import { DenBrandMark } from "../../_components/ui/brand-mark";
import { DenChip } from "../../_components/ui/chip";
import { DenInput } from "../../_components/ui/input";
import { DenNotice } from "../../_components/ui/notice";
import { getAiGatewayProvidersRoute, getNewAiGatewayProviderRoute } from "../../_lib/den-org";
import { useOrgDashboard } from "../_providers/org-dashboard-provider";
import { isSupportedGatewayNpm } from "./inference-provider-request";
import { getProviderIconSlug, requestLlmProviderCatalog, type DenModelsDevProviderSummary } from "./llm-provider-data";

/** Plain-words taglines for the providers most orgs reach for; anything else falls back to its model count. */
const TAGLINES: Record<string, string> = {
  openrouter: "One key, hundreds of models from every vendor",
  anthropic: "Claude models",
  openai: "GPT models",
  google: "Gemini models",
  "google-vertex": "Gemini and Claude on Google Cloud, your team can sign in with Google",
  "google-vertex-anthropic": "Claude on Google Cloud",
  azure: "GPT models on your Azure resource",
  mistral: "Mistral and Codestral models",
  groq: "Fast open models: Llama, Qwen, Kimi",
  deepseek: "DeepSeek V3 and R1",
  xai: "Grok models",
};
const FEATURED = Object.keys(TAGLINES);
const CUSTOM_KEYWORDS = ["custom", "openai-compatible", "openai compatible", "compatible", "self-hosted", "self hosted", "other", "another", "endpoint", "own"];

/** The custom row stays visible unless a filter is typed that clearly isn't asking for it. */
export function customProviderMatches(query: string) {
  const normalized = query.trim().toLowerCase();
  return !normalized || CUSTOM_KEYWORDS.some((keyword) => keyword.startsWith(normalized) || normalized.includes(keyword));
}
const INITIAL_ROWS = 10;

export function providerTagline(provider: Pick<DenModelsDevProviderSummary, "id" | "modelCount">) {
  return TAGLINES[provider.id] ?? `${provider.modelCount} ${provider.modelCount === 1 ? "model" : "models"}`;
}

/** Featured providers first in a stable order, then the rest alphabetically. */
export function orderCatalog<T extends { id: string; name: string }>(providers: readonly T[]): T[] {
  const rank = (id: string) => { const index = FEATURED.indexOf(id); return index === -1 ? FEATURED.length : index; };
  return [...providers].sort((a, b) => rank(a.id) - rank(b.id) || a.name.localeCompare(b.name));
}

export function InferenceProviderPickerScreen({ embedded = false }: { embedded?: boolean }) {
  const Heading = embedded ? "h2" : "h1";
  const { orgId, orgSlug } = useOrgDashboard();
  const [catalog, setCatalog] = useState<DenModelsDevProviderSummary[]>([]);
  const [query, setQuery] = useState("");
  const [showAll, setShowAll] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!orgId) return;
    let cancelled = false;
    void requestLlmProviderCatalog(orgId)
      .then((result) => { if (!cancelled) setCatalog(result); })
      .catch(() => { if (!cancelled) setError("Could not load the provider catalog."); });
    return () => { cancelled = true; };
  }, [orgId]);

  const providers = useMemo(() => {
    const supported = orderCatalog(catalog.filter((item) => isSupportedGatewayNpm(item.npm)));
    const normalized = query.trim().toLowerCase();
    return normalized ? supported.filter((item) => item.name.toLowerCase().includes(normalized) || item.id.includes(normalized) || providerTagline(item).toLowerCase().includes(normalized)) : supported;
  }, [catalog, query]);
  const visible = showAll || query.trim() ? providers : providers.slice(0, INITIAL_ROWS);
  const hidden = providers.length - visible.length;
  const showCustom = customProviderMatches(query);

  return (
    <div className={embedded ? undefined : "mx-auto max-w-[860px] px-6 py-6"}>
      <Link href={getAiGatewayProvidersRoute(orgSlug)} className="inline-flex items-center gap-1.5 text-[12px] text-gray-500 hover:text-gray-900">
        <ArrowLeft className="h-3.5 w-3.5" aria-hidden="true" />
        Back to AI Providers
      </Link>
      <Heading className="mt-2 text-[20px] font-medium tracking-[-0.02em] text-gray-900">Add a provider</Heading>
      {error ? <DenNotice tone="error" message={error} className="mt-4" /> : null}

      <div className="mt-5 rounded-[12px] border border-gray-100 bg-white">
        <div className="p-3">
          <div className="w-[200px]">
            <DenInput type="search" icon={Search} value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Filter by name…" data-testid="gateway-provider-catalog-filter" className="h-8 text-[12px]" />
          </div>
        </div>
        <ul className="divide-y divide-gray-100 border-t border-gray-100">
          {showCustom ? (
            <li>
              <Link href={getNewAiGatewayProviderRoute(orgSlug, CUSTOM_GATEWAY_PROVIDER_ID)} data-testid="gateway-provider-pick-custom" aria-label="Add a custom provider" className="flex items-center gap-3 px-4 py-2.5 hover:bg-gray-50">
                <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-[7px] border border-dashed border-gray-300 text-gray-500"><Plus className="h-3.5 w-3.5" aria-hidden="true" /></span>
                <span className="min-w-0 flex-1">
                  <span className="block text-[13px] font-medium text-gray-900">Custom provider</span>
                  <span className="block text-[12px] text-gray-500">Your own endpoint with an OpenAI-compatible API</span>
                </span>
                <ChevronRight className="h-4 w-4 shrink-0 text-gray-300" aria-hidden="true" />
              </Link>
            </li>
          ) : null}
          {visible.map((item) => (
            <li key={item.id}>
              <Link href={getNewAiGatewayProviderRoute(orgSlug, item.id)} data-testid={`gateway-provider-pick-${item.id}`} aria-label={`Add ${item.name}`} className="flex items-center gap-3 px-4 py-2.5 hover:bg-gray-50">
                <DenBrandMark name={item.name} simpleIconSlug={getProviderIconSlug(item.id)} serviceUrl={item.doc} className="h-7 w-7 shrink-0 rounded-[7px]" imageClassName="h-3.5 w-3.5" />
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-2">
                    <span className="text-[13px] font-medium text-gray-900">{item.name}</span>
                    {item.id === "openrouter" ? <DenChip size="xs">Start here</DenChip> : null}
                  </span>
                  <span className="block truncate text-[12px] text-gray-500">{providerTagline(item)}</span>
                </span>
                <ChevronRight className="h-4 w-4 shrink-0 text-gray-300" aria-hidden="true" />
              </Link>
            </li>
          ))}
          {catalog.length > 0 && providers.length === 0 && !showCustom ? <li className="px-4 py-4 text-[13px] text-gray-500">No providers match that filter. Add a custom provider for any OpenAI-compatible endpoint.</li> : null}
          {hidden > 0 ? (
            <li>
              <button type="button" onClick={() => setShowAll(true)} data-testid="gateway-provider-catalog-more" className="w-full py-2.5 text-center text-[12px] font-medium text-gray-600 hover:bg-gray-50">
                Show {hidden} more {hidden === 1 ? "provider" : "providers"}
              </button>
            </li>
          ) : null}
        </ul>
      </div>
    </div>
  );
}
