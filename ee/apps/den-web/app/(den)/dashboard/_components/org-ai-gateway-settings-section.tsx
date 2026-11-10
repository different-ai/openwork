"use client";

import { permissionLockReason } from "../../_lib/den-org";
import { DenCard } from "../../_components/ui/card";
import { DenNotice } from "../../_components/ui/notice";
import { DenSwitch } from "../../_components/ui/switch";
import { useAiGatewaySettings, useSaveAiGatewaySettings } from "./gateway-api-keys-data";

/** Settings › General › AI Gateway (feature `gatewayMemberApiKeys`): whether members may use the Gateway from 3rd party tools. */
export function OrgAiGatewaySettingsSection({ canManage }: { canManage: boolean }) {
  const settings = useAiGatewaySettings(true);
  const save = useSaveAiGatewaySettings();
  const error = save.error ?? settings.error;
  const checked = save.isPending && save.variables?.memberApiKeys !== undefined ? save.variables.memberApiKeys : settings.data?.memberApiKeys ?? false;

  return (
    <DenCard size="spacious" className="grid gap-6" data-testid="org-ai-gateway-settings">
      <h2 className="text-[24px] font-semibold tracking-[-0.04em] text-gray-900">AI Gateway</h2>

      {error ? <DenNotice tone="error" message={error.message} /> : null}

      <div className="flex items-start justify-between gap-4 rounded-[24px] border border-gray-200 bg-white px-5 py-4" data-testid="org-ai-gateway-member-api-keys">
        <div className="grid min-w-0 flex-1 gap-1">
          <p className="text-[15px] font-medium text-gray-900">Allow 3rd party tools &amp; harnesses</p>
          <p className="text-[13px] text-gray-500">
            Allow organization members to generate their own API keys and use the AI Gateway with 3rd party tools and harnesses.
          </p>
          {!canManage ? <p className="text-[12px] text-gray-500">{permissionLockReason("organization.update")}</p> : null}
        </div>
        <DenSwitch
          aria-label="Allow 3rd party tools & harnesses"
          checked={checked}
          disabled={!settings.data || !canManage || save.isPending}
          onChange={(next) => save.mutate({ memberApiKeys: next })}
        />
      </div>
    </DenCard>
  );
}
