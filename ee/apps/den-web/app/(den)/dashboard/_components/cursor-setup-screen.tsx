"use client";

import { Lock, Plus } from "lucide-react";
import { DenButton } from "../../_components/ui/button";
import { getLibraryRoute } from "../../_lib/den-org";
import { useOrgDashboard } from "../_providers/org-dashboard-provider";
import { createOwnGatewayApiKeyRoute, useMyGatewayApiKeys } from "./gateway-api-keys-data";
import { CursorSteps } from "./gateway-tool-setup";
import { ItemHeader, ItemPage } from "./item-header";
import { ItemPanel } from "./item-list";

/**
 * Library › Models › Set up Cursor: what to paste into Cursor's
 * settings, with every model's Cursor name to copy. The key itself is only shown when it is created,
 * so this page links to creating one.
 */
export function CursorSetupScreen() {
  const { orgSlug } = useOrgDashboard();
  const keys = useMyGatewayApiKeys();
  const back = { href: `${getLibraryRoute(orgSlug)}?show=models`, label: "My Library" };

  if (!keys.data && keys.isLoading) return <ItemPage><ItemHeader back={back} title="Loading..." /></ItemPage>;
  if (!keys.data) return <ItemPage><ItemHeader back={back} title="It did not load" description="Reload the page to try again." /></ItemPage>;

  const { enabled, baseUrl, apiKeys } = keys.data;
  const keyStep = (
    <span className="flex flex-wrap items-center gap-3" data-testid="cursor-setup-key">
      <span className="text-[12px] text-gray-500">{apiKeys.length === 0 ? "You have no API keys yet." : "A key is shown once, when it's created."}</span>
      {enabled ? <DenButton size="sm" variant="secondary" icon={Plus} href={createOwnGatewayApiKeyRoute(orgSlug)} data-testid="cursor-setup-create-key">Create key</DenButton> : null}
    </span>
  );

  return (
    <ItemPage testId="cursor-setup">
      <ItemHeader back={back} title="Set up Cursor" />
      {!enabled ? (
        <p className="flex items-center gap-1.5 text-[13px] text-gray-600" data-testid="cursor-setup-disabled">
          <Lock size={12} aria-hidden="true" />
          Turned off by your organization. An admin can allow 3rd party tools in AI Gateway › API Keys.
        </p>
      ) : null}
      <ItemPanel className="px-5 py-5">
        <CursorSteps apiKey={null} baseUrl={baseUrl} keyStep={keyStep} />
      </ItemPanel>
    </ItemPage>
  );
}
