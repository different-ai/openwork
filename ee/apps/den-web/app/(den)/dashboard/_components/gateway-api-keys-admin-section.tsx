"use client";

import { gatewayApiKeyExpired, type OrganizationGatewayApiKey } from "@openwork/types/den/gateway-api-keys";
import { KeyRound, LockKeyhole, Plus } from "lucide-react";
import Link from "next/link";
import { DenButton, buttonVariants } from "../../_components/ui/button";
import { DenCard } from "../../_components/ui/card";
import { DenNotice } from "../../_components/ui/notice";
import { DenSkeleton } from "../../_components/ui/skeleton";
import { DenSwitch } from "../../_components/ui/switch";
import { DenTable, type DenTableColumn } from "../../_components/ui/table";
import { permissionLockReason } from "../../_lib/den-org";
import { FeatureIntroGate } from "../_features/feature-intros";
import { useOrgDashboard } from "../_providers/org-dashboard-provider";
import { ItemMenu } from "./item-list";
import {
  createOwnGatewayApiKeyRoute,
  formatCreated,
  formatExpiry,
  formatLastUsed,
  GATEWAY_API_KEYS_DOCS_URL,
  useOrganizationGatewayApiKeys,
  useRevokeGatewayApiKey,
  useSaveAiGatewaySettings,
} from "./gateway-api-keys-data";

const SETTING_LABEL = "Allow 3rd party tools & harnesses";

/**
 * AI Gateway › API Keys (feature `gatewayMemberApiKeys`): the organization's switch for member API keys at
 * the top, then every member's key, who owns it, when it expires and when it was last used. Admins with
 * Manage Gateway providers can revoke any key.
 */
export function GatewayApiKeysAdminSection({ canManageKeys, canManageSettings }: { canManageKeys: boolean; canManageSettings: boolean }) {
  const { orgSlug, runReauthableAction } = useOrgDashboard();
  const keys = useOrganizationGatewayApiKeys(true);
  const revoke = useRevokeGatewayApiKey("organization");
  const save = useSaveAiGatewaySettings();

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

  const { apiKeys } = keys.data;
  // Shown as saved while the change is on its way, so the switch never flips back mid-save.
  const enabled = save.isPending && save.variables?.memberApiKeys !== undefined ? save.variables.memberApiKeys : keys.data.enabled;
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
      <DenCard className="flex items-start justify-between gap-4 px-5 py-4" data-testid="gateway-api-keys-setting">
        <div className="grid min-w-0 flex-1 gap-1">
          <p className="text-[14px] font-medium text-gray-900">{SETTING_LABEL}</p>
          <p className="text-[13px] text-gray-500">Allow organization members to generate their own API keys and use the AI Gateway with 3rd party tools and harnesses.</p>
          {!canManageSettings ? (
            <p className="flex items-center gap-1.5 text-[12px] text-gray-500"><LockKeyhole size={12} aria-hidden="true" />{permissionLockReason("organization.update")}</p>
          ) : null}
          {save.error ? <p className="text-[12px] text-red-600" role="alert">{save.error.message}</p> : null}
        </div>
        <DenSwitch
          aria-label={SETTING_LABEL}
          checked={enabled}
          disabled={!canManageSettings || save.isPending}
          onChange={(next) => save.mutate({ memberApiKeys: next })}
        />
      </DenCard>

      {apiKeys.length > 0 ? (
        <>
          {!enabled ? (
            <DenNotice
              tone="warning"
              message="These keys are currently not valid: 3rd party tools are turned off, so the AI Gateway refuses them. Turn the setting above back on to make them work again."
            />
          ) : null}
          {!canManageKeys ? <p className="text-[13px] text-gray-500">{`Read only. ${permissionLockReason("gateway_providers.manage")}`}</p> : null}
          <FeatureIntroGate introKey="ai-gateway.api-keys" facts={facts}>
            <DenCard className="overflow-hidden p-0">
              <div className="px-3 py-2"><DenTable columns={columns} rows={apiKeys} getRowKey={(row) => row.id} density="compact" /></div>
            </DenCard>
          </FeatureIntroGate>
        </>
      ) : (
        <FeatureIntroGate introKey="ai-gateway.api-keys" facts={facts}>
          <ApiKeysInfoPanel enabled={enabled} href={createOwnGatewayApiKeyRoute(orgSlug)} />
        </FeatureIntroGate>
      )}
    </div>
  );
}

/** No keys yet: what member keys are, that each member creates their own, and a way to create yours. */
function ApiKeysInfoPanel({ enabled, href }: { enabled: boolean; href: string }) {
  return (
    <DenCard className="flex flex-col items-center gap-4 px-8 py-14 text-center" data-testid="gateway-api-keys-admin-empty">
      <span className="flex h-10 w-10 items-center justify-center rounded-[10px] bg-gray-50 text-gray-600"><KeyRound className="h-[18px] w-[18px]" aria-hidden="true" /></span>
      <span className="flex max-w-[460px] flex-col gap-1.5">
        <span className="text-[15px] font-medium text-gray-950">Members create their own keys</span>
        <span className="text-[13px] leading-5 text-gray-500">
          Each person creates API keys for themselves in My Library › Models, to use the models they&apos;re allowed from tools like Claude Code, Codex or Cursor.
          A key reaches only its owner&apos;s models and counts toward their limit. Every key shows up here, and you can revoke any of them.
        </span>
      </span>
      {enabled ? (
        <Link href={href} className={buttonVariants({ variant: "primary", size: "sm" })} data-testid="gateway-api-keys-create-own">
          <Plus size={14} aria-hidden="true" />
          Create your own key now
        </Link>
      ) : (
        <p className="flex items-center gap-1.5 text-[13px] text-gray-500" data-testid="gateway-api-keys-admin-off">
          <LockKeyhole size={12} aria-hidden="true" />
          Turn on {SETTING_LABEL} above to let members create keys.
        </p>
      )}
      <a href={GATEWAY_API_KEYS_DOCS_URL} target="_blank" rel="noreferrer" className="text-[12px] text-gray-600 underline underline-offset-4 hover:text-gray-900">Read the docs</a>
    </DenCard>
  );
}
