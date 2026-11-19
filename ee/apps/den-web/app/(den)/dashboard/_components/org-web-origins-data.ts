"use client";

import {
  organizationWebOriginListSchema,
  organizationWebOriginSchema,
  type OrganizationWebOrigin,
  type OrganizationWebOriginList,
} from "@openwork/types/den/organization-web-origins";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { getErrorMessage, getRequestError, requestJson } from "../../_lib/den-flow";
import { ORG_SCOPE_HEADER } from "../../_lib/org-scope";
import { useOrgDashboard } from "../_providers/org-dashboard-provider";

const webOriginsPath = "/v1/org/web-origins";

export function orgWebOriginsQueryKey(orgId: string): string[] {
  return ["org-web-origins", orgId];
}

export function useOrgWebOrigins(orgId: string, enabled = true) {
  return useQuery({
    queryKey: orgWebOriginsQueryKey(orgId),
    enabled,
    retry: false,
    queryFn: async ({ signal }): Promise<OrganizationWebOriginList> => {
      const { response, payload } = await requestJson(
        webOriginsPath,
        { method: "GET", headers: { [ORG_SCOPE_HEADER]: orgId }, cache: "no-store", signal },
        15000,
      );
      if (!response.ok) {
        throw new Error(getErrorMessage(payload, `Couldn't load approved origins (${response.status}).`));
      }
      const parsed = organizationWebOriginListSchema.safeParse(payload);
      if (!parsed.success) {
        throw new Error("Approved origins returned an unexpected response.");
      }
      return parsed.data;
    },
  });
}

export function useApproveOrgWebOrigin(orgId: string) {
  const queryClient = useQueryClient();
  const { runReauthableAction } = useOrgDashboard();

  return useMutation({
    mutationKey: [...orgWebOriginsQueryKey(orgId), "approve"],
    retry: false,
    mutationFn: async (origin: string): Promise<OrganizationWebOrigin | null> => {
      const result: { created: OrganizationWebOrigin | null } = { created: null };
      await runReauthableAction("approve-web-origin", async () => {
        const { response, payload } = await requestJson(
          webOriginsPath,
          {
            method: "POST",
            headers: { [ORG_SCOPE_HEADER]: orgId },
            body: JSON.stringify({ origin }),
          },
          15000,
        );
        if (!response.ok) {
          throw getRequestError(payload, response, `Couldn't approve ${origin} (${response.status}).`);
        }
        const parsed = organizationWebOriginSchema.safeParse(payload);
        result.created = parsed.success ? parsed.data : null;
      });
      return result.created;
    },
    onSuccess: (created) => {
      if (!created) return;
      queryClient.setQueryData<OrganizationWebOriginList>(orgWebOriginsQueryKey(orgId), (current) =>
        current && !current.origins.some((entry) => entry.id === created.id)
          ? { ...current, origins: [...current.origins, created] }
          : current,
      );
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: orgWebOriginsQueryKey(orgId) }),
  });
}

export function useRemoveOrgWebOrigin(orgId: string) {
  const queryClient = useQueryClient();
  const { runReauthableAction } = useOrgDashboard();

  return useMutation({
    mutationKey: [...orgWebOriginsQueryKey(orgId), "remove"],
    retry: false,
    mutationFn: async (webOrigin: OrganizationWebOrigin): Promise<OrganizationWebOrigin> => {
      await runReauthableAction("remove-web-origin", async () => {
        const { response, payload } = await requestJson(
          `${webOriginsPath}/${encodeURIComponent(webOrigin.id)}`,
          { method: "DELETE", headers: { [ORG_SCOPE_HEADER]: orgId } },
          15000,
        );
        if (!response.ok) {
          throw getRequestError(payload, response, `Couldn't remove ${webOrigin.origin} (${response.status}).`);
        }
      });
      return webOrigin;
    },
    onSuccess: (removed) => {
      queryClient.setQueryData<OrganizationWebOriginList>(orgWebOriginsQueryKey(orgId), (current) =>
        current ? { ...current, origins: current.origins.filter((entry) => entry.id !== removed.id) } : current,
      );
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: orgWebOriginsQueryKey(orgId) }),
  });
}
