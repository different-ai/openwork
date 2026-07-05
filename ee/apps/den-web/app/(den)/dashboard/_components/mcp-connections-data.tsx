"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { getRequestError, requestJson } from "../../_lib/den-flow";
import { useOrgDashboard } from "../_providers/org-dashboard-provider";

export type ExternalMcpAuthType = "oauth" | "apikey" | "none";
export type ExternalMcpCredentialMode = "shared" | "per_member";
export type ExternalMcpConnectionScope = "usable" | "manageable";

export type ExternalMcpAccessSummary = {
  orgWide: boolean;
  memberIds: string[];
  teamIds: string[];
};

export type ExternalMcpConnection = {
  id: string;
  name: string;
  url: string;
  authType: ExternalMcpAuthType;
  credentialMode: ExternalMcpCredentialMode;
  connected: boolean;
  connectedAt: string | null;
  connectedForMe: boolean;
  access: ExternalMcpAccessSummary | null;
};

export type ExternalMcpPreset = {
  presetId: string;
  displayName: string;
  description: string;
  url: string;
  authType: ExternalMcpAuthType;
  requiresOAuthClient?: boolean;
};

export type CreatedMcpConnection = ExternalMcpConnection & {
  links?: {
    yourConnections?: string;
    oauthCallback?: string;
  };
};

export const mcpConnectionQueryKeys = {
  all: ["mcp-connections"] as const,
  list: (orgId?: string | null, scope?: ExternalMcpConnectionScope) =>
    [...mcpConnectionQueryKeys.all, "list", orgId ?? "none", scope ?? "usable"] as const,
  presets: () => [...mcpConnectionQueryKeys.all, "presets"] as const,
};

async function fetchConnections(scope: ExternalMcpConnectionScope): Promise<ExternalMcpConnection[]> {
  const { response, payload } = await requestJson(`/v1/mcp-connections?scope=${scope}`, {}, 15000);
  if (!response.ok) {
    throw getRequestError(payload, response, `Failed to load MCP connections (${response.status}).`);
  }
  const record = payload as { connections?: ExternalMcpConnection[] };
  return record.connections ?? [];
}

export function useMcpConnections(scope: ExternalMcpConnectionScope = "manageable") {
  const { orgId } = useOrgDashboard();
  return useQuery({
    enabled: Boolean(orgId),
    queryKey: mcpConnectionQueryKeys.list(orgId, scope),
    queryFn: () => fetchConnections(scope),
  });
}

export function useMcpConnectionPresets() {
  return useQuery({
    queryKey: mcpConnectionQueryKeys.presets(),
    queryFn: async (): Promise<ExternalMcpPreset[]> => {
      const { response, payload } = await requestJson("/v1/mcp-connections/presets", {}, 15000);
      if (!response.ok) {
        throw getRequestError(payload, response, `Failed to load MCP presets (${response.status}).`);
      }
      const record = payload as { presets?: ExternalMcpPreset[] };
      return record.presets ?? [];
    },
  });
}

export type McpConnectionAccessInput = {
  orgWide: boolean;
  memberIds: string[];
  teamIds: string[];
};

export type CreateMcpConnectionInput = {
  name: string;
  url: string;
  authType: ExternalMcpAuthType;
  credentialMode: ExternalMcpCredentialMode;
  apiKey?: string;
  oauthClient?: {
    clientId: string;
    clientSecret?: string;
  };
  access: McpConnectionAccessInput;
};

export function useCreateMcpConnection() {
  const queryClient = useQueryClient();
  const { orgId, runReauthableAction } = useOrgDashboard();

  return useMutation({
    mutationFn: async (input: CreateMcpConnectionInput): Promise<CreatedMcpConnection> => {
      let created: CreatedMcpConnection | null = null;
      await runReauthableAction("create-mcp-connection", async () => {
        const { response, payload } = await requestJson(
          "/v1/mcp-connections",
          { method: "POST", body: JSON.stringify(input) },
          20000,
        );
        if (!response.ok) {
          throw getRequestError(payload, response, `Failed to add MCP connection (${response.status}).`);
        }
        created = payload as CreatedMcpConnection;
      });
      if (!created) throw new Error("Create MCP connection response was incomplete.");
      return created;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: mcpConnectionQueryKeys.all });
    },
  });
}

export function useReplaceMcpConnectionAccess() {
  const queryClient = useQueryClient();
  const { runReauthableAction } = useOrgDashboard();

  return useMutation({
    mutationFn: async (input: { connectionId: string; access: McpConnectionAccessInput }): Promise<string> => {
      let result: string | null = null;
      await runReauthableAction("replace-mcp-connection-access", async () => {
        const { response, payload } = await requestJson(
          `/v1/mcp-connections/${encodeURIComponent(input.connectionId)}/access`,
          { method: "PUT", body: JSON.stringify({ access: input.access }) },
          15000,
        );
        if (!response.ok) {
          throw getRequestError(payload, response, `Failed to update connection access (${response.status}).`);
        }
        result = input.connectionId;
      });
      if (!result) throw new Error("Update connection access response was incomplete.");
      return result;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: mcpConnectionQueryKeys.all });
    },
  });
}

export function useStartMcpConnectionOAuth() {
  return useMutation({
    mutationFn: async (connectionId: string): Promise<{ status: "connected" | "needs_auth"; authorizeUrl: string | null }> => {
      const { response, payload } = await requestJson(
        `/v1/mcp-connections/${encodeURIComponent(connectionId)}/connect/start`,
        {},
        20000,
      );
      if (!response.ok) {
        throw getRequestError(payload, response, `Failed to start OAuth (${response.status}).`);
      }
      return payload as { status: "connected" | "needs_auth"; authorizeUrl: string | null };
    },
  });
}

export function useDeleteMcpConnection() {
  const queryClient = useQueryClient();
  const { orgId, runReauthableAction } = useOrgDashboard();

  return useMutation({
    mutationFn: async (connectionId: string): Promise<string> => {
      let result: string | null = null;
      await runReauthableAction("delete-mcp-connection", async () => {
        const { response, payload } = await requestJson(
          `/v1/mcp-connections/${encodeURIComponent(connectionId)}`,
          { method: "DELETE" },
          15000,
        );
        if (!response.ok) {
          throw getRequestError(payload, response, `Failed to remove MCP connection (${response.status}).`);
        }
        result = connectionId;
      });
      if (!result) throw new Error("Delete MCP connection response was incomplete.");
      return result;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: mcpConnectionQueryKeys.all });
    },
  });
}

export type SaveNativeProviderClientInput = {
  providerId: string;
  clientId: string;
  clientSecret: string;
};

/**
 * Native providers (google-workspace) are configured with an org OAuth
 * client instead of a server URL. Saving one makes the provider appear in
 * the usable connections list for every granted member.
 */
export function useSaveNativeProviderClient() {
  const queryClient = useQueryClient();
  const { runReauthableAction } = useOrgDashboard();

  return useMutation({
    mutationFn: async (input: SaveNativeProviderClientInput): Promise<void> => {
      await runReauthableAction("save-native-oauth-client", async () => {
        const { response, payload } = await requestJson(
          `/v1/oauth-providers/${encodeURIComponent(input.providerId)}/client`,
          { method: "POST", body: JSON.stringify({ clientId: input.clientId, clientSecret: input.clientSecret }) },
          20000,
        );
        if (!response.ok) {
          throw getRequestError(payload, response, `Failed to save the OAuth client (${response.status}).`);
        }
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: mcpConnectionQueryKeys.all });
    },
  });
}

export function formatMcpConnectedTimestamp(value: string | null): string {
  if (!value) return "Not connected";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Not connected";
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric" }).format(date);
}
