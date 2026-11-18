"use client";

import { useQuery } from "@tanstack/react-query";
import {
  organizationComputerDetailResponseSchema,
  organizationComputerDisconnectResponseSchema,
  organizationComputerListResponseSchema,
  type OrganizationComputerDetailResponse,
  type OrganizationComputerDisconnectResponse,
  type OrganizationComputerListResponse,
} from "@openwork/types/den/remote-devices";
import { getErrorMessage, requestJson } from "../../../_lib/den-flow";
import { ORG_SCOPE_HEADER } from "../../../_lib/org-scope";
import { computerActionError } from "./computer-actions";
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

/*
 * Den web and the Den API deploy separately, so for a few minutes this page
 * can talk to an API from before computers could be disconnected. That API
 * sends no `canDisconnect`, `canRemove`, `disconnectedAt`, `owner.former`,
 * `online` or `staleHidden`. The contract defaults them, and a team
 * computer's `canRemove` is filled in here as well, so the page shows what it
 * knows and offers nothing it could not do.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function withoutMissingActions(device: unknown): unknown {
  return isRecord(device) && device.canRemove === undefined ? { ...device, canRemove: false } : device;
}

export type OrganizationComputerList = OrganizationComputerListResponse & {
  /** The API said, per computer, whether it can be disconnected. False for an API from before that existed. */
  actionsReported: boolean;
};

/** The team list as Den sent it, or null when it is not one. Tolerates an API without the newer fields. */
export function parseComputerList(payload: unknown): OrganizationComputerList | null {
  const devices = isRecord(payload) && Array.isArray(payload.devices) ? payload.devices : null;
  const result = organizationComputerListResponseSchema.safeParse(devices && isRecord(payload) ? { ...payload, devices: devices.map(withoutMissingActions) } : payload);
  if (!result.success) return null;
  // With no computers there is nothing to tell an older API by, and nothing to offer either way.
  const actionsReported = !devices || devices.length === 0 || devices.some((device) => isRecord(device) && typeof device.canDisconnect === "boolean");
  return { ...result.data, actionsReported };
}

/** One computer's detail, with the same tolerance. */
export function parseComputerDetail(payload: unknown): OrganizationComputerDetailResponse | null {
  const result = organizationComputerDetailResponseSchema.safeParse(isRecord(payload) ? { ...payload, device: withoutMissingActions(payload.device) } : payload);
  return result.success ? result.data : null;
}

export function useComputers(orgId: string, filters: ComputerFilters, enabled: boolean) {
  const path = computerListPath(filters);
  return useQuery({
    queryKey: computersQueryKey(orgId, path), enabled, retry: false,
    queryFn: async ({ signal }) => {
      const list = parseComputerList(await fetchComputers(orgId, path, signal));
      if (!list) throw new Error("Computers returned an unexpected response. Refresh to try again.");
      return list;
    },
  });
}

export function useComputer(orgId: string, deviceId: string, enabled = true) {
  const path = computerDetailPath(deviceId);
  return useQuery({
    queryKey: computersQueryKey(orgId, path), enabled: enabled && Boolean(deviceId), retry: false,
    queryFn: async ({ signal }) => {
      const detail = parseComputerDetail(await fetchComputers(orgId, path, signal));
      if (!detail) throw new Error("This computer returned an unexpected response. Refresh to try again.");
      return detail;
    },
  });
}

/*
 * Disconnect and remove need the "Disconnect team computers" permission. It
 * is a sensitive one: a sign-in that is no longer fresh is answered with a
 * re-authentication request, which requestJson throws for the dashboard's
 * runReauthableAction to handle.
 */

/** `POST /v1/org/computers/:deviceId/disconnect`: Den stops accepting the desktop and, where it can, signs it out. */
export async function disconnectOrganizationComputer(orgId: string, deviceId: string): Promise<OrganizationComputerDisconnectResponse> {
  const { response, payload } = await requestJson(`${computerDetailPath(deviceId)}/disconnect`, {
    method: "POST", headers: { [ORG_SCOPE_HEADER]: orgId }, cache: "no-store",
  }, 15000);
  if (!response.ok) throw new Error(computerActionError("disconnect", response.status, payload));
  const result = organizationComputerDisconnectResponseSchema.safeParse(payload);
  if (!result.success) throw new Error("Disconnecting returned an unexpected response. Refresh to see this computer's state.");
  return result.data;
}

/** `DELETE /v1/org/computers/:deviceId`: takes the entry off the list; nothing happens to the computer. */
export async function removeOrganizationComputer(orgId: string, deviceId: string): Promise<void> {
  const { response, payload } = await requestJson(computerDetailPath(deviceId), {
    method: "DELETE", headers: { [ORG_SCOPE_HEADER]: orgId }, cache: "no-store",
  }, 15000);
  if (!response.ok) throw new Error(computerActionError("remove", response.status, payload));
}
