"use client";

import Link from "next/link";
import { ArrowLeft, ExternalLink, Users } from "lucide-react";
import { DenBadge } from "../../_components/ui/badge";
import { DenButton } from "../../_components/ui/button";
import { DenNotice } from "../../_components/ui/notice";
import { DenTable, type DenTableColumn } from "../../_components/ui/table";
import { getEditGatewayProviderRoute, getGatewayProvidersRoute } from "../../_lib/den-org";
import { useOrgDashboard } from "../_providers/org-dashboard-provider";
import { useInferenceProvider } from "./inference-provider-data";
import {
  getCredentialKindLabel,
  getCredentialModeLabel,
  getProviderStatusLabel,
  getSettingLabel,
  type DenInferenceProviderCredential,
} from "./inference-provider-request";
import { InferenceCredentialStatusBadge } from "./inference-providers-screen";
import { formatProviderTimestamp, getProviderDocUrl, getProviderNpmPackage } from "./llm-provider-data";

export const GATEWAY_EXPLAINER =
  "Members call this provider through the OpenWork inference gateway with their OpenWork key; the provider credential never leaves OpenWork.";

const SECTION_CLASS =
  "mb-8 rounded-[36px] border border-gray-200 bg-white p-8 shadow-[0_18px_48px_-34px_rgba(15,23,42,0.24)]";

const credentialColumns: readonly DenTableColumn<DenInferenceProviderCredential>[] = [
  {
    key: "subject",
    header: "Holder",
    render: (row) => (
      <span className="text-[13px] text-gray-700">{row.subject === "org" ? "Organization" : "Member"}</span>
    ),
  },
  {
    key: "kind",
    header: "Kind",
    render: (row) => <span className="text-[13px] text-gray-700">{getCredentialKindLabel(row.kind)}</span>,
  },
  {
    key: "status",
    header: "Status",
    render: (row) => <DenBadge tone={row.status === "active" ? "success" : "warning"}>{row.status}</DenBadge>,
  },
  {
    key: "expires",
    header: "Expires",
    render: (row) => (
      <span className="text-[13px] text-gray-600">{row.expiresAt ? formatProviderTimestamp(row.expiresAt) : "Never"}</span>
    ),
  },
];

export function InferenceProviderDetailScreen({ inferenceProviderId }: { inferenceProviderId: string }) {
  const { orgId, orgSlug, orgContext } = useOrgDashboard();
  const { provider, busy, error } = useInferenceProvider(orgId, inferenceProviderId);

  if (busy && !provider) {
    return (
      <div className="mx-auto max-w-[1180px] px-6 py-8 md:px-8">
        <div className="rounded-[28px] border border-gray-200 bg-white px-6 py-10 text-[15px] text-gray-500">
          Loading provider details...
        </div>
      </div>
    );
  }

  if (!provider) {
    return (
      <div className="mx-auto max-w-[1180px] px-6 py-8 md:px-8">
        <DenNotice message={error ?? "That gateway provider could not be found."} tone="error" />
      </div>
    );
  }

  const docUrl = getProviderDocUrl(provider.providerConfig);
  const npm = getProviderNpmPackage(provider.providerConfig);
  const access = provider.access;
  const members = orgContext?.members ?? [];
  const teams = orgContext?.teams ?? [];
  const accessMembers = access ? members.filter((member) => access.memberIds.includes(member.id)) : [];
  const accessTeams = access ? teams.filter((team) => access.teamIds.includes(team.id)) : [];
  const settingEntries = Object.entries(provider.settings);

  return (
    <div className="mx-auto max-w-[1180px] px-6 py-8 md:px-8">
      <div className="mb-8 flex flex-col gap-3">
        <p className="text-[12px] font-semibold uppercase tracking-[0.18em] text-gray-400">Gateway provider</p>
        <h1 className="text-[34px] font-semibold tracking-[-0.07em] text-gray-950">{provider.name}</h1>
        <p className="max-w-[720px] text-[16px] leading-8 text-gray-500">{GATEWAY_EXPLAINER}</p>
      </div>

      <div className="mb-8 flex flex-wrap items-center justify-between gap-4">
        <Link
          href={getGatewayProvidersRoute(orgSlug)}
          className="inline-flex items-center gap-2 text-[15px] font-medium text-gray-500 transition hover:text-gray-900"
        >
          <ArrowLeft className="h-5 w-5" />
          Back to gateway providers
        </Link>
        <Link href={getEditGatewayProviderRoute(orgSlug, provider.id)}>
          <DenButton variant="secondary" data-testid="gateway-provider-edit">
            Edit provider
          </DenButton>
        </Link>
      </div>

      <section className={SECTION_CLASS}>
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <h2 className="text-[24px] font-semibold tracking-[-0.05em] text-gray-950">Summary</h2>
          <div className="flex flex-wrap gap-2">
            <InferenceCredentialStatusBadge provider={provider} />
            <DenBadge tone={provider.status === "active" ? "success" : "neutral"}>{getProviderStatusLabel(provider.status)}</DenBadge>
          </div>
        </div>
        <div className="mt-8 grid gap-4 md:grid-cols-2 xl:grid-cols-4">
          <SummaryTile label="Provider" value={provider.providerId} />
          <SummaryTile label="SDK" value={npm ?? "Not set"} />
          <SummaryTile label="Credential" value={getCredentialModeLabel(provider.credentialMode)} />
          <SummaryTile label="Updated" value={formatProviderTimestamp(provider.updatedAt)} />
          {settingEntries.map(([key, value]) => (
            <SummaryTile key={key} label={getSettingLabel(key)} value={value} />
          ))}
        </div>
        {docUrl ? (
          <a
            href={docUrl}
            target="_blank"
            rel="noreferrer"
            className="mt-6 inline-flex items-center gap-1 rounded-full bg-gray-100 px-3 py-1 text-[12px] font-medium text-gray-600 transition hover:bg-gray-200"
          >
            Provider docs
            <ExternalLink className="h-3.5 w-3.5" />
          </a>
        ) : null}
      </section>

      <section className={SECTION_CLASS}>
        <div className="flex items-start justify-between gap-4">
          <h2 className="text-[24px] font-semibold tracking-[-0.05em] text-gray-950">Credentials</h2>
          <span className="rounded-full bg-gray-100 px-4 py-2 text-[13px] font-medium text-gray-600">Values are never shown</span>
        </div>
        <div className="mt-6 overflow-hidden rounded-[20px] border border-gray-200">
          <DenTable
            columns={credentialColumns}
            rows={provider.credentials ?? []}
            getRowKey={(row) => `${row.subject}:${row.kind}`}
            emptyLabel={
              provider.credentialMode === "member"
                ? "No member has authorized this provider yet."
                : "No organization credential stored yet. Edit the provider to add one."
            }
          />
        </div>
      </section>

      <section className={SECTION_CLASS}>
        <div className="flex items-start justify-between gap-4">
          <h2 className="text-[24px] font-semibold tracking-[-0.05em] text-gray-950">Models</h2>
          <span className="rounded-full bg-gray-100 px-4 py-2 text-[13px] font-medium text-gray-600">
            {provider.models.length} {provider.models.length === 1 ? "model" : "models"}
          </span>
        </div>
        <div className="mt-8 grid gap-4 lg:grid-cols-2 2xl:grid-cols-3">
          {provider.models.map((model) => (
            <div key={model.id} className="rounded-[24px] border border-gray-200 bg-gray-50 p-5">
              <p className="text-[17px] font-semibold tracking-[-0.03em] text-gray-950">{model.name}</p>
              <p className="mt-1 text-[13px] text-gray-500">{model.id}</p>
            </div>
          ))}
        </div>
      </section>

      <section className={SECTION_CLASS}>
        <div className="flex items-start justify-between gap-4">
          <h2 className="text-[24px] font-semibold tracking-[-0.05em] text-gray-950">Access</h2>
          <div className="inline-flex items-center gap-2 rounded-full bg-gray-100 px-4 py-2 text-[13px] font-medium text-gray-600">
            <Users className="h-4 w-4" />
            {access?.allMembers ? "Everyone" : `${(access?.memberIds.length ?? 0) + (access?.teamIds.length ?? 0)} grants`}
          </div>
        </div>
        {access?.allMembers ? (
          <p className="mt-6 rounded-[20px] bg-gray-50 px-5 py-4 text-[14px] text-gray-600">
            Everyone in the organization — including members who join later — can use this provider.
          </p>
        ) : null}
        <div className="mt-8 grid gap-6 xl:grid-cols-2">
          <AccessList
            label="People"
            emptyLabel="No direct people access yet."
            items={accessMembers.map((member) => ({ id: member.id, title: member.user.name, description: member.user.email }))}
          />
          <AccessList
            label="Teams"
            emptyLabel="No team access yet."
            items={accessTeams.map((team) => ({
              id: team.id,
              title: team.name,
              description: `${team.memberIds.length} ${team.memberIds.length === 1 ? "member" : "members"}`,
            }))}
          />
        </div>
      </section>
    </div>
  );
}

function SummaryTile({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-[24px] bg-gray-50 p-5">
      <p className="text-[12px] font-semibold uppercase tracking-[0.16em] text-gray-400">{label}</p>
      <p className="mt-3 break-all text-[16px] font-medium text-gray-900">{value}</p>
    </div>
  );
}

function AccessList({
  label,
  emptyLabel,
  items,
}: {
  label: string;
  emptyLabel: string;
  items: Array<{ id: string; title: string; description: string }>;
}) {
  return (
    <div className="rounded-[24px] bg-gray-50 p-5">
      <p className="text-[12px] font-semibold uppercase tracking-[0.16em] text-gray-400">{label}</p>
      <div className="mt-4 grid gap-3">
        {items.length === 0 ? (
          <p className="text-[14px] text-gray-500">{emptyLabel}</p>
        ) : (
          items.map((item) => (
            <div key={item.id} className="rounded-[18px] border border-gray-200 bg-white px-4 py-3">
              <p className="text-[15px] font-medium text-gray-900">{item.title}</p>
              <p className="mt-1 text-[13px] text-gray-500">{item.description}</p>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
