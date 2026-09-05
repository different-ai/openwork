"use client";

import { useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { getErrorMessage, getRequestError, requestJson } from "../../_lib/den-flow";
import { useOrgDashboard } from "../_providers/org-dashboard-provider";
import { mcpAppCatalogIsLoading } from "./dashboard-mcp-app-catalog";

export type DashboardAccessRole = "viewer" | "editor" | "manager";

/** One MCP App tile reference — the same shape desktop dashboard entries use. */
export type DashboardElement = {
  serverName: string;
  connectionId?: string;
  toolName: string;
  projectedToolName: string;
  resourceUri: string;
  title: string;
  launchArguments?: Record<string, unknown>;
  requiresApproval?: boolean;
  organizationAutoLaunch?: boolean;
};

export type ManagedDashboard = {
  id: string;
  name: string;
  elements: DashboardElement[];
  createdByOrgMembershipId: string;
  createdAt: string;
  updatedAt: string;
};

export type DashboardAccessGrant = {
  id: string;
  orgMembershipId: string | null;
  teamId: string | null;
  orgWide: boolean;
  role: DashboardAccessRole;
  createdByOrgMembershipId: string;
  createdAt: string;
  removedAt: string | null;
};

/** An MCP App a connection can launch cold, in the exact element shape. */
export type ConnectionMcpApp = DashboardElement & {
  connectionId: string;
  description: string | null;
  requiresInput: boolean;
  /** Launch-input keys the tool's input schema marks required. */
  requiredInputKeys: string[];
  requiresApproval: boolean;
};

export type ConnectionMcpAppCatalogItem = ConnectionMcpApp & {
  connectionName: string;
};

export function flattenConnectionMcpAppCatalog(
  connections: Array<{ id: string; name: string }>,
  appLists: ConnectionMcpApp[][],
): ConnectionMcpAppCatalogItem[] {
  return appLists.flatMap((apps, index) => apps.map((app) => ({
    ...app,
    connectionName: connections[index].name,
  })));
}

export function filterConnectionsWithMcpApps<T extends { id: string }>(
  connections: T[],
  apps: ConnectionMcpApp[],
): T[] {
  const connectionIds = new Set(apps.map((app) => app.connectionId));
  return connections.filter((connection) => connectionIds.has(connection.id));
}

export const orgDashboardsQueryKeys = {
  all: ["org-dashboards"] as const,
  organization: (organizationId: string) => [...orgDashboardsQueryKeys.all, organizationId] as const,
  list: (organizationId: string) => [...orgDashboardsQueryKeys.organization(organizationId), "list"] as const,
  detail: (organizationId: string, dashboardId: string) => [
    ...orgDashboardsQueryKeys.organization(organizationId),
    "detail",
    dashboardId,
  ] as const,
  access: (organizationId: string, dashboardId: string) => [
    ...orgDashboardsQueryKeys.organization(organizationId),
    "access",
    dashboardId,
  ] as const,
  connectionApps: (organizationId: string, connectionId: string) => [
    ...orgDashboardsQueryKeys.organization(organizationId),
    "connection-apps",
    connectionId,
  ] as const,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function parseElement(value: unknown): DashboardElement | null {
  if (!isRecord(value)) return null;
  const serverName = readString(value.serverName);
  const toolName = readString(value.toolName);
  const projectedToolName = readString(value.projectedToolName);
  const resourceUri = readString(value.resourceUri);
  const title = readString(value.title);
  if (!serverName || !toolName || !projectedToolName || !resourceUri || !title) return null;
  const connectionId = readString(value.connectionId);
  return {
    serverName,
    ...(connectionId ? { connectionId } : {}),
    toolName,
    projectedToolName,
    resourceUri,
    title,
    ...(isRecord(value.launchArguments) ? { launchArguments: value.launchArguments } : {}),
    ...(value.requiresApproval === true ? { requiresApproval: true } : {}),
    ...(value.organizationAutoLaunch === true ? { organizationAutoLaunch: true } : {}),
  };
}

function parseDashboard(value: unknown): ManagedDashboard | null {
  if (!isRecord(value)) return null;
  const id = readString(value.id);
  const name = readString(value.name);
  const createdByOrgMembershipId = readString(value.createdByOrgMembershipId);
  const createdAt = readString(value.createdAt);
  const updatedAt = readString(value.updatedAt);
  if (!id || !name || !createdByOrgMembershipId || !createdAt || !updatedAt) return null;
  const elements = Array.isArray(value.elements)
    ? value.elements.map(parseElement).filter((element): element is DashboardElement => element !== null)
    : [];
  return { id, name, elements, createdByOrgMembershipId, createdAt, updatedAt };
}

function readRole(value: unknown): DashboardAccessRole | null {
  if (value === "viewer" || value === "editor" || value === "manager") return value;
  return null;
}

function parseAccessGrant(value: unknown): DashboardAccessGrant | null {
  if (!isRecord(value)) return null;
  const id = readString(value.id);
  const role = readRole(value.role);
  const createdByOrgMembershipId = readString(value.createdByOrgMembershipId);
  const createdAt = readString(value.createdAt);
  if (!id || !role || !createdByOrgMembershipId || !createdAt || typeof value.orgWide !== "boolean") return null;
  return {
    id,
    orgMembershipId: readString(value.orgMembershipId),
    teamId: readString(value.teamId),
    orgWide: value.orgWide,
    role,
    createdByOrgMembershipId,
    createdAt,
    removedAt: readString(value.removedAt),
  };
}

function parseConnectionApp(value: unknown): ConnectionMcpApp | null {
  const element = parseElement(value);
  if (!element || !isRecord(value) || !element.connectionId) return null;
  return {
    ...element,
    connectionId: element.connectionId,
    description: readString(value.description),
    requiresInput: value.requiresInput === true,
    requiredInputKeys: Array.isArray(value.requiredInputKeys)
      ? value.requiredInputKeys.filter((key): key is string => typeof key === "string" && key.length > 0)
      : [],
    requiresApproval: value.requiresApproval === true,
  };
}

export function useManagedDashboards() {
  const { orgContext } = useOrgDashboard();
  const organizationId = orgContext?.organization.id ?? "";
  return useQuery({
    enabled: Boolean(organizationId),
    queryKey: orgDashboardsQueryKeys.list(organizationId),
    queryFn: async (): Promise<ManagedDashboard[]> => {
      const { response, payload } = await requestJson("/v1/dashboards", { method: "GET" }, 15000);
      if (!response.ok) {
        throw new Error(getErrorMessage(payload, `Failed to load dashboards (${response.status}).`));
      }
      const items = isRecord(payload) && Array.isArray(payload.items) ? payload.items : [];
      return items.map(parseDashboard).filter((item): item is ManagedDashboard => item !== null);
    },
  });
}

export function useManagedDashboard(dashboardId: string) {
  const { orgContext } = useOrgDashboard();
  const organizationId = orgContext?.organization.id ?? "";
  return useQuery({
    enabled: Boolean(organizationId && dashboardId),
    queryKey: orgDashboardsQueryKeys.detail(organizationId, dashboardId),
    queryFn: async (): Promise<ManagedDashboard> => {
      const { response, payload } = await requestJson(
        `/v1/dashboards/${encodeURIComponent(dashboardId)}`,
        { method: "GET" },
        15000,
      );
      if (!response.ok) {
        throw new Error(getErrorMessage(payload, `Failed to load the dashboard (${response.status}).`));
      }
      const item = isRecord(payload) ? parseDashboard(payload.item) : null;
      if (!item) throw new Error("The dashboard response was invalid.");
      return item;
    },
  });
}

export function useCreateDashboard() {
  const queryClient = useQueryClient();
  const { orgContext, runReauthableAction } = useOrgDashboard();
  const organizationId = orgContext?.organization.id ?? "";
  return useMutation({
    mutationFn: async (input: { name: string }): Promise<ManagedDashboard> => {
      let created: ManagedDashboard | null = null;
      await runReauthableAction("create-dashboard", async () => {
        const { response, payload } = await requestJson(
          "/v1/dashboards",
          { method: "POST", body: JSON.stringify({ name: input.name }) },
          15000,
        );
        if (!response.ok) {
          throw getRequestError(payload, response, `Failed to create the dashboard (${response.status}).`);
        }
        created = isRecord(payload) ? parseDashboard(payload.item) : null;
      });
      if (!created) throw new Error("The dashboard response was invalid.");
      return created;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: orgDashboardsQueryKeys.list(organizationId) });
    },
  });
}

export function useUpdateDashboard() {
  const queryClient = useQueryClient();
  const { orgContext, runReauthableAction } = useOrgDashboard();
  const organizationId = orgContext?.organization.id ?? "";
  return useMutation({
    mutationFn: async (input: { dashboardId: string; name?: string; elements?: DashboardElement[] }) => {
      await runReauthableAction("update-dashboard", async () => {
        const { response, payload } = await requestJson(
          `/v1/dashboards/${encodeURIComponent(input.dashboardId)}`,
          {
            method: "PATCH",
            body: JSON.stringify({
              ...(input.name !== undefined ? { name: input.name } : {}),
              ...(input.elements !== undefined ? { elements: input.elements } : {}),
            }),
          },
          15000,
        );
        if (!response.ok) {
          throw getRequestError(payload, response, `Failed to update the dashboard (${response.status}).`);
        }
      });
      return input.dashboardId;
    },
    onSuccess: (dashboardId) => {
      queryClient.invalidateQueries({ queryKey: orgDashboardsQueryKeys.list(organizationId) });
      queryClient.invalidateQueries({ queryKey: orgDashboardsQueryKeys.detail(organizationId, dashboardId) });
    },
  });
}

export function useDeleteDashboard() {
  const queryClient = useQueryClient();
  const { orgContext, runReauthableAction } = useOrgDashboard();
  const organizationId = orgContext?.organization.id ?? "";
  return useMutation({
    mutationFn: async (input: { dashboardId: string }) => {
      await runReauthableAction("delete-dashboard", async () => {
        const { response, payload } = await requestJson(
          `/v1/dashboards/${encodeURIComponent(input.dashboardId)}`,
          { method: "DELETE" },
          15000,
        );
        if (response.status !== 204 && !response.ok) {
          throw getRequestError(payload, response, `Failed to delete the dashboard (${response.status}).`);
        }
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: orgDashboardsQueryKeys.list(organizationId) });
    },
  });
}

export function useDashboardAccess(dashboardId: string) {
  const { orgContext } = useOrgDashboard();
  const organizationId = orgContext?.organization.id ?? "";
  return useQuery({
    enabled: Boolean(organizationId && dashboardId),
    queryKey: orgDashboardsQueryKeys.access(organizationId, dashboardId),
    queryFn: async (): Promise<DashboardAccessGrant[]> => {
      const { response, payload } = await requestJson(
        `/v1/dashboards/${encodeURIComponent(dashboardId)}/access`,
        { method: "GET" },
        15000,
      );
      if (!response.ok) {
        throw new Error(getErrorMessage(payload, `Failed to load dashboard access (${response.status}).`));
      }
      const items = isRecord(payload) && Array.isArray(payload.items) ? payload.items : [];
      return items
        .map(parseAccessGrant)
        .filter((grant): grant is DashboardAccessGrant => grant !== null && grant.removedAt === null);
    },
  });
}

type GrantDashboardAccessBody =
  | { orgMembershipId: string; teamId?: never; orgWide?: never; role: DashboardAccessRole }
  | { orgMembershipId?: never; teamId: string; orgWide?: never; role: DashboardAccessRole }
  | { orgMembershipId?: never; teamId?: never; orgWide: true; role: DashboardAccessRole };

export function useGrantDashboardAccess() {
  const queryClient = useQueryClient();
  const { orgContext, runReauthableAction } = useOrgDashboard();
  const organizationId = orgContext?.organization.id ?? "";
  return useMutation({
    mutationFn: async (input: { dashboardId: string; body: GrantDashboardAccessBody }) => {
      await runReauthableAction("grant-dashboard-access", async () => {
        const { response, payload } = await requestJson(
          `/v1/dashboards/${encodeURIComponent(input.dashboardId)}/access`,
          { method: "POST", body: JSON.stringify(input.body) },
          15000,
        );
        if (!response.ok) {
          throw getRequestError(payload, response, `Failed to grant dashboard access (${response.status}).`);
        }
      });
      return input.dashboardId;
    },
    onSuccess: (dashboardId) => {
      queryClient.invalidateQueries({ queryKey: orgDashboardsQueryKeys.access(organizationId, dashboardId) });
    },
  });
}

export function useRevokeDashboardAccess() {
  const queryClient = useQueryClient();
  const { orgContext, runReauthableAction } = useOrgDashboard();
  const organizationId = orgContext?.organization.id ?? "";
  return useMutation({
    mutationFn: async (input: { dashboardId: string; grantId: string }) => {
      await runReauthableAction("revoke-dashboard-access", async () => {
        const { response, payload } = await requestJson(
          `/v1/dashboards/${encodeURIComponent(input.dashboardId)}/access/${encodeURIComponent(input.grantId)}`,
          { method: "DELETE" },
          15000,
        );
        if (response.status !== 204 && !response.ok) {
          throw getRequestError(payload, response, `Failed to revoke dashboard access (${response.status}).`);
        }
      });
      return input.dashboardId;
    },
    onSuccess: (dashboardId) => {
      queryClient.invalidateQueries({ queryKey: orgDashboardsQueryKeys.access(organizationId, dashboardId) });
    },
  });
}

/** A flat catalog containing only connections that expose launchable MCP Apps. */
export function useConnectionMcpAppCatalog(connections: Array<{ id: string; name: string }>) {
  const { orgContext } = useOrgDashboard();
  const organizationId = orgContext?.organization.id ?? "";
  return useQueries({
    queries: connections.map((connection) => ({
      enabled: Boolean(organizationId),
      queryKey: orgDashboardsQueryKeys.connectionApps(organizationId, connection.id),
      queryFn: async (): Promise<ConnectionMcpApp[]> => {
        const { response, payload } = await requestJson(
          `/v1/mcp-connections/${encodeURIComponent(connection.id)}/mcp-apps`,
          { method: "GET" },
          20000,
        );
        if (!response.ok) {
          throw new Error(getErrorMessage(payload, `Failed to load ${connection.name}'s apps (${response.status}).`));
        }
        const apps = isRecord(payload) && Array.isArray(payload.apps) ? payload.apps : [];
        return apps.map(parseConnectionApp).filter((app): app is ConnectionMcpApp => app !== null);
      },
    })),
    combine: (results) => {
      const data = flattenConnectionMcpAppCatalog(connections, results.map((result) => result.data ?? []));
      const isLoading = mcpAppCatalogIsLoading(data.length, results.some((result) => result.isPending));
      return {
        data,
        isLoading,
        error: data.length === 0 && !isLoading
          ? results.find((result) => result.error)?.error ?? null
          : null,
      };
    },
  });
}
