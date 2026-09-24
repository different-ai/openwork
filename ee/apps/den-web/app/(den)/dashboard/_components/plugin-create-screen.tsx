"use client";

import { useRouter, useSearchParams } from "next/navigation";
import {
  getAddConnectorRoute,
  getLibraryAddConnectorRoute,
  getLibraryPluginRoute,
  getLibraryRoute,
  getPluginRoute,
  getPluginsRoute,
} from "../../_lib/den-org";
import { useOrgDashboard } from "../_providers/org-dashboard-provider";
import { ItemHeader, ItemPage } from "./item-header";
import { useMcpConnections } from "./mcp-connections-data";
import { PluginCreateForm } from "./plugin-create-form";

/** B1: a member makes a plugin for themselves. */
export function LibraryPluginCreateScreen() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { orgSlug } = useOrgDashboard();
  const usable = useMcpConnections("usable");
  // Members can bundle only connectors they added; Den returns access for exactly those.
  const ownConnections = (usable.data ?? []).filter((connection) => connection.access !== null && !connection.nativeProviderKey);
  const startWithSkill = searchParams.get("start") === "skill";

  return (
    <ItemPage testId="plugin-create">
      <ItemHeader back={{ href: getLibraryRoute(orgSlug), label: "My Library" }} title={startWithSkill ? "Create a skill" : "Create a plugin"} />
      <PluginCreateForm
        connections={ownConnections}
        startWith={startWithSkill ? "skill" : undefined}
        cancelHref={getLibraryRoute(orgSlug)}
        addConnectorHref={getLibraryAddConnectorRoute(orgSlug)}
        onCreated={(pluginId) => router.push(getLibraryPluginRoute(orgSlug, pluginId))}
      />
    </ItemPage>
  );
}

/** D2: an admin makes a plugin, then chooses which teams get it. */
export function AdminPluginCreateScreen() {
  const router = useRouter();
  const { orgSlug } = useOrgDashboard();
  const manageable = useMcpConnections("manageable");
  const connections = (manageable.data ?? []).filter((connection) => !connection.nativeProviderKey);

  return (
    <ItemPage testId="plugin-create">
      <ItemHeader back={{ href: getPluginsRoute(orgSlug), label: "Plugins" }} title="Create a plugin" />
      <PluginCreateForm
        connections={connections}
        cancelHref={getPluginsRoute(orgSlug)}
        addConnectorHref={getAddConnectorRoute(orgSlug)}
        footnote="Nobody else gets it until you choose who can use it."
        onCreated={(pluginId) => router.push(getPluginRoute(orgSlug, pluginId))}
      />
    </ItemPage>
  );
}
