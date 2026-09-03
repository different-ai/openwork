"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { ChevronRight, KeyRound, Plus, Search, Shield } from "lucide-react";
import { DashboardPageTemplate } from "../../_components/ui/dashboard-page-template";
import { DenBadge } from "../../_components/ui/badge";
import { DenBrandMark } from "../../_components/ui/brand-mark";
import { buttonVariants } from "../../_components/ui/button";
import { DenInput } from "../../_components/ui/input";
import { DenNotice } from "../../_components/ui/notice";
import { DenSectionHeader } from "../../_components/ui/section-header";
import { DenTable, type DenTableColumn } from "../../_components/ui/table";
import { getGatewayProviderRoute, getNewGatewayProviderRoute } from "../../_lib/den-org";
import { useOrgDashboard } from "../_providers/org-dashboard-provider";
import { useOrgInferenceProviders } from "./inference-provider-data";
import {
  getCredentialModeLabel,
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

function buildColumns(orgSlug: string | null): readonly DenTableColumn<DenInferenceProvider>[] {
  return [
  {
    key: "name",
    header: "Name",
    render: (row) => (
      <div className="flex items-center gap-3">
        <DenBrandMark
          name={row.name}
          simpleIconSlug={getProviderIconSlug(row.providerId)}
          serviceUrl={getProviderDocUrl(row.providerConfig)}
          className="h-8 w-8 rounded-[10px]"
          imageClassName="h-4 w-4"
        />
        <div className="min-w-0">
          <p className="truncate text-[14px] font-medium text-gray-950">{row.name}</p>
          <p className="truncate text-[12px] text-gray-500">{formatProviderTimestamp(row.updatedAt)}</p>
        </div>
      </div>
    ),
  },
  {
    key: "provider",
    header: "Provider",
    render: (row) => <span className="text-[13px] text-gray-600">{row.providerId}</span>,
  },
  {
    key: "models",
    header: "Models",
    render: (row) => (
      <span className="text-[13px] text-gray-600">
        {row.models.length} {row.models.length === 1 ? "model" : "models"}
      </span>
    ),
  },
  {
    key: "mode",
    header: "Credential",
    render: (row) => <span className="text-[13px] text-gray-600">{getCredentialModeLabel(row.credentialMode)}</span>,
  },
  {
    key: "credential-status",
    header: "Credential status",
    render: (row) => <InferenceCredentialStatusBadge provider={row} />,
  },
  {
    key: "status",
    header: "Status",
    render: (row) => (
      <DenBadge tone={row.status === "active" ? "success" : "neutral"}>{getProviderStatusLabel(row.status)}</DenBadge>
    ),
  },
  {
    key: "open",
    header: "",
    align: "right",
    render: (row) => (
      <Link
        href={getGatewayProviderRoute(orgSlug, row.id)}
        data-testid="gateway-provider-open"
        className="inline-flex items-center gap-1 text-[13px] font-medium text-gray-600 transition hover:text-gray-950"
      >
        Open
        <ChevronRight className="h-4 w-4" aria-hidden="true" />
      </Link>
    ),
  },
  ];
}

export function InferenceProvidersScreen() {
  const { orgId, orgSlug } = useOrgDashboard();
  const { inferenceProviders, busy, error } = useOrgInferenceProviders(orgId);
  const [query, setQuery] = useState("");
  const columns = useMemo(() => buildColumns(orgSlug), [orgSlug]);

  const filtered = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    if (!normalized) return inferenceProviders;
    return inferenceProviders.filter(
      (provider) =>
        provider.name.toLowerCase().includes(normalized) ||
        provider.providerId.toLowerCase().includes(normalized) ||
        provider.models.some((model) => model.name.toLowerCase().includes(normalized)),
    );
  }, [inferenceProviders, query]);

  return (
    <DashboardPageTemplate
      icon={Shield}
      title="Gateway providers"
      description="Connect Anthropic, OpenAI, Google, Azure and other providers through the OpenWork inference gateway. Members use their OpenWork key; the provider credential stays on the server and never reaches devices."
      colors={["#F1F5FF", "#1D4ED8", "#60A5FA", "#A7F3D0"]}
    >
      <div className="mb-8 flex flex-col gap-4 xl:flex-row xl:items-center xl:justify-between">
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
        <section className="overflow-hidden rounded-[28px] border border-gray-200 bg-white">
          <DenSectionHeader
            className="border-b border-gray-100 px-6 py-4"
            title="Your gateway providers"
            description="Each row is one provider routed via OpenWork Gateway. Open a row to see its credentials and access."
          />
          {filtered.length === 0 ? (
            <div className="px-6 py-12 text-center">
              <p className="text-[16px] font-medium tracking-[-0.03em] text-gray-900">
                {inferenceProviders.length === 0 ? "No gateway providers yet." : "No providers match that search."}
              </p>
              <p className="mx-auto mt-3 max-w-[560px] text-[15px] leading-8 text-gray-500">
                {inferenceProviders.length === 0
                  ? "Add a provider from the models.dev catalog, store its credential once, and members will use it through the OpenWork gateway with their own OpenWork key."
                  : "Try a broader search term."}
              </p>
            </div>
          ) : (
            <DenTable columns={columns} rows={filtered} getRowKey={(row) => row.id} />
          )}
        </section>
      )}
    </DashboardPageTemplate>
  );
}
