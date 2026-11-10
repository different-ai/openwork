"use client";

import { gatewayApiKeyExpired, type OrganizationGatewayApiKey } from "@openwork/types/den/gateway-api-keys";
import { KeyRound, LockKeyhole } from "lucide-react";
import Link from "next/link";
import { DenButton } from "../../_components/ui/button";
import { DenCard } from "../../_components/ui/card";
import { DenNotice } from "../../_components/ui/notice";
import { DenSkeleton } from "../../_components/ui/skeleton";
import { DenTable, type DenTableColumn } from "../../_components/ui/table";
import { getOrgSettingsRoute, permissionLockReason } from "../../_lib/den-org";
import { FeatureIntroGate } from "../_features/feature-intros";
import { useOrgDashboard } from "../_providers/org-dashboard-provider";
import { ItemMenu } from "./item-list";
import { formatCreated, formatExpiry, formatLastUsed, useOrganizationGatewayApiKeys, useRevokeGatewayApiKey } from "./gateway-api-keys-data";

/**
 * AI Gateway › API Keys (feature `gatewayMemberApiKeys`): every member's AI Gateway API key for 3rd party
 * tools, who owns it and when it was last used. Admins with Manage Gateway providers can revoke any key.
 */
export function GatewayApiKeysAdminSection({ canManageKeys, canManageSettings }: { canManageKeys: boolean; canManageSettings: boolean }) {
  const { orgSlug, runReauthableAction } = useOrgDashboard();
  const keys = useOrganizationGatewayApiKeys(true);
  const revoke = useRevokeGatewayApiKey("organization");

  if (keys.isLoading) {
    return (
      <DenCard className="flex flex-col gap-3" aria-busy="true" data-testid="gateway-api-keys-loading">
        {[0, 1, 2].map((row) => <DenSkeleton key={row} className="h-10 w-full" />)}
      </DenCard>
    );
  }

  if (keys.error || !keys.data) {
    return (
      <DenCard className="flex flex-col items-start gap-4">
        <DenNotice tone="error" message={keys.error?.message ?? "API keys did not load. Try again."} />
        <DenButton variant="secondary" onClick={() => void keys.refetch()}>Retry</DenButton>
      </DenCard>
    );
  }

  const { enabled, apiKeys } = keys.data;
  const facts = { memberApiKeys: enabled, apiKeys: apiKeys.length };

  const columns: DenTableColumn<OrganizationGatewayApiKey>[] = [
    {
      key: "key",
      header: "Key",
      render: (row) => (
        <span className="flex min-w-0 flex-col">
          <span className="truncate text-[13px] font-medium text-gray-900">{row.name}</span>
          <span className="truncate font-mono text-[12px] text-gray-500">{row.prefix}…</span>
        </span>
      ),
    },
    {
      key: "member",
      header: "Member",
      render: (row) => (
        <span className="flex min-w-0 flex-col">
          <span className="truncate text-[13px] text-gray-900">{row.member.name}</span>
          <span className="max-w-[220px] truncate text-[12px] text-gray-500">{row.member.email}</span>
        </span>
      ),
    },
    { key: "created", header: "Created", width: "130px", render: (row) => <span className="whitespace-nowrap text-[13px] text-gray-500">{formatCreated(row.createdAt).replace(/^Created /, "")}</span> },
    {
      key: "expires",
      header: "Expires",
      width: "130px",
      render: (row) => (
        <span className={`whitespace-nowrap text-[13px] ${gatewayApiKeyExpired(row.expiresAt) ? "font-medium text-red-600" : "text-gray-500"}`}>
          {row.expiresAt === null ? "Never" : formatExpiry(row.expiresAt).replace(/^Expires /, "")}
        </span>
      ),
    },
    { key: "last-used", header: "Last used", width: "130px", render: (row) => <span className="whitespace-nowrap text-[13px] text-gray-500">{formatLastUsed(row.lastUsedAt).replace(/^Used /, "")}</span> },
    {
      key: "actions",
      header: "",
      align: "right",
      width: "56px",
      render: (row) => (
        <ItemMenu
          label={`Actions for ${row.name}`}
          entries={[{
            label: "Revoke",
            destructive: true,
            disabled: !canManageKeys,
            confirm: {
              title: `Revoke ${row.name}?`,
              description: `${row.member.name}'s tools using this key stop working right away. This can't be undone.`,
              action: "Revoke key",
            },
            onSelect: () => runReauthableAction("revoke-gateway-api-key", async () => { await revoke.mutateAsync(row.id); }),
          }]}
        />
      ),
    },
  ];

  return (
    <div className="flex flex-col gap-4" data-testid="gateway-api-keys-admin">
      {!enabled ? (
        <DenNotice
          tone="neutral"
          icon={LockKeyhole}
          message={apiKeys.length > 0
            ? "3rd party tools are turned off, so these keys don't work until they're allowed again in Settings."
            : "3rd party tools are turned off. Members can create keys once they're allowed in Settings."}
          action={canManageSettings ? <Link href={getOrgSettingsRoute(orgSlug)} className="shrink-0 text-[13px] font-medium text-gray-900 underline underline-offset-4">Open Settings</Link> : undefined}
        />
      ) : null}

      {!canManageKeys && apiKeys.length > 0 ? (
        <p className="text-[13px] text-gray-500">{`Read only. ${permissionLockReason("gateway_providers.manage")}`}</p>
      ) : null}

      <FeatureIntroGate introKey="ai-gateway.api-keys" facts={facts}>
        {apiKeys.length === 0 ? (
          <DenCard className="flex flex-col items-center gap-4 px-8 py-16 text-center" data-testid="gateway-api-keys-admin-empty">
            <span className="flex h-10 w-10 items-center justify-center rounded-[10px] bg-gray-50 text-gray-600"><KeyRound className="h-[18px] w-[18px]" aria-hidden="true" /></span>
            <span className="flex flex-col gap-1">
              <span className="text-[15px] font-medium text-gray-950">No API keys yet</span>
              <span className="text-[13px] text-gray-500">Keys members create in their Library for 3rd party tools show up here.</span>
            </span>
          </DenCard>
        ) : (
          <DenCard className="overflow-hidden p-0">
            <div className="px-3 py-2"><DenTable columns={columns} rows={apiKeys} getRowKey={(row) => row.id} density="compact" /></div>
          </DenCard>
        )}
      </FeatureIntroGate>
    </div>
  );
}
