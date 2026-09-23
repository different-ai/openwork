"use client";

import {
  getAddConnectorRoute,
  getAllMcpConnectionsRoute,
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
  const needsAdminSetup = new Set((presets.data ?? [])
    .filter((preset) => preset.requiresOAuthClient === true || preset.authType === "apikey")
    .map((preset) => preset.presetId));
  const addHref = (catalogId: string) => mode === "admin" && needsAdminSetup.has(catalogId)
    ? `${getMcpConnectionsRoute(orgSlug)}?${new URLSearchParams({ quickAdd: catalogId }).toString()}`
    : setupRoute(catalogId);

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
        addHref={(entry) => addHref(entry.id)}
        customHref={(input) => `${setupRoute("custom")}${customConnectorQuery(input)}`}
      />
      {mode === "admin" ? (
        <p className="text-center text-[12px] leading-4 text-gray-400">
          Need an API key, your own OAuth app, Google Workspace or Microsoft 365?{" "}
          <a href={getAllMcpConnectionsRoute(orgSlug)} className="font-medium text-gray-600 underline-offset-2 hover:text-gray-900 hover:underline">Advanced setup</a>
        </p>
      ) : null}
    </ItemPage>
  );
}
