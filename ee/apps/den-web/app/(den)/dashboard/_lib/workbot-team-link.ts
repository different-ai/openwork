/** Setup and model recovery have separate destinations and rollout requirements. */
export function workbotLinkPurpose(href: string): "setup" | "recovery" | null {
  const url = new URL(href);
  if (url.pathname === "/dashboard/members") return "setup";
  if (url.pathname === "/dashboard/library" && url.searchParams.getAll("show").length === 1
    && ["skills", "models", "connectors"].includes(url.searchParams.get("show") ?? "")) return "setup";
  if (url.pathname === "/dashboard/ai-gateway" && url.searchParams.getAll("tab").length === 1) {
    if (url.searchParams.get("tab") === "ai-providers") return "setup";
    if (url.searchParams.get("tab") === "openwork-models") return "recovery";
  }
  if (["/dashboard/workbot-settings", "/dashboard/billing"].includes(url.pathname)) return "recovery";
  return null;
}

/** Workbot links choose an explicit member workspace, never the browser's last active workspace. */
export function linkedWorkbotOrganization(href: string, organizations: readonly { id: string }[]): string | null {
  const url = new URL(href);
  if (!url.searchParams.has("workbotOrganizationId")) return null;
  const id = url.searchParams.get("workbotOrganizationId");
  if (!id || url.searchParams.getAll("workbotOrganizationId").length !== 1
    || !workbotLinkPurpose(href)
    || !organizations.some(org => org.id === id)) {
    throw new Error("This Workbot workspace is unavailable. Open Workbot and check your team access.");
  }
  return id;
}
