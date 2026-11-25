export const DEN_DASHBOARD_LINKS = {
  gatewayProviders: "/dashboard/ai-gateway?tab=ai-providers",
  modelConnections: "/dashboard/library?show=models",
  members: "/dashboard/members",
  gatewayLimits: "/dashboard/ai-gateway?tab=limits",
  billing: "/dashboard/billing",
  myUsage: "/dashboard/my-usage",
} as const;

export type DenDashboardLink = keyof typeof DEN_DASHBOARD_LINKS;

export function denDashboardUrl(baseUrl: string, link: DenDashboardLink): string {
  return new URL(DEN_DASHBOARD_LINKS[link], baseUrl).toString();
}

export const DEN_YOUR_CONNECTIONS_PATH = "/dashboard/your-connections";

export function denYourConnectionUrl(baseUrl: string, connectionId: string): string | null {
  const trimmed = baseUrl.trim();
  if (!trimmed || !connectionId.trim()) return null;
  try {
    const url = new URL(DEN_YOUR_CONNECTIONS_PATH, trimmed);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    url.searchParams.set("connectionId", connectionId);
    return url.toString();
  } catch {
    return null;
  }
}

export const DEN_CONNECTOR_SETUP_PATH = "/dashboard/mcp-connections/new/";

export function denConnectorSetupUrl(baseUrl: string, presetId: string): string | null {
  const trimmed = baseUrl.trim();
  if (!trimmed || !presetId.trim()) return null;
  return new URL(`${DEN_CONNECTOR_SETUP_PATH}${encodeURIComponent(presetId)}`, trimmed).toString();
}
