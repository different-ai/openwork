"use client";

import type { WorkbotReadiness, WorkbotSettings } from "@openwork/types/den/workbot-settings";
import type { WorkbotFacts } from "../_features/feature-intros/intros/workbot";
import { useOrgDashboard } from "../_providers/org-dashboard-provider";
import { useWorkbotReadiness } from "./workbot-readiness-data";

/**
 * Facts for the Workbot intro from the settings the page loads and the same
 * readiness check as the Workbot entry. Null until both are known; a failed
 * readiness check stays null, so the page renders as before (fails open, like
 * the entry). Where Workbot isn't deployed, a provider wouldn't make it work,
 * so the page is never replaced there.
 */
export function workbotIntroFacts(input: {
  deployed: boolean;
  settings: Pick<WorkbotSettings, "model"> | null | undefined;
  readiness: WorkbotReadiness | null | undefined;
}): WorkbotFacts | null {
  if (!input.settings) return null;
  const modelChosen = input.settings.model !== null;
  if (!input.deployed) return { modelChosen, needsProvider: false };
  if (!input.readiness) return null;
  // The workspace's answer, not this admin's own allowance or team policy (older servers: the caller's).
  const gatewayRequired = input.readiness.organizationGatewayRequired ?? input.readiness.gatewayRequired;
  return { modelChosen, needsProvider: gatewayRequired && !input.readiness.hasGatewayProvider };
}

/** Runs the readiness query only while `enabled` (the `featureIntros` flag) and Workbot is deployed. */
export function useWorkbotIntroFacts(enabled: boolean, settings: WorkbotSettings | undefined): WorkbotFacts | null {
  const { orgId, orgContext } = useOrgDashboard();
  const deployed = orgContext?.capabilities.workbot === true;
  const readiness = useWorkbotReadiness(orgId ?? null, enabled && deployed);
  if (!enabled) return null;
  return workbotIntroFacts({ deployed, settings, readiness: readiness.data });
}
