import type { WorkbotReadiness } from "@openwork/types/den/workbot-settings";
import { type DenOrgAccessFlags, getMembersTeamsRoute, getNewAiGatewayProviderRoute } from "../../_lib/den-org";
import { canOpenGatewayArea } from "./gateway-dashboard-access";

export const WORKBOT_ENTRY_HREF = "/workbot";

export function workbotEntryHref(organizationId: string | null | undefined): string {
  return organizationId ? `${WORKBOT_ENTRY_HREF}?${new URLSearchParams({ organizationId })}` : WORKBOT_ENTRY_HREF;
}

export function isWorkbotEntryHref(href: string): boolean {
  return href === WORKBOT_ENTRY_HREF || href.startsWith(`${WORKBOT_ENTRY_HREF}?`);
}

export function workbotDestination(base: string, organizationId: string | string[] | undefined): string {
  if (typeof organizationId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(organizationId)) return base;
  const url = new URL(base);
  url.searchParams.set("organization", organizationId);
  return url.toString();
}

export type WorkbotEntry =
  | { kind: "open" }
  | { kind: "add-provider"; href: string }
  | { kind: "ask-admin" }
  | { kind: "off"; teamsHref: string | null };

export const WORKBOT_ENTRY_COPY = {
  addProviderTitle: "Workbot needs an AI provider",
  addProviderAction: "Add an AI provider",
  askAdminTitle: "Workbot needs an organization admin to add an AI provider",
  offTitle: "Workbot is off for your team. An admin can turn it on in Members › Teams.",
  offAction: "Open Teams",
} as const;

export function decideWorkbotEntry({
  readiness,
  access,
  orgSlug,
}: {
  readiness: WorkbotReadiness | null | undefined;
  access: DenOrgAccessFlags;
  orgSlug: string | null;
}): WorkbotEntry {
  if (!readiness) return { kind: "open" };
  if (readiness.enabled === false) {
    return { kind: "off", teamsHref: orgSlug && access.canManageModelsSettings ? getMembersTeamsRoute(orgSlug) : null };
  }
  if (!readiness.gatewayRequired || readiness.hasGatewayProvider) return { kind: "open" };
  if (orgSlug && canOpenGatewayArea(access, "manage-providers")) {
    return { kind: "add-provider", href: getNewAiGatewayProviderRoute(orgSlug) };
  }
  return { kind: "ask-admin" };
}

export function workbotNavMarker(entry: WorkbotEntry): { attention?: string; locked?: string } {
  if (entry.kind === "add-provider") return { attention: WORKBOT_ENTRY_COPY.addProviderTitle };
  if (entry.kind === "ask-admin") return { locked: WORKBOT_ENTRY_COPY.askAdminTitle };
  return {};
}
