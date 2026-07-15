import { useEffect, useState } from "react";

import {
  mintCloudControlMcpToken,
  readDenSettings,
  type DenMcpToken,
  type DenSettings,
} from "../../../app/lib/den";
import { recordInspectorEvent } from "../../../app/lib/app-inspector";
import type {
  OpenworkCloudMcpFailure,
  OpenworkCloudMcpHealth,
  OpenworkCloudMcpProviderModelContext,
  OpenworkServerClient,
} from "../../../app/lib/openwork-server";
import { unwrap } from "../../../app/lib/opencode";
import type { Client, McpServerEntry, McpStatusMap } from "../../../app/types";
import { attemptSilentMcpReauth } from "./mcp-silent-reauth";
import {
  CLOUD_MCP_SERVER_NAME,
  readCloudMcpUserState,
} from "./cloud-mcp-user-state";
import {
  runOpenworkCloudMcpReconciler,
  type CloudMcpClient,
} from "./cloud-mcp-reconciler";

export const SESSION_MCP_MAINTENANCE_INTERVAL_MS = 5 * 60 * 1000;
export const CLOUD_MCP_REFRESH_MARGIN_MS = 24 * 60 * 60 * 1000;
export const CLOUD_MCP_MAINTENANCE_RETRY_DELAYS_MS = [1_000, 3_000];

type CloudMcpMaintenanceClient = CloudMcpClient & Pick<OpenworkServerClient, "listMcp">;

const maintenanceInFlight = new Set<string>();

export type CloudMcpMaintenanceIssue = Pick<
  OpenworkCloudMcpFailure,
  "code" | "stage" | "retryable" | "recommendedAction" | "message"
>;

export type CloudMcpBackgroundSyncResult =
  | {
      outcome: "ready";
      status: "synced" | "unchanged";
      health: OpenworkCloudMcpHealth;
    }
  | {
      outcome: "skipped";
      status: "skipped";
      reason: "signed_out" | "missing_org" | "missing_workspace" | "disabled";
      health: null;
    }
  | {
      outcome: "failed";
      status: "failed";
      issue: CloudMcpMaintenanceIssue;
      health: OpenworkCloudMcpHealth | null;
    };

export type SessionCloudMcpMaintenanceState = {
  status: "idle" | "checking" | "ready" | "skipped" | "retrying" | "failed";
  issue: CloudMcpMaintenanceIssue | null;
  attempt: number;
  maxAttempts: number;
};

const IDLE_CLOUD_MCP_MAINTENANCE_STATE: SessionCloudMcpMaintenanceState = {
  status: "idle",
  issue: null,
  attempt: 0,
  maxAttempts: 1 + CLOUD_MCP_MAINTENANCE_RETRY_DELAYS_MS.length,
};

function genericCloudMcpMaintenanceIssue(input?: {
  code?: string;
  message?: string;
  retryable?: boolean;
}): CloudMcpMaintenanceIssue {
  return {
    code: input?.code ?? "cloud_mcp_maintenance_failed",
    stage: "engine_delivery",
    retryable: input?.retryable ?? true,
    recommendedAction: "Retry, then open Settings → Connect if the problem continues.",
    message: input?.message ?? "OpenWork could not verify connected service tools for this workspace.",
  };
}

function failedCloudMcpBackgroundSync(input: {
  health: OpenworkCloudMcpHealth | null;
  issue?: CloudMcpMaintenanceIssue;
  code?: string;
  message?: string;
}): CloudMcpBackgroundSyncResult {
  return {
    outcome: "failed",
    status: "failed",
    health: input.health,
    issue: input.issue ?? genericCloudMcpMaintenanceIssue({ code: input.code, message: input.message }),
  };
}

export function getSessionMcpMaintenanceTargetKey(input: {
  client: Pick<OpenworkServerClient, "baseUrl">;
  cloudSignedIn: boolean;
  denBaseUrl?: string | null;
  orgId?: string | null;
  workspaceId: string;
  providerModel?: OpenworkCloudMcpProviderModelContext;
}): string {
  return JSON.stringify([
    input.denBaseUrl?.trim().replace(/\/+$/, "") ?? "",
    input.client.baseUrl.trim().replace(/\/+$/, ""),
    input.workspaceId.trim(),
    input.cloudSignedIn ? input.orgId?.trim() ?? "" : "local-only",
    input.providerModel?.provider.trim() ?? "",
    input.providerModel?.model.trim() ?? "",
  ]);
}

export async function runSessionMcpMaintenanceTask(input: {
  targetKey: string;
  task: () => Promise<void>;
}): Promise<boolean> {
  if (maintenanceInFlight.has(input.targetKey)) return false;
  maintenanceInFlight.add(input.targetKey);
  try {
    await input.task();
    return true;
  } finally {
    maintenanceInFlight.delete(input.targetKey);
  }
}

export async function syncCloudControlMcpInBackground(input: {
  client: CloudMcpMaintenanceClient;
  workspaceId: string;
  force?: boolean;
  now?: number;
  settings?: DenSettings;
  mintToken?: () => Promise<DenMcpToken | null>;
  providerModel?: OpenworkCloudMcpProviderModelContext;
}): Promise<CloudMcpBackgroundSyncResult> {
  const workspaceId = input.workspaceId.trim();
  const settings = input.settings ?? readDenSettings();
  const orgId = settings.activeOrgId?.trim() ?? "";
  if (!workspaceId) {
    return { outcome: "skipped", status: "skipped", reason: "missing_workspace", health: null };
  }
  if (!settings.authToken?.trim()) {
    return { outcome: "skipped", status: "skipped", reason: "signed_out", health: null };
  }
  if (!orgId) {
    return { outcome: "skipped", status: "skipped", reason: "missing_org", health: null };
  }
  const scope = {
    denBaseUrl: settings.baseUrl,
    serverBaseUrl: input.client.baseUrl,
    orgId,
    workspaceId,
  };
  if (readCloudMcpUserState(scope) !== null) {
    return { outcome: "skipped", status: "skipped", reason: "disabled", health: null };
  }

  const listed = await input.client.listMcp(workspaceId);
  const configured = listed.items.find((entry) => entry.name === CLOUD_MCP_SERVER_NAME);
  if (configured?.config.enabled === false) {
    return { outcome: "skipped", status: "skipped", reason: "disabled", health: null };
  }
  const configuredUrl = typeof configured?.config.url === "string" ? configured.config.url : null;

  const result = await runOpenworkCloudMcpReconciler({
    mode: "repair",
    client: input.client,
    context: {
      ...scope,
      denAuthToken: settings.authToken,
      orgSlug: settings.activeOrgSlug,
      orgName: settings.activeOrgName,
      fallbackUrl: configured?.config.type === "remote" ? configuredUrl : null,
      providerModel: input.providerModel,
      trigger: input.force ? "desktop-background-forced" : "desktop-background",
    },
    mintToken: input.mintToken
      ? async () => input.mintToken?.() ?? null
      : mintCloudControlMcpToken,
    force: input.force,
    refreshMarginMs: CLOUD_MCP_REFRESH_MARGIN_MS,
    now: input.now,
    configuredEnabled: typeof configured?.config.enabled === "boolean" ? configured.config.enabled : null,
  });
  if (result.health?.usable) {
    return {
      outcome: "ready",
      status: result.status === "unchanged" || result.status === "ready" ? "unchanged" : "synced",
      health: result.health,
    };
  }
  if (result.status === "skipped") {
    if (result.skippedReason === "signed_out") {
      return { outcome: "skipped", status: "skipped", reason: "signed_out", health: null };
    }
    if (result.skippedReason === "missing_org") {
      return { outcome: "skipped", status: "skipped", reason: "missing_org", health: null };
    }
    if (result.skippedReason === "missing_workspace") {
      return { outcome: "skipped", status: "skipped", reason: "missing_workspace", health: null };
    }
    if (result.skippedReason === "disabled") {
      return { outcome: "skipped", status: "skipped", reason: "disabled", health: null };
    }
    if (result.skippedReason === "mint_failed") {
      return failedCloudMcpBackgroundSync({
        health: result.health,
        code: "cloud_mcp_token_mint_failed",
        message: "OpenWork could not refresh Cloud authentication for connected service tools.",
      });
    }
  }
  return failedCloudMcpBackgroundSync({
    health: result.health,
    issue: result.health?.firstFailure ?? undefined,
  });
}

export async function runCloudMcpMaintenanceWithRetry(input: {
  attempt: () => Promise<CloudMcpBackgroundSyncResult>;
  retryDelaysMs?: number[];
  wait?: (delayMs: number) => Promise<void>;
  onAttempt?: (input: {
    result: CloudMcpBackgroundSyncResult;
    attempt: number;
    maxAttempts: number;
    willRetry: boolean;
  }) => void;
}): Promise<CloudMcpBackgroundSyncResult> {
  const retryDelaysMs = input.retryDelaysMs ?? CLOUD_MCP_MAINTENANCE_RETRY_DELAYS_MS;
  const wait = input.wait ?? ((delayMs: number) => new Promise((resolve) => setTimeout(resolve, delayMs)));
  const maxAttempts = 1 + retryDelaysMs.length;
  let lastResult: CloudMcpBackgroundSyncResult | null = null;

  for (let index = 0; index < maxAttempts; index += 1) {
    if (index > 0) await wait(retryDelaysMs[index - 1] ?? 0);
    try {
      lastResult = await input.attempt();
    } catch {
      lastResult = failedCloudMcpBackgroundSync({ health: null });
    }
    const willRetry = lastResult.outcome === "failed"
      && lastResult.issue.retryable
      && index < maxAttempts - 1;
    input.onAttempt?.({ result: lastResult, attempt: index + 1, maxAttempts, willRetry });
    if (!willRetry) return lastResult;
  }

  return lastResult ?? failedCloudMcpBackgroundSync({ health: null });
}

export async function healWorkspaceMcpInBackground(input: {
  client: CloudMcpMaintenanceClient;
  workspaceId: string;
  opencodeClient: Client;
  directory: string;
}): Promise<boolean> {
  const workspaceId = input.workspaceId.trim();
  const directory = input.directory.trim();
  if (!workspaceId || !directory) return false;

  const listed = await input.client.listMcp(workspaceId);
  const servers = listed.items.map((entry) => ({
    name: entry.name,
    config: entry.config as McpServerEntry["config"],
  }));
  if (servers.length === 0) return false;

  const statuses = unwrap(await input.opencodeClient.mcp.status({ directory })) as McpStatusMap;
  return attemptSilentMcpReauth({
    client: input.opencodeClient,
    directory,
    servers,
    statuses,
  });
}

export function useSessionMcpMaintenance(input: {
  cloudSignedIn: boolean;
  client: OpenworkServerClient | null;
  workspaceId: string | null;
  opencodeClient: Client | null;
  directory: string;
  providerModel?: OpenworkCloudMcpProviderModelContext;
}): SessionCloudMcpMaintenanceState {
  const [cloudMcpState, setCloudMcpState] = useState<SessionCloudMcpMaintenanceState>(
    IDLE_CLOUD_MCP_MAINTENANCE_STATE,
  );

  useEffect(() => {
    const workspaceId = input.workspaceId?.trim() ?? "";
    const directory = input.directory.trim();
    const client = input.client;
    const opencodeClient = input.opencodeClient;
    if (!client || !opencodeClient || !workspaceId || !directory) {
      setCloudMcpState(IDLE_CLOUD_MCP_MAINTENANCE_STATE);
      return;
    }
    const settings = readDenSettings();
    const targetKey = getSessionMcpMaintenanceTargetKey({
      client,
      cloudSignedIn: input.cloudSignedIn,
      denBaseUrl: settings.baseUrl,
      orgId: settings.activeOrgId,
      workspaceId,
      providerModel: input.providerModel,
    });

    let cancelled = false;
    let busyRetryTimer: number | null = null;
    setCloudMcpState(input.cloudSignedIn
      ? { ...IDLE_CLOUD_MCP_MAINTENANCE_STATE, status: "checking" }
      : IDLE_CLOUD_MCP_MAINTENANCE_STATE);

    const recordCloudAttempt = (attemptInput: {
      result: CloudMcpBackgroundSyncResult;
      attempt: number;
      maxAttempts: number;
      willRetry: boolean;
    }) => {
      const issue = attemptInput.result.outcome === "failed" ? attemptInput.result.issue : null;
      recordInspectorEvent("cloud_mcp.session_maintenance", {
        workspaceId,
        outcome: attemptInput.result.outcome,
        status: attemptInput.result.status,
        attempt: attemptInput.attempt,
        maxAttempts: attemptInput.maxAttempts,
        willRetry: attemptInput.willRetry,
        code: issue?.code ?? null,
        stage: issue?.stage ?? null,
        retryable: issue?.retryable ?? null,
      });
      if (cancelled) return;
      setCloudMcpState({
        status: attemptInput.result.outcome === "ready"
          ? "ready"
          : attemptInput.result.outcome === "skipped"
            ? "skipped"
            : attemptInput.willRetry
              ? "retrying"
              : "failed",
        issue,
        attempt: attemptInput.attempt,
        maxAttempts: attemptInput.maxAttempts,
      });
    };

    const scheduleBusyRetry = () => {
      if (cancelled || busyRetryTimer !== null) return;
      busyRetryTimer = window.setTimeout(() => {
        busyRetryTimer = null;
        void tick();
      }, 250);
    };

    const tick = async () => {
      if (cancelled) return;
      const started = await runSessionMcpMaintenanceTask({
        targetKey,
        task: async () => {
          if (input.cloudSignedIn) {
            await runCloudMcpMaintenanceWithRetry({
              attempt: () => syncCloudControlMcpInBackground({
                client,
                workspaceId,
                providerModel: input.providerModel,
              }),
              onAttempt: recordCloudAttempt,
            });
          }
          await healWorkspaceMcpInBackground({
            client,
            workspaceId,
            opencodeClient,
            directory,
          }).catch(() => {
            recordInspectorEvent("mcp.session_reauth_failed", { workspaceId });
            return false;
          });
        },
      });
      if (!started) scheduleBusyRetry();
    };

    void tick();
    const handleOnline = () => void tick();
    const handleFocus = () => {
      if (document.visibilityState === "visible") void tick();
    };
    window.addEventListener("online", handleOnline);
    window.addEventListener("focus", handleFocus);
    const interval = window.setInterval(() => void tick(), SESSION_MCP_MAINTENANCE_INTERVAL_MS);
    return () => {
      cancelled = true;
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("focus", handleFocus);
      window.clearInterval(interval);
      if (busyRetryTimer !== null) window.clearTimeout(busyRetryTimer);
    };
  }, [
    input.client,
    input.cloudSignedIn,
    input.directory,
    input.opencodeClient,
    input.providerModel?.model,
    input.providerModel?.provider,
    input.workspaceId,
  ]);

  return cloudMcpState;
}
