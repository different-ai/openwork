"use client";

import { gatewayApiKeyExpired, type OrganizationGatewayApiKey } from "@openwork/types/den/gateway-api-keys";
import { KeyRound, LockKeyhole, Plus } from "lucide-react";
import Link from "next/link";
import { DenButton, buttonVariants } from "../../_components/ui/button";
import { AUTOMATION_CARD_CLASS, CARD_TITLE_CLASS } from "../../_components/ui/dashboard-styles";
import { DenNotice } from "../../_components/ui/notice";
import { DenSwitch } from "../../_components/ui/switch";
import { isReauthRequiredError } from "../../_lib/den-flow";
import { permissionLockReason } from "../../_lib/den-org";
import { FeatureIntroGate } from "../_features/feature-intros";
import { useOrgDashboard } from "../_providers/org-dashboard-provider";
import { ItemMenu } from "./item-list";
import { ListRow, RowLane, RowLaneLabel, RowList, RowListHeader, RowListSkeleton } from "../_features/computers/computer-rows";
import { GATEWAY_LANE } from "./gateway-rows";
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
 * AI Gateway › API Keys: the organization's switch for member API keys at
 * the top, then every member's key, who owns it, when it expires and when it was last used. Admins with
 * Manage Gateway providers can revoke any key.
 */
export function GatewayApiKeysAdminSection({ canManageKeys, canManageSettings }: { canManageKeys: boolean; canManageSettings: boolean }) {
  const { orgSlug, runReauthableAction } = useOrgDashboard();
  const keys = useOrganizationGatewayApiKeys();
  const revoke = useRevokeGatewayApiKey("organization");
  const save = useSaveAiGatewaySettings();

  if (keys.isLoading) {
    return (
      <div aria-busy="true" data-testid="gateway-api-keys-loading">
        <RowListSkeleton rows={3} />
      </div>
    );
  }

  if (keys.error || !keys.data) {
    return (
      <div className={`${AUTOMATION_CARD_CLASS} flex flex-col items-start gap-4 p-4`}>
        <DenNotice tone="error" message={keys.error?.message ?? "API keys did not load. Try again."} />
        <DenButton variant="secondary" size="sm" onClick={() => void keys.refetch()}>Retry</DenButton>
      </div>
    );
  }

  const { apiKeys } = keys.data;
  // Shown as saved while the change is on its way, so the switch never flips back mid-save.
  const enabled = save.isPending && save.variables?.memberApiKeys !== undefined ? save.variables.memberApiKeys : keys.data.enabled;
  const facts = { memberApiKeys: enabled, apiKeys: apiKeys.length };

  const keyMenu = (row: OrganizationGatewayApiKey) => (
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
  );

  return (
    <div className="flex flex-col gap-4" data-testid="gateway-api-keys-admin">
      <div className={`${AUTOMATION_CARD_CLASS} flex items-start justify-between gap-4 p-4`} data-testid="gateway-api-keys-setting">
        <div className="grid min-w-0 flex-1 gap-1">
          <p className={CARD_TITLE_CLASS}>{SETTING_LABEL}</p>
          <p className="text-[13px] text-[color:var(--dls-text-secondary)]">Allow organization members to generate their own API keys and use the AI Gateway with 3rd party tools and harnesses.</p>
          {!canManageSettings ? (
            <p className="flex items-center gap-1.5 text-[12px] text-[color:var(--dls-text-secondary)]"><LockKeyhole size={12} aria-hidden="true" />{permissionLockReason("organization.update")}</p>
          ) : null}
          {save.error && !isReauthRequiredError(save.error) ? <p className="text-[12px] text-[var(--ow-danger)]" role="alert">{save.error.message}</p> : null}
        </div>
        <DenSwitch
          aria-label={SETTING_LABEL}
          checked={enabled}
          disabled={!canManageSettings || save.isPending}
          // Changing a workspace setting needs a recent sign-in; the dialog opens and the change retries.
          onChange={(next) => void runReauthableAction("save-ai-gateway-settings", async () => { await save.mutateAsync({ memberApiKeys: next }); }).catch(() => undefined)}
        />
      </div>

      {apiKeys.length > 0 ? (
        <>
          {!enabled ? (
            <DenNotice
              tone="warning"
              message="These keys are currently not valid: 3rd party tools are turned off, so the AI Gateway refuses them. Turn the setting above back on to make them work again."
            />
          ) : null}
          {!canManageKeys ? <p className="text-[13px] text-[color:var(--dls-text-secondary)]">{`Read only. ${permissionLockReason("gateway_providers.manage")}`}</p> : null}
          <FeatureIntroGate introKey="ai-gateway.api-keys" facts={facts}>
            <RowList label="API keys" header={<RowListHeader lead="Key" menu>
              <RowLaneLabel lane={GATEWAY_LANE.keyMember}>Member</RowLaneLabel>
              <RowLaneLabel lane={GATEWAY_LANE.keyDate}>Created</RowLaneLabel>
              <RowLaneLabel lane={GATEWAY_LANE.keyDate}>Expires</RowLaneLabel>
              <RowLaneLabel lane={GATEWAY_LANE.keyDate}>Last used</RowLaneLabel>
            </RowListHeader>}>
              {apiKeys.map((row) => (
                <ListRow
                  key={row.id}
                  icon={KeyRound}
                  name={row.name}
                  secondLine={<span className="font-mono">{row.prefix}…</span>}
                  lanes={<>
                    <RowLane lane={`${GATEWAY_LANE.keyMember} flex-col justify-center`} title={row.member.email}>
                      <span className="truncate">{row.member.name}</span>
                      <span className="truncate text-[12px] leading-4 text-[color:var(--dls-text-secondary)]">{row.member.email}</span>
                    </RowLane>
                    <RowLane lane={`${GATEWAY_LANE.keyDate} truncate text-[color:var(--dls-text-secondary)]`}>{formatCreated(row.createdAt).replace(/^Created /, "")}</RowLane>
                    <RowLane lane={`${GATEWAY_LANE.keyDate} truncate ${gatewayApiKeyExpired(row.expiresAt) ? "font-medium text-[var(--ow-danger)]" : "text-[color:var(--dls-text-secondary)]"}`}>
                      {row.expiresAt === null ? "Never" : formatExpiry(row.expiresAt).replace(/^Expires /, "")}
                    </RowLane>
                    <RowLane lane={`${GATEWAY_LANE.keyDate} truncate text-[color:var(--dls-text-secondary)]`}>{formatLastUsed(row.lastUsedAt).replace(/^Used /, "")}</RowLane>
                  </>}
                  action={keyMenu(row)}
                />
              ))}
            </RowList>
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
    <div className={`${AUTOMATION_CARD_CLASS} flex flex-col items-center gap-4 p-4 py-14 text-center`} data-testid="gateway-api-keys-admin-empty">
      <span className="flex h-10 w-10 items-center justify-center rounded-[10px] bg-[var(--dls-hover)] text-[color:var(--dls-text-secondary)]"><KeyRound size={18} strokeWidth={1.5} aria-hidden="true" /></span>
      <span className="flex max-w-[460px] flex-col gap-1.5">
        <span className={CARD_TITLE_CLASS}>Members create their own keys</span>
        <span className="text-[13px] leading-5 text-[color:var(--dls-text-secondary)]">
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
        <p className="flex items-center gap-1.5 text-[13px] text-[color:var(--dls-text-secondary)]" data-testid="gateway-api-keys-admin-off">
          <LockKeyhole size={12} aria-hidden="true" />
          Turn on {SETTING_LABEL} above to let members create keys.
        </p>
      )}
      <a href={GATEWAY_API_KEYS_DOCS_URL} target="_blank" rel="noreferrer" className="text-[12px] text-[color:var(--dls-text-secondary)] underline underline-offset-4 hover:text-[color:var(--dls-text-primary)]">Read the docs</a>
    </div>
  );
}
