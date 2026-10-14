"use client";

import { useQueryClient } from "@tanstack/react-query";
import { Lock } from "lucide-react";
import { useState } from "react";
import { DenBadge } from "../../_components/ui/badge";
import {
  getAddConnectorRoute,
  getLibraryAddConnectorRoute,
  getLibraryConnectorRoute,
  getLibraryRoute,
  getMcpConnectionRoute,
  getMcpConnectionsRoute,
  getOrgAccessFlags,
} from "../../_lib/den-org";
import { useOrgDashboard } from "../_providers/org-dashboard-provider";
import { connectionForPresetUrl, GOOGLE_WORKSPACE_QUICK_ADD_ID, MICROSOFT_365_QUICK_ADD_ID, SLACK_SEARCH_QUICK_ADD_ID } from "./connector-catalog";
import { ManagedSlackAccountAction, useManagedSlackDiscovery } from "./managed-slack";
import { displayedConnectorConnections } from "./connector-detail";
import { type CatalogEntry, catalogEntriesFromPresets, ConnectorPicker } from "./connector-picker";
import { ItemHeader, ItemPage } from "./item-header";
import { preloadConnectorLogo } from "./item-logo";
import {
  type ExternalMcpConnection,
  mcpConnectionPresetsQueryOptions,
  useMcpConnectionPresets,
  useMcpConnections,
} from "./mcp-connections-data";

export type ConnectorFlowMode = "member" | "admin";

export function customConnectorQuery(input: { name: string; url: string }): string {
  return `?${new URLSearchParams({ name: input.name, url: input.url }).toString()}`;
}

/** Loads the catalog and its logos ahead of "Add a connector", so it opens filled in. */
export function usePrefetchConnectorCatalog(): () => void {
  const queryClient = useQueryClient();
  return () => {
    void queryClient.fetchQuery(mcpConnectionPresetsQueryOptions()).then(
      (presets) => { for (const preset of presets) preloadConnectorLogo(preset.displayName, preset.url); },
      () => undefined,
    );
  };
}

/** Google Workspace and Microsoft 365 are org OAuth apps, set up by admins only. */
export const NATIVE_CATALOG_ENTRIES: CatalogEntry[] = [
  { id: GOOGLE_WORKSPACE_QUICK_ADD_ID, name: "Google Workspace", description: "Gmail, Drive, Calendar, Sheets and Chat", url: "https://workspace.google.com" },
  { id: MICROSOFT_365_QUICK_ADD_ID, name: "Microsoft 365", description: "Outlook, Calendar, OneDrive and Teams", url: "https://www.microsoft.com/microsoft-365" },
];

function nativeConnection(connections: readonly ExternalMcpConnection[], providerKey: string): ExternalMcpConnection | undefined {
  return connections.find((connection) => connection.id === providerKey || connection.nativeProviderKey === providerKey);
}

/** A1 to A3 and C1 to C2: pick what to connect. */
export function ConnectorCatalogScreen({ mode }: { mode: ConnectorFlowMode }) {
  const { orgSlug, orgContext } = useOrgDashboard();
  const managedSlack = useManagedSlackDiscovery();
  const canSetUpCustom = orgContext ? getOrgAccessFlags(orgContext.currentMember.role, orgContext.currentMember.isOwner, orgContext.currentMember.permissions).canManageConnections : false;
  const presets = useMcpConnectionPresets();
  const connections = useMcpConnections(mode === "admin" ? "manageable" : "usable");
  const usable = useMcpConnections("usable");
  const [customName, setCustomName] = useState<string | null>(null);
  const setupRoute = (catalogId?: string) => mode === "admin" ? getAddConnectorRoute(orgSlug, catalogId) : getLibraryAddConnectorRoute(orgSlug, catalogId);
  const openRoute = (connectionId: string) => mode === "admin" ? getMcpConnectionRoute(orgSlug, connectionId) : getLibraryConnectorRoute(orgSlug, connectionId);
  const known = mode === "admin"
    ? displayedConnectorConnections(connections.data ?? [], usable.data ?? [])
    : connections.data ?? [];

  const presetEntries = catalogEntriesFromPresets(presets.data ?? []).map((entry): CatalogEntry => {
    const existing = connectionForPresetUrl(known, entry.url);
    if (existing) return { ...entry, name: entry.customSlackApp ? existing.name : entry.name, openHref: openRoute(existing.id) };
    if (entry.customSlackApp && !canSetUpCustom) return { ...entry, action: <DenBadge icon={Lock}>Organization admin required</DenBadge> };
    return entry;
  });
  const nativeEntries = mode === "admin"
    ? NATIVE_CATALOG_ENTRIES.map((entry): CatalogEntry => {
      const existing = nativeConnection(known, entry.id);
      if (existing && entry.id === GOOGLE_WORKSPACE_QUICK_ADD_ID) {
        return { ...entry, addLabel: "Add another" };
      }
      return existing ? { ...entry, openHref: openRoute(existing.id) } : entry;
    })
    : [];
  const managedEntries: CatalogEntry[] = managedSlack.connection ? [{
    id: SLACK_SEARCH_QUICK_ADD_ID,
    name: "Slack search",
    description: "Provided by OpenWork",
    url: managedSlack.connection.url,
    action: <ManagedSlackAccountAction connection={managedSlack.connection} />,
  }] : [];
  const entries = [...managedEntries, ...nativeEntries, ...presetEntries];

  return (
    <ItemPage testId="connector-catalog">
      <ItemHeader
        compact
        back={mode === "admin" ? { href: getMcpConnectionsRoute(orgSlug), label: "Connectors" } : { href: getLibraryRoute(orgSlug), label: "My Library" }}
        title="Add a connector"
      />
      {presets.error ? (
        <p className="text-[13px] text-red-600">{presets.error instanceof Error ? presets.error.message : "The list did not load."}</p>
      ) : null}
      {managedSlack.error ? <p role="alert" className="text-[13px] text-destructive">Your account availability could not be checked. Reload the page to try again.</p> : null}
      <ConnectorPicker
        entries={entries}
        loading={presets.isLoading || managedSlack.loading}
        mode={mode}
        customName={customName}
        onCustomNameChange={setCustomName}
        addHref={(entry) => entry.id === SLACK_SEARCH_QUICK_ADD_ID ? getLibraryConnectorRoute(orgSlug, "slack")
          : entry.customSlackApp && canSetUpCustom ? getAddConnectorRoute(orgSlug, "slack") : setupRoute(entry.id)}
        customHref={(input) => `${setupRoute("custom")}${customConnectorQuery(input)}`}
      />
    </ItemPage>
  );
}
