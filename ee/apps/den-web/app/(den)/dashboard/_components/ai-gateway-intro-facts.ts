"use client";

import { useQuery } from "@tanstack/react-query";
import { getErrorMessage, requestJson } from "../../_lib/den-flow";
import { getOrgAccessFlags } from "../../_lib/den-org";
import { parseInferencePayload } from "../../_lib/inference-status";
import { ORG_SCOPE_HEADER } from "../../_lib/org-scope";
import type { AiGatewayFacts } from "../_features/feature-intros/intros/ai-gateway";
import { getGatewayDashboardAccess } from "../_lib/gateway-dashboard-access";
import { useOrgDashboard } from "../_providers/org-dashboard-provider";
import { useOrgInferenceProviders } from "./inference-provider-data";
import type { DenInferenceProvider } from "./inference-provider-request";

/** Who created the organization's first provider credentials, when that was someone else. */
export function firstProviderCreator(providers: readonly DenInferenceProvider[], currentMemberId: string | null): string | null {
  const creators = providers
    .flatMap((provider) => provider.credentialSets ?? [])
    .flatMap((set) => (set.createdBy ? [{ createdAt: set.createdAt ?? "", createdBy: set.createdBy }] : []))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const first = creators[0]?.createdBy;
  if (!first || first.id === currentMemberId) return null;
  return first.name?.trim() || first.email || null;
}

/**
 * Section facts for the AI Gateway intro (DESIGN.md I2): providers and whether
 * OpenWork Models is on. Loads only while `enabled` (the `featureIntros` flag),
 * so the page makes no extra requests with the flag off. Null until both are
 * known, or when this person can't read one of them: the page then renders as before.
 */
export function useAiGatewayIntroFacts(enabled: boolean): AiGatewayFacts | null {
  const dashboard = useOrgDashboard();
  const { orgId, orgContext } = dashboard;
  const access = getOrgAccessFlags(
    orgContext?.currentMember.role ?? "member",
    orgContext?.currentMember.isOwner ?? false,
    orgContext?.currentMember.permissions,
  );
  const readable = enabled
    && Boolean(orgId)
    && access.canViewModelsSettings
    && getGatewayDashboardAccess(dashboard, "providers") === "enabled";

  const providers = useOrgInferenceProviders(readable ? orgId : null);
  const openworkModels = useQuery({
    queryKey: ["feature-intros", "ai-gateway", "openwork-models", orgId ?? ""],
    enabled: readable,
    retry: false,
    staleTime: 30_000,
    queryFn: async ({ signal }): Promise<boolean> => {
      const { response, payload } = await requestJson("/v1/inference", { method: "GET", headers: { [ORG_SCOPE_HEADER]: orgId ?? "" }, signal }, 12000);
      if (!response.ok) throw new Error(getErrorMessage(payload, `Couldn't check OpenWork Models (${response.status}).`));
      const status = parseInferencePayload(payload);
      if (!status) throw new Error("OpenWork Models returned an unexpected response.");
      return status.enabled;
    },
  });

  if (!readable || providers.busy || providers.error || openworkModels.data === undefined) return null;
  return {
    providers: providers.inferenceProviders.length,
    openworkModels: openworkModels.data,
    setUpBy: firstProviderCreator(providers.inferenceProviders, orgContext?.currentMember.id ?? null),
  };
}
