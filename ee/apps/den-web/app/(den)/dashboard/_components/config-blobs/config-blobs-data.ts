"use client";

import type {
  ConfigAreasResponse,
  ConfigChangeRequestDetailResponse,
  ConfigChangeRequestListResponse,
  ConfigChangeRequestPlanResponse,
  ConfigChangeRequestPlanUpdateResponse,
  ConfigChangeRequestResponse,
  ConfigDecisions,
  ConfigImportMode,
  ConfigSecretInput,
  ConfigBlob,
  ConfigBlobSettings,
  ConfigBlobSettingsResponse,
} from "@openwork/types/den/config-blobs";
import { type QueryClient, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { getErrorMessage, getRequestError, requestJson, requestResponse } from "../../../_lib/den-flow";
import { ORG_SCOPE_HEADER } from "../../../_lib/org-scope";
import { useOrgDashboard } from "../../_providers/org-dashboard-provider";
import { isTransientStatus } from "./config-blobs-model";

const BASE = "/v1/config-blobs";
const POLL_MS = 2000;

export const configQueryKeys = {
  all: (orgId: string) => ["config-blobs", orgId],
  areas: (orgId: string) => ["config-blobs", orgId, "areas"],
  list: (orgId: string, state: "open" | "closed") => ["config-blobs", orgId, "change-requests", state],
  detail: (orgId: string, id: string) => ["config-blobs", orgId, "change-request", id],
  plan: (orgId: string, id: string) => ["config-blobs", orgId, "change-request", id, "plan"],
  settings: (orgId: string) => ["config-blobs", orgId, "settings"],
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isAreasResponse(value: unknown): value is ConfigAreasResponse {
  return isRecord(value) && Array.isArray(value.areas);
}

function isSettingsResponse(value: unknown): value is ConfigBlobSettingsResponse {
  return isRecord(value) && isRecord(value.settings) && typeof value.settings.requireSecondApprover === "boolean";
}

function isListResponse(value: unknown): value is ConfigChangeRequestListResponse {
  return isRecord(value) && Array.isArray(value.changeRequests);
}

function isChangeRequestResponse(value: unknown): value is ConfigChangeRequestResponse {
  return isRecord(value) && isRecord(value.changeRequest) && typeof value.changeRequest.id === "string";
}

function isDetailResponse(value: unknown): value is ConfigChangeRequestDetailResponse {
  return isRecord(value)
    && (value.report === null || isRecord(value.report))
    && Array.isArray(value.runs) && value.runs.every(isRecord)
    && isChangeRequestResponse(value);
}

function isPlanResponse(value: unknown): value is ConfigChangeRequestPlanResponse {
  return isRecord(value) && (value.plan === null || isRecord(value.plan)) && isRecord(value.decisions);
}

function isPlanUpdateResponse(value: unknown): value is ConfigChangeRequestPlanUpdateResponse {
  return isRecord(value) && (value.plan === null || isRecord(value.plan)) && isChangeRequestResponse(value);
}

async function getJson<T>(orgId: string, path: string, guard: (value: unknown) => value is T, fallback: string, signal?: AbortSignal): Promise<T> {
  const { response, payload } = await requestJson(path, { method: "GET", headers: { [ORG_SCOPE_HEADER]: orgId }, cache: "no-store", signal }, 15000);
  if (!response.ok) throw new Error(getErrorMessage(payload, fallback));
  if (!guard(payload)) throw new Error(fallback);
  return payload;
}

export function useConfigAreas(orgId: string | null, enabled = true) {
  return useQuery({
    queryKey: configQueryKeys.areas(orgId ?? ""),
    enabled: enabled && Boolean(orgId),
    retry: false,
    queryFn: ({ signal }) => getJson(orgId ?? "", `${BASE}/areas`, isAreasResponse, "Couldn't load the config areas.", signal),
  });
}

export function useConfigChangeRequests(orgId: string | null, state: "open" | "closed", enabled = true) {
  return useQuery({
    queryKey: configQueryKeys.list(orgId ?? "", state),
    enabled: enabled && Boolean(orgId),
    retry: false,
    queryFn: ({ signal }) => getJson(orgId ?? "", `${BASE}/change-requests?state=${state}`, isListResponse, "Couldn't load config changes.", signal),
    refetchInterval: (query) => query.state.data?.changeRequests.some((request) => isTransientStatus(request.status)) ? POLL_MS : false,
  });
}

export function useConfigChangeRequest(orgId: string | null, id: string) {
  return useQuery({
    queryKey: configQueryKeys.detail(orgId ?? "", id),
    enabled: Boolean(orgId),
    retry: false,
    queryFn: ({ signal }) => getJson(orgId ?? "", `${BASE}/change-requests/${encodeURIComponent(id)}`, isDetailResponse, "Couldn't load this change.", signal),
    refetchInterval: (query) => isTransientStatus(query.state.data?.changeRequest.status) ? POLL_MS : false,
  });
}

/** The plan is read once the analysis is done; `version` (status + plan hash) refetches it when the request moves on. */
export function useConfigPlan(orgId: string | null, id: string, version: string | null) {
  return useQuery<ConfigChangeRequestPlanResponse>({
    queryKey: [...configQueryKeys.plan(orgId ?? "", id), version],
    enabled: Boolean(orgId) && version !== null,
    retry: false,
    placeholderData: (previous) => previous,
    queryFn: ({ signal }) => getJson(orgId ?? "", `${BASE}/change-requests/${encodeURIComponent(id)}/plan`, isPlanResponse, "Couldn't load the plan for this change.", signal),
  });
}

async function send<T>(orgId: string, method: "POST" | "PUT" | "PATCH", path: string, body: unknown, guard: (value: unknown) => value is T, fallback: string): Promise<T> {
  const { response, payload } = await requestJson(path, { method, headers: { [ORG_SCOPE_HEADER]: orgId }, body: JSON.stringify(body ?? {}) }, 30000);
  if (!response.ok) throw getRequestError(payload, response, fallback);
  if (!guard(payload)) throw new Error(fallback);
  return payload;
}

/** Runs a write behind the workspace re-auth prompt and returns its result. */
function useReauthable() {
  const { runReauthableAction } = useOrgDashboard();
  return async function run<T>(label: string, action: () => Promise<T>): Promise<T> {
    const box: { value: T | null; done: boolean } = { value: null, done: false };
    await runReauthableAction(label, async () => {
      box.value = await action();
      box.done = true;
    });
    if (!box.done || box.value === null) throw new Error("This change wasn't saved. Try again.");
    return box.value;
  };
}

export function useCreateConfigChangeRequest(orgId: string | null) {
  const queryClient = useQueryClient();
  const run = useReauthable();
  return useMutation({
    retry: false,
    mutationFn: (input: { blob: ConfigBlob; mode: ConfigImportMode; title?: string }) => run("Upload config", () =>
      send(orgId ?? "", "POST", `${BASE}/change-requests`, input, isChangeRequestResponse, "Couldn't upload this file.")),
    onSettled: () => refresh(queryClient, orgId ? configQueryKeys.all(orgId) : null),
  });
}

/**
 * Refetches after a write without holding the mutation open: an awaited
 * invalidation waits for every matching refetch, and a polled query whose
 * fetch is replaced mid-flight can keep the button spinning.
 */
function refresh(queryClient: QueryClient, queryKey: readonly unknown[] | null): void {
  if (queryKey) void queryClient.invalidateQueries({ queryKey });
}

/** Shared by decisions and inputs: both return the request and its re-computed plan. */
function usePlanUpdate<TInput>(orgId: string | null, id: string, label: string, path: string, fallback: string) {
  const queryClient = useQueryClient();
  const run = useReauthable();
  return useMutation({
    retry: false,
    mutationFn: (body: TInput) => run(label, () => send(orgId ?? "", "PUT", `${BASE}/change-requests/${encodeURIComponent(id)}/${path}`, body, isPlanUpdateResponse, fallback)),
    onSuccess: (result) => {
      if (!orgId) return;
      queryClient.setQueryData<ConfigChangeRequestDetailResponse>(configQueryKeys.detail(orgId, id), (current) => current ? { ...current, changeRequest: result.changeRequest } : current);
    },
    onSettled: () => refresh(queryClient, orgId ? configQueryKeys.plan(orgId, id) : null),
  });
}

export function useSaveConfigDecisions(orgId: string | null, id: string) {
  return usePlanUpdate<ConfigDecisions>(orgId, id, "Save config decisions", "decisions", "Couldn't save this choice.");
}

export function useSaveConfigInputs(orgId: string | null, id: string) {
  return usePlanUpdate<{ inputs: ConfigSecretInput[] }>(orgId, id, "Save config secrets", "inputs", "Couldn't save this secret.");
}

export function useConfigBlobSettings(orgId: string | null, enabled = true) {
  return useQuery({
    queryKey: configQueryKeys.settings(orgId ?? ""),
    enabled: enabled && Boolean(orgId),
    retry: false,
    queryFn: ({ signal }) => getJson(orgId ?? "", `${BASE}/settings`, isSettingsResponse, "Couldn't load the config settings.", signal),
  });
}

export function useUpdateConfigBlobSettings(orgId: string | null) {
  const queryClient = useQueryClient();
  const run = useReauthable();
  return useMutation({
    retry: false,
    mutationFn: (settings: ConfigBlobSettings) => run("Save config settings", () =>
      send(orgId ?? "", "PATCH", `${BASE}/settings`, settings, isSettingsResponse, "Couldn't save this setting.")),
    onSuccess: (result) => {
      if (orgId) queryClient.setQueryData(configQueryKeys.settings(orgId), result);
    },
  });
}

export type ConfigRequestAction = "approve" | "apply" | "cancel" | "revert";

const ACTION_FALLBACK: Record<ConfigRequestAction, string> = {
  approve: "Couldn't approve this change.",
  apply: "Couldn't apply this change.",
  cancel: "Couldn't cancel this change.",
  revert: "Couldn't start restoring the previous config.",
};

export function useConfigRequestAction(orgId: string | null, id: string) {
  const queryClient = useQueryClient();
  const run = useReauthable();
  return useMutation({
    retry: false,
    mutationFn: ({ action, planHash }: { action: ConfigRequestAction; planHash?: string }) => run(`Config change: ${action}`, () =>
      send(orgId ?? "", "POST", `${BASE}/change-requests/${encodeURIComponent(id)}/${action}`, planHash ? { planHash } : {}, isChangeRequestResponse, ACTION_FALLBACK[action])),
    onSuccess: (result, { action }) => {
      if (!orgId || action === "revert") return;
      queryClient.setQueryData<ConfigChangeRequestDetailResponse>(configQueryKeys.detail(orgId, id), (current) => current ? { ...current, changeRequest: result.changeRequest } : current);
    },
    onSettled: () => refresh(queryClient, orgId ? configQueryKeys.all(orgId) : null),
  });
}

/** Fetches a blob from the API and saves it as a file in the browser. */
export async function downloadConfigFile(orgId: string, path: string, fileName: string, fallback: string): Promise<void> {
  const response = await requestResponse(path, { method: "GET", headers: { [ORG_SCOPE_HEADER]: orgId }, cache: "no-store" }, 60000);
  const text = await response.text();
  if (!response.ok) {
    let payload: unknown = text;
    try { payload = JSON.parse(text); } catch { /* keep text */ }
    throw new Error(getErrorMessage(payload, fallback));
  }
  const url = URL.createObjectURL(new Blob([text], { type: "application/json" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export const configBlobPaths = {
  export: (areas: string | null) => `${BASE}/export${areas ? `?areas=${encodeURIComponent(areas)}` : ""}`,
  beforeSnapshot: (id: string) => `${BASE}/change-requests/${encodeURIComponent(id)}/before-snapshot`,
};
