import { useEffect } from "react";

import { getMcpServerName, MCP_QUICK_CONNECT } from "../../../app/constants";
import {
  mintCloudControlMcpToken,
  readDenSettings,
  resolveCloudMcpResourceUrl,
  type DenMcpToken,
  type DenSettings,
} from "../../../app/lib/den";
import type { OpenworkServerClient } from "../../../app/lib/openwork-server";
import { unwrap } from "../../../app/lib/opencode";
import type { Client, McpServerEntry, McpStatusMap } from "../../../app/types";
import { attemptSilentMcpReauth } from "./mcp-silent-reauth";
import {
  CLOUD_MCP_SERVER_NAME,
  isCloudMcpSyncMarkerFresh,
  readCloudMcpSyncMarker,
  readCloudMcpUserState,
  writeCloudMcpSyncMarker,
} from "./cloud-mcp-user-state";

export const SESSION_MCP_MAINTENANCE_INTERVAL_MS = 5 * 60 * 1000;
export const CLOUD_MCP_REFRESH_MARGIN_MS = 24 * 60 * 60 * 1000;

type CloudMcpMaintenanceClient = Pick<OpenworkServerClient, "baseUrl" | "listMcp" | "addMcp">;

const maintenanceInFlight = new Set<string>();

export function getSessionMcpMaintenanceTargetKey(input: {
  client: Pick<OpenworkServerClient, "baseUrl" | "token">;
  cloudSignedIn: boolean;
  workspaceId: string;
  directory: string;
}): string {
  return JSON.stringify([
    input.client.baseUrl.trim().replace(/\/+$/, ""),
    input.client.token?.trim() ?? "",
    input.cloudSignedIn ? "signed-in" : "local-only",
    input.workspaceId.trim(),
    input.directory.trim(),
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
}): Promise<"synced" | "unchanged" | "skipped"> {
  const workspaceId = input.workspaceId.trim();
  const settings = input.settings ?? readDenSettings();
  const orgId = settings.activeOrgId?.trim() ?? "";
  if (!workspaceId || !orgId || !settings.authToken?.trim()) return "skipped";
  if (readCloudMcpUserState() !== null) return "skipped";

  const cloudEntry = MCP_QUICK_CONNECT.find((entry) => entry.serverName === CLOUD_MCP_SERVER_NAME);
  if (!cloudEntry) return "skipped";
  const slug = cloudEntry.id ?? getMcpServerName(cloudEntry);
  const listed = await input.client.listMcp(workspaceId);
  const configured = listed.items.find((entry) => entry.name === slug);
  if (configured?.config.enabled === false) return "skipped";

  const marker = readCloudMcpSyncMarker({
    denBaseUrl: settings.baseUrl,
    serverBaseUrl: input.client.baseUrl,
    orgId,
    workspaceId,
  });
  const markerFresh =
    marker !== null &&
    marker.orgId === orgId &&
    marker.workspaceId === workspaceId &&
    isCloudMcpSyncMarkerFresh({
      expiresAt: marker.expiresAt,
      now: input.now ?? Date.now(),
      refreshMarginMs: CLOUD_MCP_REFRESH_MARGIN_MS,
    });
  if (!input.force && configured && markerFresh) return "unchanged";

  const minted = await (input.mintToken ?? mintCloudControlMcpToken)();
  if (!minted) return "skipped";
  const healedResource = resolveCloudMcpResourceUrl(minted.resource);
  const url = healedResource ? `${healedResource}/agent` : cloudEntry.url;
  if (!url) return "skipped";

  await input.client.addMcp(workspaceId, {
    name: slug,
    config: {
      type: "remote",
      enabled: true,
      url,
      headers: { Authorization: `Bearer ${minted.token}` },
      oauth: false,
    },
  });
  writeCloudMcpSyncMarker({
    denBaseUrl: settings.baseUrl,
    serverBaseUrl: input.client.baseUrl,
    orgId,
    workspaceId,
    expiresAt: minted.expiresAt,
  });
  return "synced";
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
}) {
  useEffect(() => {
    const workspaceId = input.workspaceId?.trim() ?? "";
    const directory = input.directory.trim();
    const client = input.client;
    const opencodeClient = input.opencodeClient;
    if (!client || !opencodeClient || !workspaceId || !directory) return;
    const targetKey = getSessionMcpMaintenanceTargetKey({
      client,
      cloudSignedIn: input.cloudSignedIn,
      workspaceId,
      directory,
    });

    let cancelled = false;
    const tick = async () => {
      if (cancelled) return;
      await runSessionMcpMaintenanceTask({
        targetKey,
        task: async () => {
        if (input.cloudSignedIn) {
          await syncCloudControlMcpInBackground({
            client,
            workspaceId,
          }).catch(() => "skipped");
        }
        await healWorkspaceMcpInBackground({
          client,
          workspaceId,
          opencodeClient,
          directory,
        }).catch(() => false);
        },
      });
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
    };
  }, [input.client, input.cloudSignedIn, input.directory, input.opencodeClient, input.workspaceId]);
}
