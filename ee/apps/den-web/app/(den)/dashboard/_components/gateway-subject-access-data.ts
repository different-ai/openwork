"use client";

import { useQuery } from "@tanstack/react-query";
import { z } from "zod";
import { getErrorMessage, requestJson } from "../../_lib/den-flow";
import { ORG_SCOPE_HEADER } from "../../_lib/org-scope";
import { asInferenceProvider } from "./inference-provider-request";

const providerListSchema = z.object({ inferenceProviders: z.array(z.unknown()) });

export function useGatewayAccessProviders(orgId: string) {
  return useQuery({
    queryKey: ["gateway-subject-access", orgId],
    retry: false,
    staleTime: 0,
    gcTime: 0,
    queryFn: async ({ signal }) => {
      const { response, payload } = await requestJson("/v1/inference-providers?scope=manageable", {
        method: "GET", headers: { [ORG_SCOPE_HEADER]: orgId }, cache: "no-store", signal,
      }, 15000);
      if (!response.ok) throw new Error(getErrorMessage(payload, "Could not load provider access. Refresh to try again."));
      const result = providerListSchema.safeParse(payload);
      if (!result.success) throw new Error("Provider access could not be verified. Refresh to try again.");
      return result.data.inferenceProviders.map((value) => {
        let provider: ReturnType<typeof asInferenceProvider>;
        try {
          provider = asInferenceProvider(value);
        } catch {
          throw new Error("Provider access definitions are unavailable. Refresh or ask an administrator to update the Gateway API.");
        }
        if (!provider || !provider.modelGroups || !provider.credentialSets || !provider.accessGrants) {
          throw new Error("Provider access definitions are unavailable. Refresh or ask an administrator to update the Gateway API.");
        }
        return { ...provider, modelGroups: provider.modelGroups, credentialSets: provider.credentialSets, accessGrants: provider.accessGrants };
      });
    },
  });
}

export type GatewayAccessProvider = NonNullable<ReturnType<typeof useGatewayAccessProviders>["data"]>[number];
