"use client";

import { useQuery } from "@tanstack/react-query";
import { remoteDeviceDetailResponseSchema, remoteDeviceListResponseSchema } from "@openwork/types/den/remote-devices";
import { getErrorMessage, requestJson } from "../../../_lib/den-flow";
import { ORG_SCOPE_HEADER } from "../../../_lib/org-scope";

/**
 * A member's own computers and the ones shared with their organization: the
 * same list Desktop's Settings › Devices and Workbot's Devices read. Den decides
 * what the member may see; this page never asks for another member's computer.
 */
export function myComputersQueryKey(orgId: string, memberId: string): string[] {
  return ["my-computers", orgId, memberId];
}

async function read(orgId: string, path: string, signal: AbortSignal) {
  const { response, payload } = await requestJson(path, { method: "GET", headers: { [ORG_SCOPE_HEADER]: orgId }, cache: "no-store", signal }, 15000);
  if (!response.ok) throw new Error(getErrorMessage(payload,
    response.status === 401 ? "Your session expired. Sign in again to see your computers."
      : response.status === 404 ? "This computer is no longer in your list. Refresh to see what changed."
        : "Couldn't load your computers. Try again."));
  return payload;
}

export function useMyComputers(orgId: string, memberId: string, enabled: boolean) {
  return useQuery({
    queryKey: myComputersQueryKey(orgId, memberId), enabled, retry: false, staleTime: 30_000,
    queryFn: async ({ signal }) => {
      const result = remoteDeviceListResponseSchema.safeParse(await read(orgId, "/v1/remote-devices", signal));
      if (!result.success) throw new Error("Your computers returned an unexpected response. Refresh to try again.");
      return result.data.devices;
    },
  });
}

/** One computer's recent activity, read when its row is opened. */
export function useMyComputerActivity(orgId: string, memberId: string, deviceId: string, enabled: boolean) {
  return useQuery({
    queryKey: [...myComputersQueryKey(orgId, memberId), "activity", deviceId], enabled: enabled && Boolean(deviceId), retry: false, staleTime: 30_000,
    queryFn: async ({ signal }) => {
      const result = remoteDeviceDetailResponseSchema.safeParse(await read(orgId, `/v1/remote-devices/${encodeURIComponent(deviceId)}`, signal));
      if (!result.success) throw new Error("This computer returned an unexpected response. Refresh to try again.");
      return result.data.events;
    },
  });
}
