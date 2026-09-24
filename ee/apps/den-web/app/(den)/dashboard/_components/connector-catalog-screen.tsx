"use client";

import { useQueryClient } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import { useState } from "react";
import { DenButton } from "../../_components/ui/button";
import {
  getAddConnectorRoute,
  getLibraryAddConnectorRoute,
  getLibraryConnectorRoute,
  getLibraryRoute,
  getMcpConnectionRoute,
  getMcpConnectionsRoute,
} from "../../_lib/den-org";
import { useOrgDashboard } from "../_providers/org-dashboard-provider";
import { connectionForPresetUrl, GOOGLE_WORKSPACE_QUICK_ADD_ID, MICROSOFT_365_QUICK_ADD_ID } from "./connector-catalog";
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
  const { orgSlug } = useOrgDashboard();
  const presets = useMcpConnectionPresets();
  const connections = useMcpConnections(mode === "admin" ? "manageable" : "usable");
  const usable = useMcpConnections("usable");
  const [customName, setCustomName] = useState<string | null>(null);
  const setupRoute = (catalogId?: string) => mode === "admin" ? getAddConnectorRoute(orgSlug, catalogId) : getLibraryAddConnectorRoute(orgSlug, catalogId);
  const openRoute = (connectionId: string) => mode === "admin" ? getMcpConnectionRoute(orgSlug, connectionId) : getLibraryConnectorRoute(orgSlug, connectionId);
  const known = mode === "admin"
    ? displayedConnectorConnections(connections.data ?? [], usable.data ?? [])
    : connections.data ?? [];

  const presetEntries = catalogEntriesFromPresets(presets.data ?? []).map((entry) => {
    const existing = connectionForPresetUrl(known, entry.url);
    return existing ? { ...entry, openHref: openRoute(existing.id) } : entry;
  });
  const nativeEntries = mode === "admin"
    ? NATIVE_CATALOG_ENTRIES.map((entry) => {
      const existing = nativeConnection(known, entry.id);
      return existing ? { ...entry, openHref: openRoute(existing.id) } : entry;
    })
    : [];
  const entries = presets.isLoading ? [] : [...nativeEntries, ...presetEntries];

  return (
    <ItemPage testId="connector-catalog">
      <ItemHeader
        back={mode === "admin" ? { href: getMcpConnectionsRoute(orgSlug), label: "Connectors" } : { href: getLibraryRoute(orgSlug), label: "My Library" }}
        title="Add a connector"
        actions={mode === "admin" ? (
          <DenButton variant="secondary" size="sm" icon={Plus} className="h-9" onClick={() => setCustomName("")} data-testid="add-any-mcp">
            Add any MCP
          </DenButton>
        ) : undefined}
      />
      {presets.error ? (
        <p className="text-[13px] text-red-600">{presets.error instanceof Error ? presets.error.message : "The list did not load."}</p>
      ) : null}
      <ConnectorPicker
        entries={entries}
        loading={presets.isLoading}
        mode={mode}
        customName={customName}
        onCustomNameChange={setCustomName}
        addHref={(entry) => setupRoute(entry.id)}
        customHref={(input) => `${setupRoute("custom")}${customConnectorQuery(input)}`}
      />
    </ItemPage>
  );
}
