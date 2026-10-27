/**
 * Den dashboard pages the desktop opens in the browser.
 *
 * Each path must be a real den-web page, on the current Den and on the
 * self-hosted Dens desktops still connect to: tests/den-dashboard-links.test.ts
 * checks every one against den-web's routes. Link to a page's current address,
 * not to a compatibility redirect, so an older Den does not answer with a 404.
 */
export const DEN_DASHBOARD_LINKS = {
  /** AI Gateway, AI Providers tab (den-web 0.18.51+). /dashboard/gateway-providers only redirects here. */
  gatewayProviders: "/dashboard/ai-gateway?tab=ai-providers",
  /** My Library, Models. /dashboard/model-connections only redirects here, and is missing before 0.18.51. */
  modelConnections: "/dashboard/library?show=models",
  /** Members, where admins invite people (Get set up). */
  members: "/dashboard/members",
  /** AI Gateway, Limits tab: where admins set and raise members' budgets. */
  gatewayLimits: "/dashboard/ai-gateway?tab=limits",
  /** Billing: the organization's plan and subscriptions. */
  billing: "/dashboard/billing",
} as const;

export type DenDashboardLink = keyof typeof DEN_DASHBOARD_LINKS;

export function denDashboardUrl(baseUrl: string, link: DenDashboardLink): string {
  return new URL(DEN_DASHBOARD_LINKS[link], baseUrl).toString();
}
