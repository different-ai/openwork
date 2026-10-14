"use client";

import { useQueryClient } from "@tanstack/react-query";
import { ChevronRight, Lock } from "lucide-react";
import { useRouter } from "next/navigation";
import type { ReactNode } from "react";
import { DenBadge } from "../../_components/ui/badge";
import { DenButton } from "../../_components/ui/button";
import { getAddConnectorRoute, getLibraryConnectorRoute, getMcpConnectionRoute, getOrgAccessFlags, orgFeatureEnabled } from "../../_lib/den-org";
import { connectionForPresetUrl } from "./connector-catalog";
import { useOrgDashboard } from "../_providers/org-dashboard-provider";
import { connectorAccountReady, connectorLimitedAccess, isManagedSlackConnection } from "./connector-detail";
import { DetailRows, ItemRow, ItemRowsSkeleton, LinkButton } from "./item-list";
import { ConnectorLogo } from "./item-logo";
import { libraryQueryKeys } from "./library-data";
import { type ExternalMcpConnection, useDisconnectMyProviderAccount, useMcpConnections } from "./mcp-connections-data";
import { useMcpAccountAuthorization } from "./use-mcp-account-authorization";

/** A usable native row proves the deployment app is configured; flags alone do not. */
export function useManagedSlackDiscovery() {
  const { orgContext } = useOrgDashboard();
  const usable = useMcpConnections("usable");
  const enabled = orgFeatureEnabled(orgContext, "nativeSlack");
  return {
    connection: enabled ? usable.data?.find((connection) => isManagedSlackConnection(connection) && !connection.policyBlocked) : undefined,
    loading: usable.isLoading,
    error: usable.error,
  };
}

/** Every managed entry starts the same member OAuth, never the custom-app wizard. */
export function useManagedSlackAction(connection: ExternalMcpConnection | undefined) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const { orgContext, orgSlug } = useOrgDashboard();
  const authorization = useMcpAccountAuthorization(() => {
    void queryClient.invalidateQueries({ queryKey: libraryQueryKeys.items });
  });
  const available = Boolean(connection && isManagedSlackConnection(connection) && !connection.policyBlocked
    && orgFeatureEnabled(orgContext, "nativeSlack"));
  const reconnect = Boolean(connection && (connection.needsReconnect || connectorLimitedAccess(connection)));
  const connected = Boolean(connection && connectorAccountReady(connection) && !reconnect);
  return {
    available,
    connected,
    label: connected ? "Manage account" : reconnect ? "Reconnect" : "Connect Slack",
    pending: authorization.connectingConnectionId === "slack" || authorization.pollingConnectionId === "slack",
    error: authorization.error?.connectionId === "slack" ? authorization.error.message : null,
    select: () => {
      if (!available || !connection) return;
      if (connected) router.push(getLibraryConnectorRoute(orgSlug, connection.id));
      else void authorization.connect(connection.id);
    },
  };
}

export function ManagedSlackAccountAction({ connection }: { connection: ExternalMcpConnection }) {
  const action = useManagedSlackAction(connection);
  return (
    <span className="flex flex-col items-end gap-1">
      <DenButton size="xs" variant="secondary" disabled={!action.available} loading={action.pending} onClick={action.select} data-testid="connect-slack-search">{action.label}</DenButton>
      {action.error ? <span role="alert" className="text-xs text-destructive">{action.error}</span> : null}
    </span>
  );
}

/** Mounted only for the Slack rollout; Activity keeps its independent server read. */
export function DashboardManagedSlack() {
  const { connection, loading, error } = useManagedSlackDiscovery();
  if (!connection && !loading && !error) return null;
  return (
    <div className="mt-5 border-b border-border" data-testid="dashboard-managed-slack">
      {loading ? <ItemRowsSkeleton label="Loading Slack account" rows={1} /> : connection ? (
        <ItemRow
          compact
          wideAction
          logo={<ConnectorLogo name="Slack" url={connection.url} />}
          title="Slack search"
          description="Provided by OpenWork"
          status={connectorLimitedAccess(connection) ? "Limited access" : undefined}
          action={<ManagedSlackAccountAction connection={connection} />}
        />
      ) : null}
      {error ? <p role="alert" className="px-3 py-2 text-[13px] text-muted-foreground">Your Slack account availability could not be checked. Reload the page to try again.</p> : null}
    </div>
  );
}

export function SlackCustomAppDisclosure({ children }: { children: ReactNode }) {
  return (
    <details className="group/slack-custom" data-testid="slack-custom-app-disclosure">
      <summary className="flex cursor-pointer list-none items-center gap-2 rounded-lg px-5 py-3 text-[13px] text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
        <ChevronRight className="size-4 shrink-0 transition-transform group-open/slack-custom:rotate-90" strokeWidth={1.5} aria-hidden />
        Use your own Slack app
      </summary>
      {children}
    </details>
  );
}

/** Personal account controls, shared by the Library and admin detail. */
export function ManagedSlackAccount({ connection, mode }: { connection: ExternalMcpConnection; mode: "member" | "admin" }) {
  const queryClient = useQueryClient();
  const { orgContext, orgSlug } = useOrgDashboard();
  const disconnect = useDisconnectMyProviderAccount();
  const action = useManagedSlackAction(connection);
  const limited = connectorLimitedAccess(connection);
  const blocked = connection.policyBlocked || !action.available;
  const canSetUpCustom = orgContext ? getOrgAccessFlags(orgContext.currentMember.role, orgContext.currentMember.isOwner, orgContext.currentMember.permissions).canManageConnections : false;
  // Management permission does not grant personal use. A Library link must
  // resolve from the usable inventory, even when the viewer is an admin.
  const customConnections = useMcpConnections(mode === "admin" && canSetUpCustom ? "manageable" : "usable");
  const existingCustom = connectionForPresetUrl(customConnections.data ?? [], "https://mcp.slack.com/mcp");
  const customHref = existingCustom
    ? mode === "admin" ? getMcpConnectionRoute(orgSlug, existingCustom.id) : getLibraryConnectorRoute(orgSlug, existingCustom.id)
    : getAddConnectorRoute(orgSlug, "slack");

  return (
    <section className="flex flex-col gap-3" data-testid="slack-search-account">
      <DetailRows rows={[
        { label: "Your account", value: connection.connectedForMe ? "Your Slack account" : "Not connected" },
        { label: "Access", value: blocked ? <DenBadge icon={Lock}>Blocked</DenBadge> : limited ? "Connected with limited access" : connection.needsReconnect ? "Reconnect required" : connection.connectedForMe ? "Connected" : "Not connected" },
      ]} />
      {blocked ? <p className="text-[13px] text-muted-foreground">{connection.policyMessage ?? "Slack search is disabled. An OpenWork administrator can restore access; you can still disconnect your account."}</p> : null}
      {limited ? <p className="text-[13px] text-muted-foreground">{limited}</p> : null}
      <div className="flex justify-end gap-2">
        {connection.connectedForMe ? <DenButton variant="secondary" size="sm" loading={disconnect.isPending} onClick={() => disconnect.mutate(connection, { onSuccess: () => { void queryClient.invalidateQueries({ queryKey: libraryQueryKeys.items }); } })} data-testid="disconnect-slack-search">Disconnect your account</DenButton> : null}
        {!blocked && !action.connected ? <DenButton size="sm" loading={action.pending} onClick={action.select} data-testid="connect-slack-search">{action.label}</DenButton> : null}
      </div>
      {action.error || disconnect.error ? <p role="alert" className="text-[13px] text-destructive">{action.error ?? disconnect.error?.message}</p> : null}
      <details className="group/slack-permissions border-t border-border">
        <summary className="flex cursor-pointer list-none items-center gap-2 rounded-lg py-3 text-[13px] text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
          <ChevronRight className="size-4 shrink-0 transition-transform group-open/slack-permissions:rotate-90" strokeWidth={1.5} aria-hidden />
          Slack search permissions
        </summary>
        <DetailRows rows={[
          { label: "Included", value: "Message search and thread excerpts" },
          { label: "Posting and replies", value: "Not supported" },
          { label: "Authorization", value: "Your account only. Slack workspace approval may be required." },
        ]} />
      </details>
      <SlackCustomAppDisclosure>
        <ItemRow wideAction logo={<ConnectorLogo name="Slack" url="https://mcp.slack.com/mcp" />} title={existingCustom?.name ?? "Slack (custom app)"} description="Organization-owned app" action={existingCustom || canSetUpCustom
          ? <LinkButton size="xs" href={customHref}>{existingCustom ? "Open" : "Set up your app"}</LinkButton>
          : <DenBadge icon={Lock}>Organization admin required</DenBadge>} />
      </SlackCustomAppDisclosure>
    </section>
  );
}
