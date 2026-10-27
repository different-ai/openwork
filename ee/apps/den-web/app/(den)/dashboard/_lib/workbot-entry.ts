import type { WorkbotReadiness } from "@openwork/types/den/workbot-settings";
import { type DenOrgAccessFlags, getNewAiGatewayProviderRoute } from "../../_lib/den-org";
import { canOpenGatewayArea } from "./gateway-dashboard-access";

/** The dashboard's Workbot entry, which leaves Den for the Workbot app. */
export const WORKBOT_ENTRY_HREF = "/workbot";

/**
 * What clicking Workbot does.
 * - `open`: go to Workbot as always.
 * - `add-provider`: Workbot has no AI provider and the viewer can add one in AI Gateway.
 * - `ask-admin`: Workbot has no AI provider and an organization admin has to add one.
 */
export type WorkbotEntry =
  | { kind: "open" }
  | { kind: "add-provider"; href: string }
  | { kind: "ask-admin" };

export const WORKBOT_ENTRY_COPY = {
  addProviderTitle: "Workbot needs an AI provider",
  addProviderAction: "Add an AI provider",
  askAdminTitle: "Workbot needs an organization admin to add an AI provider",
} as const;

/**
 * A Workbot turn needs the organization's AI Gateway. The check fails open: readiness that hasn't loaded, or failed
 * to load, never stops someone from opening Workbot.
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
  if (!readiness.gatewayRequired || readiness.hasGatewayProvider) return { kind: "open" };
  if (orgSlug && canOpenGatewayArea(access, "manage-providers")) {
    return { kind: "add-provider", href: getNewAiGatewayProviderRoute(orgSlug) };
  }
  return { kind: "ask-admin" };
}

/** The quiet marker on the Workbot nav entry while it is blocked (DESIGN.md P4): never hidden. */
export function workbotNavMarker(entry: WorkbotEntry): { attention?: string; locked?: string } {
  if (entry.kind === "add-provider") return { attention: WORKBOT_ENTRY_COPY.addProviderTitle };
  if (entry.kind === "ask-admin") return { locked: WORKBOT_ENTRY_COPY.askAdminTitle };
  return {};
}
