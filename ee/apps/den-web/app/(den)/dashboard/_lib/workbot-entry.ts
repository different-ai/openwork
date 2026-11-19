import type { WorkbotReadiness } from "@openwork/types/den/workbot-settings";
import { type DenOrgAccessFlags, getMembersTeamsRoute, getNewAiGatewayProviderRoute } from "../../_lib/den-org";
import { canOpenGatewayArea } from "./gateway-dashboard-access";

/** The dashboard's Workbot entry, which leaves Den for the Workbot app. */
export const WORKBOT_ENTRY_HREF = "/workbot";

/** The Workbot entry for the workspace on screen, so Workbot opens for that workspace rather than its last sign-in. */
export function workbotEntryHref(organizationId: string | null | undefined): string {
  return organizationId ? `${WORKBOT_ENTRY_HREF}?${new URLSearchParams({ organizationId })}` : WORKBOT_ENTRY_HREF;
}

export function isWorkbotEntryHref(href: string): boolean {
  return href === WORKBOT_ENTRY_HREF || href.startsWith(`${WORKBOT_ENTRY_HREF}?`);
}

/** Where Den's /workbot sends the browser: Workbot, told which workspace it was opened from when that is known. */
export function workbotDestination(base: string, organizationId: string | string[] | undefined): string {
  if (typeof organizationId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(organizationId)) return base;
  const url = new URL(base);
  url.searchParams.set("organization", organizationId);
  return url.toString();
}

/**
 * What clicking Workbot does.
 * - `open`: go to Workbot as always.
 * - `add-provider`: Workbot has no AI provider and the viewer can add one in AI Gateway.
 * - `ask-admin`: Workbot has no AI provider and an organization admin has to add one.
 * - `off`: an admin turned Workbot off for the viewer. `teamsHref` is where the viewer can turn it on again,
 *   when they are allowed to.
 */
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

/**
 * A Workbot turn needs the organization's AI Gateway, and Workbot has to be on for the viewer. The check fails open:
 * readiness that hasn't loaded, or failed to load, never stops someone from opening Workbot.
 */
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
  // Off comes first: the Workbot app would only say it is off, whatever the provider's state.
  if (readiness.enabled === false) {
    return { kind: "off", teamsHref: orgSlug && access.canManageModelsSettings ? getMembersTeamsRoute(orgSlug) : null };
  }
  if (!readiness.gatewayRequired || readiness.hasGatewayProvider) return { kind: "open" };
  if (orgSlug && canOpenGatewayArea(access, "manage-providers")) {
    return { kind: "add-provider", href: getNewAiGatewayProviderRoute(orgSlug) };
  }
  return { kind: "ask-admin" };
}

/**
 * The quiet marker on the Workbot nav entry while it has no AI provider (DESIGN.md P4). Workbot turned off for the
 * viewer has no entry at all (buildDashboardNavSections), and neither has My bot, which runs on it.
 */
export function workbotNavMarker(entry: WorkbotEntry): { attention?: string; locked?: string } {
  if (entry.kind === "add-provider") return { attention: WORKBOT_ENTRY_COPY.addProviderTitle };
  if (entry.kind === "ask-admin") return { locked: WORKBOT_ENTRY_COPY.askAdminTitle };
  return {};
}
