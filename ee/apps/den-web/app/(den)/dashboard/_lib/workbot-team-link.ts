/** Setup and model recovery have separate destinations and rollout requirements. */
export function workbotLinkPurpose(href: string): "setup" | "recovery" | null {
  const url = new URL(href);
  if (url.pathname === "/dashboard/members") return "setup";
  if (url.pathname === "/dashboard/library/model-providers/new") return "setup";
  if (url.pathname === "/dashboard/your-connections" && url.searchParams.getAll("connectionId").length === 1
    && Boolean(url.searchParams.get("connectionId"))) return "setup";
  if (url.pathname === "/dashboard/library" && url.searchParams.getAll("show").length === 1
    && ["skills", "models", "connectors"].includes(url.searchParams.get("show") ?? "")) return "setup";
  if (url.pathname === "/dashboard/ai-gateway" && url.searchParams.getAll("tab").length === 1) {
    if (url.searchParams.get("tab") === "ai-providers") return "setup";
    if (url.searchParams.get("tab") === "openwork-models") return "recovery";
  }
  if (["/dashboard/workbot-settings", "/dashboard/billing"].includes(url.pathname)) return "recovery";
  return null;
}

/** Only known Workbot destinations may survive sign-in; access is checked after authentication. */
export function workbotAuthReturnTo(value: string | null | undefined): string | null {
  if (!value || value.length > 2048 || !value.startsWith("/") || value.startsWith("//") || /[\\\s\u0000-\u001f\u007f]/.test(value)) return null;
  const url = new URL(value, "https://workbot-return.invalid");
  if (url.origin !== "https://workbot-return.invalid" || url.hash || !workbotLinkPurpose(url.href)
    || url.searchParams.getAll("workbotOrganizationId").length !== 1 || !url.searchParams.get("workbotOrganizationId")) return null;
  const allowed = new Set(["workbotOrganizationId", "show", "tab", "connectionId"]);
  if ([...url.searchParams.keys()].some(key => !allowed.has(key))) return null;
  return `${url.pathname}${url.search}`;
}

export function workbotSignInRoute(href: string): string {
  const url = new URL(href);
  const returnTo = workbotAuthReturnTo(`${url.pathname}${url.search}`);
  return returnTo ? `/?${new URLSearchParams({ mode: "sign-in", workbotReturnTo: returnTo })}` : "/";
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
