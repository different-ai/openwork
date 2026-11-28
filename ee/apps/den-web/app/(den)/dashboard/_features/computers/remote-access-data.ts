"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { RemoteSessionAccessMode } from "@openwork/types/automations";
import { organizationRemoteSessionSettingsResponseSchema, type OrganizationRemoteSessionSettingsResponse } from "@openwork/types/den/remote-sessions";
import { getErrorMessage, requestJson } from "../../../_lib/den-flow";
import { orgFeatureEnabled } from "../../../_lib/den-org";
import { markFeatureUsed } from "../../../_lib/feature-usage";
import { ORG_SCOPE_HEADER } from "../../../_lib/org-scope";
import { useOrgDashboard } from "../../_providers/org-dashboard-provider";
import { computerRulesQueryKey } from "./computer-rules-data";
import { inventoryOrganizationKey } from "./inventory-data";

const settingsPath = "/v1/org/remote-session-settings";
const REQUEST_TIMEOUT_MS = 35_000;

export class RemoteAccessSettingsError extends Error {
  readonly code: string;
  readonly status: number | null;
  constructor(code: string, message: string, status: number | null = null) {
    super(message);
    this.name = "RemoteAccessSettingsError";
    this.code = code;
    this.status = status;
  }
}

export function remoteAccessSettingsErrorStatus(error: unknown): number | null {
  return error instanceof RemoteAccessSettingsError ? error.status : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function request(orgId: string, method: "GET" | "PATCH", body: unknown, fallback: string, signal?: AbortSignal): Promise<unknown> {
  const { response, payload } = await requestJson(settingsPath, {
    method,
    headers: { [ORG_SCOPE_HEADER]: orgId },
    cache: "no-store",
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    ...(signal ? { signal } : {}),
  }, REQUEST_TIMEOUT_MS).catch((failure: unknown) => {
    if (failure instanceof TypeError) throw new RemoteAccessSettingsError("network_error", "Couldn't reach OpenWork. Check your connection and try again.");
    throw failure;
  });
  const code = isRecord(payload) && typeof payload.error === "string" ? payload.error : null;
  if (response.ok && !code) return payload;
  const message = getErrorMessage(payload, response.status === 401 ? "Your session expired. Sign in again." : fallback);
  throw new RemoteAccessSettingsError(code ?? `http_${response.status}`, message === code ? fallback : message, response.status);
}

function parseSettings(payload: unknown): OrganizationRemoteSessionSettingsResponse {
  const parsed = organizationRemoteSessionSettingsResponseSchema.safeParse(payload);
  if (!parsed.success) throw new RemoteAccessSettingsError("unexpected_response", "This setting returned an unexpected response. Refresh to try again.");
  return parsed.data;
}

export function remoteAccessSettingsQueryKey(orgId: string): string[] {
  return ["org-remote-session-settings", orgId];
}

export async function fetchRemoteAccessSettings(orgId: string, signal?: AbortSignal): Promise<OrganizationRemoteSessionSettingsResponse> {
  return parseSettings(await request(orgId, "GET", undefined, "Couldn't load this setting. Try again.", signal));
}

export async function saveRemoteAccessSettings(orgId: string, access: RemoteSessionAccessMode): Promise<OrganizationRemoteSessionSettingsResponse> {
  return parseSettings(await request(orgId, "PATCH", { access }, "Couldn't save this setting. Try again."));
}

export function useRemoteAccessSettings(orgId: string, enabled: boolean) {
  return useQuery({
    queryKey: remoteAccessSettingsQueryKey(orgId), enabled, retry: false,
    queryFn: ({ signal }) => fetchRemoteAccessSettings(orgId, signal),
  });
}

export function useSaveRemoteAccessSettings(orgId: string) {
  const queryClient = useQueryClient();
  const { orgContext, runReauthableAction } = useOrgDashboard();
  const inventoryEnabled = orgContext?.organization.id === orgId && orgFeatureEnabled(orgContext, "computers");
  return useMutation({
    mutationKey: [...remoteAccessSettingsQueryKey(orgId), "save"], retry: false,
    mutationFn: async (access: RemoteSessionAccessMode): Promise<OrganizationRemoteSessionSettingsResponse> => {
      const result: { saved: OrganizationRemoteSessionSettingsResponse | null } = { saved: null };
      await runReauthableAction("save-remote-access-settings", async () => {
        result.saved = await saveRemoteAccessSettings(orgId, access);
      });
      if (!result.saved) throw new RemoteAccessSettingsError("not_saved", "Couldn't save this setting. Try again.");
      return result.saved;
    },
    onSuccess: (saved) => {
      queryClient.setQueryData(remoteAccessSettingsQueryKey(orgId), saved);
      void queryClient.invalidateQueries({ queryKey: ["organization-computers", orgId] });
      void queryClient.invalidateQueries({ queryKey: ["my-computers", orgId] });
      if (inventoryEnabled) {
        markFeatureUsed("computers");
        void queryClient.invalidateQueries({ queryKey: computerRulesQueryKey(orgId) });
        void queryClient.invalidateQueries({ queryKey: inventoryOrganizationKey(orgId) });
      }
    },
  });
}
