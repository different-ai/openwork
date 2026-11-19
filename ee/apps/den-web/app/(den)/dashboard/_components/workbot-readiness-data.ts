"use client";

import { workbotReadinessSchema, type WorkbotReadiness } from "@openwork/types/den/workbot-settings";
import { useQuery } from "@tanstack/react-query";
import { getErrorMessage, requestJson } from "../../_lib/den-flow";
import { ORG_SCOPE_HEADER } from "../../_lib/org-scope";

const workbotReadinessPath = "/v1/org/workbot-readiness";

export function workbotReadinessQueryKey(orgId: string | null): (string | null)[] {
  return ["org-workbot-readiness", orgId];
}

/** Content-free: whether Workbot turns need the AI Gateway and whether the organization has an active provider. */
export async function loadWorkbotReadiness(orgId: string, signal?: AbortSignal): Promise<WorkbotReadiness> {
  const { response, payload } = await requestJson(
    workbotReadinessPath,
    { method: "GET", headers: { [ORG_SCOPE_HEADER]: orgId }, cache: "no-store", signal },
    10000,
  );
  if (!response.ok) throw new Error(getErrorMessage(payload, `Couldn't check Workbot (${response.status}).`));
  const parsed = workbotReadinessSchema.safeParse(payload);
  if (!parsed.success) throw new Error("Workbot readiness returned an unexpected response.");
  return parsed.data;
}

/** Loaded with the dashboard so clicking Workbot decides at once. Callers treat loading and errors as ready. */
export function useWorkbotReadiness(orgId: string | null, enabled: boolean) {
  return useQuery({
    queryKey: workbotReadinessQueryKey(orgId),
    enabled: enabled && Boolean(orgId),
    retry: false,
    queryFn: ({ signal }) => {
      if (!orgId) throw new Error("Select an organization first.");
      return loadWorkbotReadiness(orgId, signal);
    },
  });
}
