"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { organizationComputerRulesResponseSchema, type OrganizationComputerRulesResponse, type OrganizationComputerRulesUpdate } from "@openwork/types/den/computer-inventory";
import { requestJson } from "../../../_lib/den-flow";
import { permissionLockReason } from "../../../_lib/den-org";
import { markFeatureUsed } from "../../../_lib/feature-usage";
import { ORG_SCOPE_HEADER } from "../../../_lib/org-scope";
import { useOrgDashboard } from "../../_providers/org-dashboard-provider";
import { inventoryOrganizationKey } from "./inventory-data";

const settingsPath = "/v1/org/computer-rules";
const LOAD_ERROR = "Couldn't load computer rules.";
const SAVE_ERROR = "Couldn't save the computer rule. Try again.";

export const computerRulesQueryKey = (orgId: string) => ["organization-computer-rules", orgId];

type RunCodeChoice = Exclude<OrganizationComputerRulesUpdate["runCode"], undefined>;

async function requestRules(orgId: string, input: { runCode: RunCodeChoice } | undefined, signal?: AbortSignal) {
  const { response, payload } = await requestJson(settingsPath, {
    method: input ? "PATCH" : "GET", headers: { [ORG_SCOPE_HEADER]: orgId }, cache: "no-store", signal,
    ...(input ? { body: JSON.stringify(input) } : {}),
  }, 35_000).catch((failure: unknown) => {
    if (failure instanceof TypeError) throw new Error("Couldn't reach OpenWork. Check your connection and try again.");
    throw failure;
  });
  if (response.status === 401) throw new Error("Your session expired. Sign in again.");
  if (response.status === 403 && input) throw new Error(permissionLockReason("organization.update"));
  if (!response.ok) throw new Error(input ? SAVE_ERROR : LOAD_ERROR);
  const parsed = organizationComputerRulesResponseSchema.safeParse(payload);
  if (!parsed.success) throw new Error("Couldn't verify the computer rules. Refresh to try again.");
  return parsed.data;
}

export function useOrganizationComputerRules(orgId: string) {
  return useQuery({ queryKey: computerRulesQueryKey(orgId), retry: false, queryFn: ({ signal }) => requestRules(orgId, undefined, signal) });
}

export function useSaveComputerRunCodeRule(orgId: string) {
  const client = useQueryClient();
  const { runReauthableAction } = useOrgDashboard();
  const key = computerRulesQueryKey(orgId);
  return useMutation({
    mutationKey: [...key, "save"], retry: false,
    mutationFn: async (runCode: RunCodeChoice) => {
      const result: { saved?: OrganizationComputerRulesResponse } = {};
      try {
        await runReauthableAction("save-computer-run-code-rule", async () => { result.saved = await requestRules(orgId, { runCode }); });
      } catch (error) {
        void client.invalidateQueries({ queryKey: key });
        throw error;
      }
      if (!result.saved) throw new Error(SAVE_ERROR);
      return result.saved;
    },
    onSuccess: async (saved) => {
      markFeatureUsed("computers");
      await client.cancelQueries({ queryKey: key });
      client.setQueryData(key, saved);
      void client.invalidateQueries({ queryKey: inventoryOrganizationKey(orgId) });
    },
  });
}
