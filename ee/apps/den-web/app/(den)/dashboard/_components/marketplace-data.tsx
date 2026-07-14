"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { getErrorMessage, getRequestError, requestJson } from "../../_lib/den-flow";
import { useOrgDashboard } from "../_providers/org-dashboard-provider";
import {
  mcpConnectionQueryKeys,
  parseExternalMcpConfigurationDiscovery,
  type ExternalMcpAccessSummary,
  type ExternalMcpAuthType,
  type ExternalMcpConfigurationDiscovery,
  type ExternalMcpCredentialMode,
} from "./mcp-connections-data";

export type DenMarketplace = {
  id: string;
  name: string;
  description: string | null;
  logoUrl: string | null;
  pluginCount: number;
  createdAt: string;
  updatedAt: string;
};

export const marketplaceQueryKeys = {
  all: ["marketplaces"] as const,
  list: () => [...marketplaceQueryKeys.all, "list"] as const,
  detail: (id: string) => [...marketplaceQueryKeys.all, "detail", id] as const,
  resolved: (id: string) => [...marketplaceQueryKeys.all, "resolved", id] as const,
  access: (id: string) => [...marketplaceQueryKeys.all, "access", id] as const,
  mcpDiscovery: (pluginId: string) => [...marketplaceQueryKeys.all, "mcp-discovery", pluginId] as const,
};

export type MarketplaceAccessRole = "viewer" | "editor" | "manager";

export type MarketplaceAccessGrant = {
  id: string;
  orgMembershipId: string | null;
  teamId: string | null;
  orgWide: boolean;
  role: MarketplaceAccessRole;
  createdAt: string;
  removedAt: string | null;
};

export type MarketplaceResolvedSource = {
  connectorAccountId: string;
  connectorInstanceId: string;
  accountLogin: string | null;
  repositoryFullName: string;
  branch: string | null;
};

export type MarketplacePluginSummary = {
  id: string;
  name: string;
  description: string | null;
  memberCount: number;
  componentCounts: Record<string, number>;
  sourceFormat: string | null;
  cloudReadiness?: MarketplacePluginCloudReadiness;
};

export type MarketplacePluginCloudReadinessState = "ready" | "needs_signin" | "needs_admin_setup" | "desktop_only" | "not_synced";

export type MarketplacePluginCloudReadinessConnection = {
  configObjectId: string;
  id: string | null;
  name: string;
  serverName: string;
  url: string;
  credentialMode?: "shared" | "per_member";
  connectedForMe?: boolean;
};

export type MarketplacePluginCloudReadiness = {
  state: MarketplacePluginCloudReadinessState;
  hasInstructional: boolean;
  connections: MarketplacePluginCloudReadinessConnection[];
};

export type MarketplaceResolved = {
  marketplace: DenMarketplace;
  plugins: MarketplacePluginSummary[];
  source: MarketplaceResolvedSource | null;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function parseMarketplace(entry: unknown): DenMarketplace | null {
  if (!isRecord(entry)) return null;
  const id = asString(entry.id);
  const name = asString(entry.name);
  const createdAt = asString(entry.createdAt);
  const updatedAt = asString(entry.updatedAt);
  if (!id || !name || !createdAt || !updatedAt) return null;
  return {
    id,
    name,
    description: asString(entry.description),
    logoUrl: asString(entry.logoUrl),
    pluginCount: typeof entry.pluginCount === "number" ? entry.pluginCount : 0,
    createdAt,
    updatedAt,
  };
}

function parseCloudReadinessState(value: unknown): MarketplacePluginCloudReadinessState | null {
  if (value === "ready" || value === "needs_signin" || value === "needs_admin_setup" || value === "desktop_only" || value === "not_synced") {
    return value;
  }
  return null;
}

function parseCredentialMode(value: unknown): "shared" | "per_member" | null {
  if (value === "shared" || value === "per_member") return value;
  return null;
}

function parseCloudReadinessConnection(entry: unknown): MarketplacePluginCloudReadinessConnection | null {
  if (!isRecord(entry)) return null;
  const configObjectId = asString(entry.configObjectId);
  const name = asString(entry.name);
  const serverName = asString(entry.serverName);
  const url = asString(entry.url);
  if (!configObjectId || !name || !serverName || !url) return null;
  const credentialMode = parseCredentialMode(entry.credentialMode);
  return {
    configObjectId,
    id: typeof entry.id === "string" ? entry.id : null,
    name,
    serverName,
    url,
    ...(credentialMode ? { credentialMode } : {}),
    ...(typeof entry.connectedForMe === "boolean" ? { connectedForMe: entry.connectedForMe } : {}),
  };
}

function parseCloudReadiness(value: unknown): MarketplacePluginCloudReadiness | null {
  if (!isRecord(value)) return null;
  const state = parseCloudReadinessState(value.state);
  if (!state || typeof value.hasInstructional !== "boolean") return null;
  return {
    state,
    hasInstructional: value.hasInstructional,
    connections: Array.isArray(value.connections)
      ? value.connections.map(parseCloudReadinessConnection).filter((connection): connection is MarketplacePluginCloudReadinessConnection => Boolean(connection))
      : [],
  };
}

export function parseMarketplaceResolvedPayload(payload: unknown): MarketplaceResolved {
  const item = isRecord(payload) && isRecord(payload.item) ? payload.item : null;
  const marketplace = item && isRecord(item.marketplace) ? parseMarketplace(item.marketplace) : null;
  if (!item || !marketplace) {
    throw new Error("Marketplace resolved response was incomplete.");
  }

  const plugins = Array.isArray(item.plugins)
    ? item.plugins.flatMap((entry) => {
        if (!isRecord(entry)) return [];
        const id = asString(entry.id);
        const name = asString(entry.name);
        if (!id || !name) return [];
        const componentCounts: Record<string, number> = {};
        if (isRecord(entry.componentCounts)) {
          for (const [key, value] of Object.entries(entry.componentCounts)) {
            if (typeof value === "number" && value > 0) {
              componentCounts[key] = value;
            }
          }
        }
        const cloudReadiness = parseCloudReadiness(entry.cloudReadiness);
        return [{
          id,
          name,
          description: asString(entry.description),
          memberCount: typeof entry.memberCount === "number" ? entry.memberCount : 0,
          componentCounts,
          sourceFormat: isRecord(entry.extension) ? asString(entry.extension.sourceFormat) : null,
          ...(cloudReadiness ? { cloudReadiness } : {}),
        } satisfies MarketplacePluginSummary];
      })
    : [];

  const sourceRecord = isRecord(item.source) ? item.source : null;
  const source: MarketplaceResolvedSource | null = sourceRecord
    ? {
        connectorAccountId: asString(sourceRecord.connectorAccountId) ?? "",
        connectorInstanceId: asString(sourceRecord.connectorInstanceId) ?? "",
        accountLogin: asString(sourceRecord.accountLogin),
        repositoryFullName: asString(sourceRecord.repositoryFullName) ?? "",
        branch: asString(sourceRecord.branch),
      }
    : null;

  return { marketplace, plugins, source };
}

export function useMarketplace(marketplaceId: string | null) {
  return useQuery({
    enabled: Boolean(marketplaceId),
    queryKey: marketplaceQueryKeys.resolved(marketplaceId ?? "none"),
    queryFn: async (): Promise<MarketplaceResolved> => {
      const { response, payload } = await requestJson(
        `/v1/marketplaces/${encodeURIComponent(marketplaceId ?? "")}/resolved`,
        { method: "GET" },
        15000,
      );
      if (!response.ok) {
        throw new Error(getErrorMessage(payload, `Failed to load marketplace (${response.status}).`));
      }

      return parseMarketplaceResolvedPayload(payload);
    },
  });
}

function parseAccessGrant(entry: unknown): MarketplaceAccessGrant | null {
  if (!isRecord(entry)) return null;
  const id = asString(entry.id);
  const role = asString(entry.role);
  if (!id || !role) return null;
  if (role !== "viewer" && role !== "editor" && role !== "manager") return null;
  return {
    id,
    orgMembershipId: asString(entry.orgMembershipId),
    teamId: asString(entry.teamId),
    orgWide: Boolean(entry.orgWide),
    role,
    createdAt: asString(entry.createdAt) ?? new Date().toISOString(),
    removedAt: asString(entry.removedAt),
  };
}

export function useMarketplaceAccess(marketplaceId: string | null) {
  return useQuery({
    enabled: Boolean(marketplaceId),
    queryKey: marketplaceQueryKeys.access(marketplaceId ?? "none"),
    queryFn: async (): Promise<MarketplaceAccessGrant[]> => {
      const { response, payload } = await requestJson(
        `/v1/marketplaces/${encodeURIComponent(marketplaceId ?? "")}/access`,
        { method: "GET" },
        15000,
      );
      if (!response.ok) {
        throw new Error(getErrorMessage(payload, `Failed to load marketplace access (${response.status}).`));
      }

      const items = isRecord(payload) && Array.isArray(payload.items) ? payload.items : [];
      return items
        .map(parseAccessGrant)
        .filter((value): value is MarketplaceAccessGrant => Boolean(value) && value?.removedAt === null);
    },
  });
}

export function useGrantMarketplaceAccess() {
  const queryClient = useQueryClient();
  const { runReauthableAction } = useOrgDashboard();

  return useMutation({
    mutationFn: async (input: {
      marketplaceId: string;
      body:
        | { orgWide: true; role?: MarketplaceAccessRole }
        | { teamId: string; role?: MarketplaceAccessRole }
        | { orgMembershipId: string; role?: MarketplaceAccessRole };
    }) => {
      await runReauthableAction("grant-marketplace-access", async () => {
      const body = {
        role: input.body.role ?? "viewer",
        ...("orgWide" in input.body ? { orgWide: true } : {}),
        ...("teamId" in input.body ? { teamId: input.body.teamId } : {}),
        ...("orgMembershipId" in input.body ? { orgMembershipId: input.body.orgMembershipId } : {}),
      };
      const { response, payload } = await requestJson(
        `/v1/marketplaces/${encodeURIComponent(input.marketplaceId)}/access`,
        { method: "POST", body: JSON.stringify(body) },
        15000,
      );
      if (!response.ok) {
        throw getRequestError(payload, response, `Failed to grant access (${response.status}).`);
      }
      });
      return input.marketplaceId;
    },
    onSuccess: (marketplaceId) => {
      queryClient.invalidateQueries({ queryKey: marketplaceQueryKeys.access(marketplaceId) });
      queryClient.invalidateQueries({ queryKey: marketplaceQueryKeys.resolved(marketplaceId) });
    },
  });
}

export function useRevokeMarketplaceAccess() {
  const queryClient = useQueryClient();
  const { runReauthableAction } = useOrgDashboard();

  return useMutation({
    mutationFn: async (input: { marketplaceId: string; grantId: string }) => {
      await runReauthableAction("revoke-marketplace-access", async () => {
      const { response, payload } = await requestJson(
        `/v1/marketplaces/${encodeURIComponent(input.marketplaceId)}/access/${encodeURIComponent(input.grantId)}`,
        { method: "DELETE" },
        15000,
      );
      if (response.status !== 204 && !response.ok) {
        throw getRequestError(payload, response, `Failed to revoke access (${response.status}).`);
      }
      });
      return input.marketplaceId;
    },
    onSuccess: (marketplaceId) => {
      queryClient.invalidateQueries({ queryKey: marketplaceQueryKeys.access(marketplaceId) });
      queryClient.invalidateQueries({ queryKey: marketplaceQueryKeys.resolved(marketplaceId) });
    },
  });
}

export type ConfigurePluginMcpConnectionInput = {
  pluginId: string;
  configObjectId: string;
  serverName: string;
  authType: ExternalMcpAuthType;
  credentialMode: ExternalMcpCredentialMode;
  apiKey?: string;
  oauthClient?: {
    clientId: string;
    clientSecret?: string;
  };
};

export type ConfiguredPluginMcpConnection = {
  connectionId: string;
  oauthCallback: string | null;
  yourConnectionsUrl: string | null;
};

export type MarketplacePluginMcpDiscovery = {
  assignment: {
    access: ExternalMcpAccessSummary;
    policy: "union_of_active_config_object_plugin_and_marketplace_grants";
  };
  configObjectId: string;
  discovery: ExternalMcpConfigurationDiscovery;
  pluginId: string;
  serverName: string;
  url: string;
};

export function parseMarketplacePluginMcpDiscovery(payload: unknown): MarketplacePluginMcpDiscovery {
  const item = isRecord(payload) && isRecord(payload.item) ? payload.item : null;
  const assignment = item && isRecord(item.assignment) ? item.assignment : null;
  const access = assignment && isRecord(assignment.access) ? assignment.access : null;
  const discovery = item ? parseExternalMcpConfigurationDiscovery(item.discovery) : null;
  const configObjectId = item ? asString(item.configObjectId) : null;
  const pluginId = item ? asString(item.pluginId) : null;
  const serverName = item ? asString(item.serverName) : null;
  const url = item ? asString(item.url) : null;
  if (
    !item
    || !assignment
    || !access
    || !discovery
    || !configObjectId
    || !pluginId
    || !serverName
    || !url
    || typeof access.orgWide !== "boolean"
    || !Array.isArray(access.memberIds)
    || !access.memberIds.every((entry) => typeof entry === "string")
    || !Array.isArray(access.teamIds)
    || !access.teamIds.every((entry) => typeof entry === "string")
    || assignment.policy !== "union_of_active_config_object_plugin_and_marketplace_grants"
  ) {
    throw new Error("Plugin MCP discovery response was incomplete.");
  }
  return {
    assignment: {
      access: { orgWide: access.orgWide, memberIds: access.memberIds, teamIds: access.teamIds },
      policy: assignment.policy,
    },
    configObjectId,
    discovery,
    pluginId,
    serverName,
    url,
  };
}

export function useDiscoverPluginMcpConnection() {
  const { runReauthableAction } = useOrgDashboard();
  return useMutation({
    mutationFn: async (input: { pluginId: string; configObjectId: string; serverName: string }): Promise<MarketplacePluginMcpDiscovery> => {
      let discovered: MarketplacePluginMcpDiscovery | null = null;
      await runReauthableAction("discover-plugin-mcp-connection", async () => {
        const { response, payload } = await requestJson(
          `/v1/plugins/${encodeURIComponent(input.pluginId)}/mcp-connections/discover`,
          {
            method: "POST",
            body: JSON.stringify({ configObjectId: input.configObjectId, serverName: input.serverName }),
          },
          20000,
        );
        if (!response.ok) {
          throw getRequestError(payload, response, `Failed to inspect plugin connection (${response.status}).`);
        }
        discovered = parseMarketplacePluginMcpDiscovery(payload);
      });
      if (!discovered) throw new Error("Plugin MCP discovery response was incomplete.");
      return discovered;
    },
  });
}

export function parseConfiguredPluginMcpConnection(payload: unknown): ConfiguredPluginMcpConnection {
  const item = isRecord(payload) && isRecord(payload.item) ? payload.item : null;
  const connection = item && isRecord(item.connection) ? item.connection : null;
  const links = item && isRecord(item.links) ? item.links : null;
  const connectionId = connection ? asString(connection.id) : null;
  if (!connectionId) {
    throw new Error("Plugin MCP setup response was incomplete.");
  }
  return {
    connectionId,
    oauthCallback: links ? asString(links.oauthCallback) : null,
    yourConnectionsUrl: links ? asString(links.yourConnections) : null,
  };
}

export function useConfigurePluginMcpConnection() {
  const queryClient = useQueryClient();
  const { runReauthableAction } = useOrgDashboard();

  return useMutation({
    mutationFn: async (input: ConfigurePluginMcpConnectionInput): Promise<ConfiguredPluginMcpConnection> => {
      let configured: ConfiguredPluginMcpConnection | null = null;
      await runReauthableAction("configure-plugin-mcp-connection", async () => {
        const { response, payload } = await requestJson(
          `/v1/plugins/${encodeURIComponent(input.pluginId)}/mcp-connections`,
          {
            method: "POST",
            body: JSON.stringify({
              configObjectId: input.configObjectId,
              serverName: input.serverName,
              authType: input.authType,
              credentialMode: input.credentialMode,
              ...(input.apiKey ? { apiKey: input.apiKey } : {}),
              ...(input.oauthClient ? { oauthClient: input.oauthClient } : {}),
            }),
          },
          20000,
        );
        if (!response.ok) {
          throw getRequestError(payload, response, `Failed to configure plugin connection (${response.status}).`);
        }
        configured = parseConfiguredPluginMcpConnection(payload);
      });
      if (!configured) throw new Error("Plugin MCP setup response was incomplete.");
      return configured;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: marketplaceQueryKeys.all });
      queryClient.invalidateQueries({ queryKey: mcpConnectionQueryKeys.all });
    },
  });
}

export function useMarketplaces() {
  return useQuery({
    queryKey: marketplaceQueryKeys.list(),
    queryFn: async () => {
      const { response, payload } = await requestJson(
        "/v1/marketplaces?status=active&limit=100",
        { method: "GET" },
        15000,
      );
      if (!response.ok) {
        throw new Error(getErrorMessage(payload, `Failed to load marketplaces (${response.status}).`));
      }

      const items = isRecord(payload) && Array.isArray(payload.items) ? payload.items : [];
      return items
        .map(parseMarketplace)
        .filter((value): value is DenMarketplace => Boolean(value));
    },
  });
}

export function formatMarketplaceTimestamp(value: string | null): string {
  if (!value) return "Recently added";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Recently added";
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(date);
}
