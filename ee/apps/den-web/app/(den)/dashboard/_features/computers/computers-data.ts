"use client";

import { useQuery } from "@tanstack/react-query";
import { organizationComputerListResponseSchema, organizationComputerDetailResponseSchema } from "@openwork/types/den/remote-devices";
import { getErrorMessage, requestJson } from "../../../_lib/den-flow";
import { ORG_SCOPE_HEADER } from "../../../_lib/org-scope";
import { computerDetailPath, computerListPath, type ComputerFilters } from "./computers-format";

export function computersQueryKey(orgId: string, path: string): string[] {
  return ["organization-computers", orgId, path];
}

async function fetchComputers(orgId: string, path: string, signal: AbortSignal) {
  const { response, payload } = await requestJson(path, {
    method: "GET", headers: { [ORG_SCOPE_HEADER]: orgId }, cache: "no-store", signal,
  }, 15000);
  if (!response.ok) throw new Error(getErrorMessage(payload,
    response.status === 403 ? "Access to Computers changed. Ask an organization owner or admin for access."
      : response.status === 401 ? "Your session expired. Sign in again to see computers."
        : response.status === 404 ? "This computer is no longer available. Refresh the list."
          : "Couldn't load computers. Try again."));
  return payload;
}

export function useComputers(orgId: string, filters: ComputerFilters, enabled: boolean) {
  const path = computerListPath(filters);
  return useQuery({
    queryKey: computersQueryKey(orgId, path), enabled, retry: false,
    queryFn: async ({ signal }) => {
      const result = organizationComputerListResponseSchema.safeParse(await fetchComputers(orgId, path, signal));
      if (!result.success) throw new Error("Computers returned an unexpected response. Refresh to try again.");
      return result.data;
    },
  });
}

export function useComputer(orgId: string, deviceId: string, enabled = true) {
  const path = computerDetailPath(deviceId);
  return useQuery({
    queryKey: computersQueryKey(orgId, path), enabled: enabled && Boolean(deviceId), retry: false,
    queryFn: async ({ signal }) => {
      const result = organizationComputerDetailResponseSchema.safeParse(await fetchComputers(orgId, path, signal));
      if (!result.success) throw new Error("This computer returned an unexpected response. Refresh to try again.");
      return result.data;
    },
  });
}
