"use client";

import { useQueryClient } from "@tanstack/react-query";
import { getLibraryRoute, getMcpConnectionsRoute, getPluginsRoute } from "../../_lib/den-org";
import { useOrgDashboard } from "../_providers/org-dashboard-provider";
import { libraryQueryOptions } from "./library-data";
import { mcpConnectionsQueryOptions } from "./mcp-connections-data";
import { pluginSummariesQueryOptions } from "./plugin-data";

/** Starts loading a sidebar destination's list on hover or focus, so the page opens filled in. */
export function useDashboardPrefetch(): (href: string) => void {
  const queryClient = useQueryClient();
  const { orgId, orgSlug } = useOrgDashboard();

  return (href) => {
    if (!orgId) return;
    if (href === getLibraryRoute(orgSlug)) {
      void queryClient.prefetchQuery(libraryQueryOptions());
      void queryClient.prefetchQuery(mcpConnectionsQueryOptions(orgId, "usable"));
    } else if (href === getPluginsRoute(orgSlug)) {
      void queryClient.prefetchQuery(pluginSummariesQueryOptions());
    } else if (href === getMcpConnectionsRoute(orgSlug)) {
      void queryClient.prefetchQuery(mcpConnectionsQueryOptions(orgId, "manageable"));
    }
  };
}
