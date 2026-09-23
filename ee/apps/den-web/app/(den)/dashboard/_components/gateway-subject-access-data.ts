"use client";

import type { GatewayAccessGrantWrite } from "@openwork/types/den/gateway";
import { useQuery } from "@tanstack/react-query";
import { z } from "zod";
import { getErrorMessage, getRequestError, isReauthRequiredError, requestJson } from "../../_lib/den-flow";
import { ORG_SCOPE_HEADER } from "../../_lib/org-scope";
import { asInferenceProvider } from "./inference-provider-request";

const providerListSchema = z.object({ inferenceProviders: z.array(z.unknown()) });
const grantResultSchema = z.object({ accessGrant: z.object({ id: z.string(), modelGroupId: z.string(), credentialSetId: z.string() }) });

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
      if (!result.success) throw new Error("Provider access could not be verified. Refresh before changing assignments.");
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

export class GatewayAccessWriteUncertainError extends Error {
  constructor() {
    super("The access update could not be verified and may already have succeeded. Close this dialog, refresh, and review assignments before making another change.");
  }
}

export async function writeSubjectAccess(orgId: string, providerId: string, action: { body: GatewayAccessGrantWrite } | { grantId: string }) {
  const path = `/v1/inference-providers/${encodeURIComponent(providerId)}/access-grants`;
  const removing = "grantId" in action;
  const { response, payload } = await requestJson(removing ? `${path}/${encodeURIComponent(action.grantId)}` : path, {
    method: removing ? "DELETE" : "POST",
    headers: { [ORG_SCOPE_HEADER]: orgId },
    ...(removing ? {} : { body: JSON.stringify(action.body) }),
  }, 20000).catch((error: unknown) => {
    if (isReauthRequiredError(error)) throw error;
    throw new GatewayAccessWriteUncertainError();
  });
  if (response.status >= 500) throw new GatewayAccessWriteUncertainError();
  if (!response.ok) throw getRequestError(payload, response, "Could not update provider access. Review the selection and try again.");
  if (removing) {
    if (response.status !== 204) throw new GatewayAccessWriteUncertainError();
    return;
  }
  const result = grantResultSchema.safeParse(payload);
  if (!result.success || result.data.accessGrant.modelGroupId !== action.body.modelGroupId
    || result.data.accessGrant.credentialSetId !== action.body.credentialSetId) throw new GatewayAccessWriteUncertainError();
}
