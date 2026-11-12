"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { RemoteSessionAccessMode } from "@openwork/types/automations";
import { organizationRemoteSessionSettingsResponseSchema, type OrganizationRemoteSessionSettingsResponse } from "@openwork/types/den/remote-sessions";
import { getErrorMessage, requestJson } from "../../../_lib/den-flow";
import { ORG_SCOPE_HEADER } from "../../../_lib/org-scope";
import { useOrgDashboard } from "../../_providers/org-dashboard-provider";

/*
 * The organization's limit on what other devices may do on its members'
 * computers (`GET/PATCH /v1/org/remote-session-settings`). It is the only
 * remote-access call Den web makes: what applies on each computer arrives
 * with the computer itself, and Den web reads no sessions.
 */

const settingsPath = "/v1/org/remote-session-settings";
const REQUEST_TIMEOUT_MS = 35_000;

/** A refusal with Den's code and status, and a sentence to show: Den's own, else the caller's fallback. */
export class RemoteAccessSettingsError extends Error {
  readonly code: string;
  /** The HTTP status Den answered with; null when no answer arrived. */
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
    // The browser reports a dropped connection as a bare TypeError; say what happened instead.
    if (failure instanceof TypeError) throw new RemoteAccessSettingsError("network_error", "Couldn't reach OpenWork. Check your connection and try again.");
    throw failure;
  });
  const code = isRecord(payload) && typeof payload.error === "string" ? payload.error : null;
  if (response.ok && !code) return payload;
  const message = getErrorMessage(payload, response.status === 401 ? "Your session expired. Sign in again." : fallback);
  // A bare code is not a sentence to show; the caller's fallback is.
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
  const { runReauthableAction } = useOrgDashboard();
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
      // What applies on each computer follows the organization's limit: read the lists again.
      void queryClient.invalidateQueries({ queryKey: ["organization-computers", orgId] });
      void queryClient.invalidateQueries({ queryKey: ["my-computers", orgId] });
    },
  });
}
