"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { Cable, Search, Store } from "lucide-react";
import { PaperMeshGradient } from "@openwork/ui/react";
import { DashboardPageTemplate } from "../../../../_components/ui/dashboard-page-template";
import { DenInput } from "../../../../_components/ui/input";
import { buttonVariants } from "../../../../_components/ui/button";
import { getIntegrationsRoute, getMarketplaceRoute } from "../../../../_lib/den-org";
import { useOrgDashboard } from "../_providers/org-dashboard-provider";
import { useHasAnyIntegration } from "./integration-data";
import { formatMarketplaceTimestamp, useMarketplaces } from "./marketplace-data";

export function MarketplacesScreen() {
  const { orgSlug } = useOrgDashboard();
  const { data: marketplaces = [], isLoading, error } = useMarketplaces();
  const { hasAny: hasAnyIntegration, isLoading: integrationsLoading } = useHasAnyIntegration();
  const [query, setQuery] = useState("");

  const normalizedQuery = query.trim().toLowerCase();
  const filtered = useMemo(() => {
    if (!normalizedQuery) return marketplaces;
    return marketplaces.filter((marketplace) =>
      `${marketplace.name}\n${marketplace.description ?? ""}`.toLowerCase().includes(normalizedQuery),
    );
  }, [marketplaces, normalizedQuery]);

  return (
    <DashboardPageTemplate
      icon={Store}
      badgeLabel="Preview"
      title="Marketplaces"
      description="Marketplaces group plugins imported from a Claude marketplace repository."
      colors={["#FEF3C7", "#92400E", "#F59E0B", "#FDE68A"]}
    >
      <div className="mb-6">
        <DenInput
          type="search"
          icon={Search}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search marketplaces..."
        />
      </div>

      {error ? (
        <div className="mb-6 rounded-[24px] border border-red-200 bg-red-50 px-5 py-4 text-[14px] text-red-700">
          {error instanceof Error ? error.message : "Failed to load marketplaces."}
        </div>
      ) : null}

      {isLoading || integrationsLoading ? (
        <div className="rounded-2xl border border-gray-100 bg-white px-6 py-10 text-[14px] text-gray-500">
          Loading marketplaces…
        </div>
      ) : !hasAnyIntegration ? (
        <ConnectIntegrationEmptyState integrationsHref={getIntegrationsRoute(orgSlug)} />
      ) : filtered.length === 0 ? (
        <EmptyState
          title={marketplaces.length === 0 ? "No marketplaces yet" : "No marketplaces match that search"}
          description={
            marketplaces.length === 0
              ? "Marketplaces show up here when you import a repository that has a `.claude-plugin/marketplace.json` manifest."
              : "Try a different search term or open the plugins tab."
          }
          action={
            marketplaces.length === 0
              ? { href: getIntegrationsRoute(orgSlug), label: "Open Integrations", icon: Cable }
              : undefined
          }
        />
      ) : (
        <div className="grid gap-3 md:grid-cols-2">
          {filtered.map((marketplace) => (
            <Link
              key={marketplace.id}
              href={getMarketplaceRoute(orgSlug, marketplace.id)}
              className="group block overflow-hidden rounded-2xl border border-gray-100 bg-white transition hover:-translate-y-0.5 hover:border-gray-200 hover:shadow-[0_8px_24px_-12px_rgba(15,23,42,0.12)]"
            >
              <div className="flex items-stretch">
                <div className="relative w-[68px] shrink-0 overflow-hidden">
                  <div className="absolute inset-0">
                    <PaperMeshGradient seed={marketplace.id} speed={0} />
                  </div>
                  <div className="relative flex h-full items-center justify-center">
                    <div className="flex h-10 w-10 items-center justify-center rounded-[12px] border border-white/60 bg-white shadow-[0_8px_20px_-8px_rgba(15,23,42,0.3)]">
                      <Store className="h-4 w-4 text-gray-700" aria-hidden />
                    </div>
                  </div>
                </div>

                <div className="min-w-0 flex-1 px-5 py-4">
                  <div className="flex items-start justify-between gap-3">
                    <h2 className="truncate text-[14px] font-semibold tracking-[-0.01em] text-gray-900">
                      {marketplace.name}
                    </h2>
                    <span className="shrink-0 rounded-full bg-gray-50 px-2 py-0.5 text-[11px] text-gray-500">
                      {marketplace.pluginCount} plugin{marketplace.pluginCount === 1 ? "" : "s"}
                    </span>
                  </div>
                  {marketplace.description ? (
                    <p className="mt-0.5 line-clamp-2 text-[12.5px] leading-[1.55] text-gray-500">
                      {marketplace.description}
                    </p>
                  ) : null}
                  <p className="mt-3 text-[11.5px] text-gray-400">
                    Added {formatMarketplaceTimestamp(marketplace.createdAt)}
                  </p>
                </div>
              </div>
            </Link>
          ))}
        </div>
      )}
    </DashboardPageTemplate>
  );
}

function EmptyState({
  title,
  description,
  action,
}: {
  title: string;
  description: string;
  action?: { href: string; label: string; icon: React.ComponentType<{ className?: string }> };
}) {
  const ActionIcon = action?.icon;
  return (
    <div className="rounded-2xl border border-dashed border-gray-200 bg-white px-6 py-12 text-center">
      <p className="text-[15px] font-semibold tracking-[-0.02em] text-gray-900">{title}</p>
      <p className="mx-auto mt-2 max-w-[520px] text-[13px] leading-6 text-gray-500">{description}</p>
      {action ? (
        <div className="mt-5 flex justify-center">
          <Link href={action.href} className={buttonVariants({ variant: "primary", size: "sm" })}>
            {ActionIcon ? <ActionIcon className="h-4 w-4" aria-hidden="true" /> : null}
            {action.label}
          </Link>
        </div>
      ) : null}
    </div>
  );
}

function ConnectIntegrationEmptyState({ integrationsHref }: { integrationsHref: string }) {
  return (
    <EmptyState
      title="Connect an integration to discover marketplaces"
      description="Marketplaces are created when OpenWork finds a `.claude-plugin/marketplace.json` manifest in a connected repository."
      action={{ href: integrationsHref, label: "Open Integrations", icon: Cable }}
    />
  );
}
