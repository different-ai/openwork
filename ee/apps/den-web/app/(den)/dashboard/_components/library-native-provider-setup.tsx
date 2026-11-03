"use client";

import { LockKeyhole } from "lucide-react";
import { useSearchParams } from "next/navigation";
import { DenButton } from "../../_components/ui/button";
import { getAddConnectorRoute, getLibraryRoute, getOrgAccessFlags } from "../../_lib/den-org";
import { useOrgDashboard } from "../_providers/org-dashboard-provider";
import { type NativeProviderKey } from "./connector-catalog";
import { ItemHeader, ItemPage } from "./item-header";
import { ConnectorLogo } from "./item-logo";
import { connectorReturnToAgent, fromMyAgent } from "./my-agent-connector-navigation";

/** Native providers use an organization OAuth app, not an MCP catalog preset. */
export function LibraryNativeProviderSetup({ providerKey }: { providerKey: NativeProviderKey }) {
  const { orgContext, orgSlug, orgBusy } = useOrgDashboard();
  const params = useSearchParams();
  const agentBack = connectorReturnToAgent(orgSlug, params.get("from"));
  const back = agentBack ?? { href: getLibraryRoute(orgSlug), label: "My Library" };
  const name = providerKey === "google-workspace" ? "Google Workspace" : "Microsoft 365";
  const access = orgContext ? getOrgAccessFlags(orgContext.currentMember.role, orgContext.currentMember.isOwner, orgContext.currentMember.permissions) : null;
  const canSetUp = access?.canManageConnections === true && access.canViewAllConnections;
  const setupHref = getAddConnectorRoute(orgSlug, providerKey);

  return (
    <ItemPage testId="library-native-provider-setup">
      <ItemHeader compact back={back} logo={<ConnectorLogo name={name} size="md" />} title={name} />
      {orgBusy || !orgContext ? (
        <div role="status" aria-label="Checking connection access" className="h-16 animate-pulse rounded-lg bg-gray-100" />
      ) : (
        <section className="flex flex-col gap-4 border-t border-gray-100 pt-5">
          <div>
            <h2 className="flex items-center gap-2 text-[14px] font-medium text-gray-900">
              <LockKeyhole className="size-4 text-gray-500" aria-hidden />
              Needs workspace setup
            </h2>
            <p className="mt-1.5 max-w-[60ch] text-[13px] leading-5 text-gray-500">
              {providerKey === "google-workspace" ? "Gmail and Google Calendar use one Google Workspace connection. " : "Outlook and Calendar use one Microsoft 365 connection. "}
              {canSetUp ? "Add your workspace’s OAuth app, then sign in with your own account." : `Ask a workspace admin to set up ${name} and share it with you. Then you can sign in with your own account.`}
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            {canSetUp ? <DenButton size="sm" href={agentBack ? fromMyAgent(setupHref) : setupHref}>Set up {name}</DenButton> : <DenButton size="sm" disabled icon={LockKeyhole}>Admin setup required</DenButton>}
            <DenButton size="sm" variant="secondary" href={back.href}>Back to {back.label}</DenButton>
          </div>
        </section>
      )}
    </ItemPage>
  );
}
