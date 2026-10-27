/** Workbot recovery links choose an explicit member workspace, never the browser's last active workspace. */
export function linkedWorkbotOrganization(href: string, organizations: readonly { id: string }[]): string | null {
  const url = new URL(href);
  if (!url.searchParams.has("workbotOrganizationId")) return null;
  const id = url.searchParams.get("workbotOrganizationId");
  if (!id || url.searchParams.getAll("workbotOrganizationId").length !== 1
    || !["/dashboard/workbot-settings", "/dashboard/billing", "/dashboard/ai-gateway"].includes(url.pathname)
    || (url.pathname === "/dashboard/ai-gateway" && (url.searchParams.getAll("tab").length !== 1 || url.searchParams.get("tab") !== "openwork-models"))
    || !organizations.some(org => org.id === id)) {
    throw new Error("This Workbot workspace is unavailable. Open Workbot and check your team access.");
  }
  return id;
}
