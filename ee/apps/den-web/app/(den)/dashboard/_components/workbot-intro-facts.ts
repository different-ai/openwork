"use client";

import type { WorkbotReadiness, WorkbotSettings } from "@openwork/types/den/workbot-settings";
import type { WorkbotFacts } from "../_features/feature-intros/intros/workbot";
import { useOrgDashboard } from "../_providers/org-dashboard-provider";
import { useWorkbotReadiness } from "./workbot-readiness-data";

export function workbotIntroFacts(input: {
  deployed: boolean;
  settings: Pick<WorkbotSettings, "model"> | null | undefined;
  readiness: WorkbotReadiness | null | undefined;
}): WorkbotFacts | null {
  if (!input.settings) return null;
  const modelChosen = input.settings.model !== null;
  if (!input.deployed) return { modelChosen, needsProvider: false };
  if (!input.readiness) return null;
  const gatewayRequired = input.readiness.organizationGatewayRequired ?? input.readiness.gatewayRequired;
  return {
    modelChosen,
    needsProvider: gatewayRequired && !input.readiness.hasGatewayProvider,
    ...(input.readiness.enabled === false ? { workbotOff: true } : {}),
  };
}

export function useWorkbotIntroFacts(enabled: boolean, settings: WorkbotSettings | undefined): WorkbotFacts | null {
  const { orgId, orgContext } = useOrgDashboard();
  const deployed = orgContext?.capabilities.workbot === true;
  const readiness = useWorkbotReadiness(orgId ?? null, enabled && deployed);
  if (!enabled) return null;
  return workbotIntroFacts({ deployed, settings, readiness: readiness.data });
}
