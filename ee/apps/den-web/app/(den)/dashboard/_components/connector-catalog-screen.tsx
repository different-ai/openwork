"use client";

import {
  getAddConnectorRoute,
  getLibraryAddConnectorRoute,
  getLibraryConnectorRoute,
  getLibraryRoute,
  getMcpConnectionRoute,
  getMcpConnectionsRoute,
} from "../../_lib/den-org";
import { useOrgDashboard } from "../_providers/org-dashboard-provider";
import { connectionForPresetUrl } from "./connector-catalog";
import { catalogEntriesFromPresets, ConnectorPicker } from "./connector-picker";
import { ItemHeader, ItemPage } from "./item-header";
import { useMcpConnectionPresets, useMcpConnections } from "./mcp-connections-data";

export type ConnectorFlowMode = "member" | "admin";

export function customConnectorQuery(input: { name: string; url: string }): string {
  return `?${new URLSearchParams({ name: input.name, url: input.url }).toString()}`;
}

/** A1 to A3 and C1 to C2: pick what to connect. */
export function ConnectorCatalogScreen({ mode }: { mode: ConnectorFlowMode }) {
  const { orgSlug } = useOrgDashboard();
  const presets = useMcpConnectionPresets();
  const connections = useMcpConnections(mode === "admin" ? "manageable" : "usable");
  const setupRoute = (catalogId?: string) => mode === "admin" ? getAddConnectorRoute(orgSlug, catalogId) : getLibraryAddConnectorRoute(orgSlug, catalogId);

  const entries = catalogEntriesFromPresets(presets.data ?? []).map((entry) => {
    const existing = connectionForPresetUrl(connections.data ?? [], entry.url);
    if (!existing) return entry;
    return {
      ...entry,
      openHref: mode === "admin" ? getMcpConnectionRoute(orgSlug, existing.id) : getLibraryConnectorRoute(orgSlug, existing.id),
    };
  });

  return (
    <ItemPage testId="connector-catalog">
      <ItemHeader
        back={mode === "admin" ? { href: getMcpConnectionsRoute(orgSlug), label: "Connectors" } : { href: getLibraryRoute(orgSlug), label: "My Library" }}
        title="Add a connector"
      />
      {presets.error ? (
        <p className="text-[13px] text-red-600">{presets.error instanceof Error ? presets.error.message : "The list did not load."}</p>
      ) : null}
      <ConnectorPicker
        entries={entries}
        loading={presets.isLoading}
        addHref={(entry) => setupRoute(entry.id)}
        customHref={(input) => `${setupRoute("custom")}${customConnectorQuery(input)}`}
      />
    </ItemPage>
  );
}
