"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { getRequestError, requestJson } from "../../_lib/den-flow";
import { useOrgDashboard } from "../_providers/org-dashboard-provider";

const ORG_SCOPE_HEADER = "x-openwork-org-id";

function getOrgScopeHeaders(orgId: string) {
  return { [ORG_SCOPE_HEADER]: orgId };
}

function requireOrgId(orgId: string | null) {
  if (!orgId) {
    throw new Error("Select an organization before managing connections.");
  }
  return orgId;
}

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
  needsReconnect?: boolean;
  missingFeatures?: string[];
  externalAccountId?: string | null;
  grantedScopes?: string[];
  tenantId?: string | null;
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

export function isNativeProviderConnectionId(id: string): boolean {
  return id === "google-workspace" || id === "microsoft-365";
}

export function canDisconnectNativeProviderAccount(connection: Pick<ExternalMcpConnection, "id" | "connectedForMe">): boolean {
  return connection.connectedForMe && isNativeProviderConnectionId(connection.id);
}

export const mcpConnectionQueryKeys = {
  all: ["mcp-connections"] as const,
  list: (orgId?: string | null, scope?: ExternalMcpConnectionScope) =>
    [...mcpConnectionQueryKeys.all, "list", orgId ?? "none", scope ?? "usable"] as const,
  presets: () => [...mcpConnectionQueryKeys.all, "presets"] as const,
  nativeProviderClient: (orgId?: string | null, providerId?: string | null) =>
    [...mcpConnectionQueryKeys.all, "native-provider-client", orgId ?? "none", providerId ?? "none"],
  telegram: (orgId?: string | null) => [...mcpConnectionQueryKeys.all, "telegram", orgId ?? "none"] as const,
  tag: (orgId?: string | null) => [...mcpConnectionQueryKeys.all, "tag", orgId ?? "none"] as const,
  tagOAuth: (orgId?: string | null) => [...mcpConnectionQueryKeys.all, "tag-oauth", orgId ?? "none"] as const,
  tagRuns: (orgId?: string | null) => [...mcpConnectionQueryKeys.all, "tag-runs", orgId ?? "none"] as const,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

async function fetchConnections(scope: ExternalMcpConnectionScope, orgId: string): Promise<ExternalMcpConnection[]> {
  const { response, payload } = await requestJson(
    `/v1/mcp-connections?scope=${scope}`,
    { headers: getOrgScopeHeaders(orgId) },
    15000,
  );
  if (!response.ok) {
    throw getRequestError(payload, response, `Failed to load MCP connections (${response.status}).`);
  }
  const record = payload as { connections?: ExternalMcpConnection[] };
  return (record.connections ?? []).map((connection) => ({
    ...connection,
    ...(typeof connection.needsReconnect === "boolean" ? { needsReconnect: connection.needsReconnect } : {}),
    ...(isStringArray(connection.missingFeatures) ? { missingFeatures: connection.missingFeatures } : {}),
    ...(typeof connection.externalAccountId === "string" || connection.externalAccountId === null
      ? { externalAccountId: connection.externalAccountId }
      : {}),
    ...(isStringArray(connection.grantedScopes) ? { grantedScopes: connection.grantedScopes } : {}),
    ...(typeof connection.tenantId === "string" || connection.tenantId === null ? { tenantId: connection.tenantId } : {}),
  }));
}

export function useMcpConnections(scope: ExternalMcpConnectionScope = "manageable") {
  const { orgId } = useOrgDashboard();
  return useQuery({
    enabled: Boolean(orgId),
    queryKey: mcpConnectionQueryKeys.list(orgId, scope),
    queryFn: () => fetchConnections(scope, requireOrgId(orgId)),
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
          { method: "POST", headers: getOrgScopeHeaders(requireOrgId(orgId)), body: JSON.stringify(input) },
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
  const { orgId, runReauthableAction } = useOrgDashboard();

  return useMutation({
    mutationFn: async (input: { connectionId: string; access: McpConnectionAccessInput }): Promise<string> => {
      let result: string | null = null;
      await runReauthableAction("replace-mcp-connection-access", async () => {
        const { response, payload } = await requestJson(
          `/v1/mcp-connections/${encodeURIComponent(input.connectionId)}/access`,
          { method: "PUT", headers: getOrgScopeHeaders(requireOrgId(orgId)), body: JSON.stringify({ access: input.access }) },
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
  const { orgId } = useOrgDashboard();

  return useMutation({
    mutationFn: async (connectionId: string): Promise<{ status: "connected" | "needs_auth"; authorizeUrl: string | null }> => {
      const { response, payload } = await requestJson(
        `/v1/mcp-connections/${encodeURIComponent(connectionId)}/connect/start`,
        { headers: getOrgScopeHeaders(requireOrgId(orgId)) },
        20000,
      );
      if (!response.ok) {
        throw getRequestError(payload, response, `Failed to start OAuth (${response.status}).`);
      }
      return payload as { status: "connected" | "needs_auth"; authorizeUrl: string | null };
    },
  });
}

export function useDisconnectMyProviderAccount() {
  const queryClient = useQueryClient();
  const { orgId } = useOrgDashboard();

  return useMutation({
    mutationFn: async (providerId: string): Promise<string> => {
      const { response, payload } = await requestJson(
        `/v1/oauth-providers/${encodeURIComponent(providerId)}/disconnect`,
        { method: "POST", headers: getOrgScopeHeaders(requireOrgId(orgId)) },
        15000,
      );
      if (!response.ok) {
        throw getRequestError(payload, response, `Failed to disconnect account (${response.status}).`);
      }
      return providerId;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: mcpConnectionQueryKeys.all });
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
          { method: "DELETE", headers: getOrgScopeHeaders(requireOrgId(orgId)) },
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
  clientId?: string;
  clientSecret?: string;
  tenantId?: string;
  features: string[];
};

export type NativeProviderClient = {
  providerId: string;
  configured: boolean;
  clientId: string | null;
  tenantId: string | null;
  features: string[];
  scopes: string[];
  redirectUri: string;
};

function parseNativeProviderClient(payload: unknown): NativeProviderClient {
  if (!isRecord(payload)) {
    throw new Error("Native provider client response was incomplete.");
  }
  const { providerId, configured, clientId, tenantId, features, scopes, redirectUri } = payload;
  if (
    typeof providerId !== "string"
    || typeof configured !== "boolean"
    || (typeof clientId !== "string" && clientId !== null)
    || (typeof tenantId !== "string" && tenantId !== null)
    || !isStringArray(features)
    || !isStringArray(scopes)
    || typeof redirectUri !== "string"
  ) {
    throw new Error("Native provider client response was incomplete.");
  }
  return { providerId, configured, clientId, tenantId, features, scopes, redirectUri };
}

/**
 * Native providers are configured with an org OAuth
 * client instead of a server URL. Saving one makes the provider appear in
 * the usable connections list for every granted member.
 */
export function useSaveNativeProviderClient() {
  const queryClient = useQueryClient();
  const { orgId, runReauthableAction } = useOrgDashboard();

  return useMutation({
    mutationFn: async (input: SaveNativeProviderClientInput): Promise<void> => {
      await runReauthableAction("save-native-oauth-client", async () => {
        const clientId = input.clientId?.trim();
        const clientSecret = input.clientSecret?.trim();
        const tenantId = input.tenantId?.trim();
        const { response, payload } = await requestJson(
          `/v1/oauth-providers/${encodeURIComponent(input.providerId)}/client`,
          {
            method: "POST",
            headers: getOrgScopeHeaders(requireOrgId(orgId)),
            body: JSON.stringify({
              ...(clientId ? { clientId } : {}),
              ...(clientSecret ? { clientSecret } : {}),
              ...(tenantId ? { tenantId } : {}),
              features: input.features,
            }),
          },
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

export function useNativeProviderClient(providerId: string, enabled: boolean) {
  const { orgId } = useOrgDashboard();

  return useQuery({
    enabled: enabled && Boolean(orgId),
    queryKey: mcpConnectionQueryKeys.nativeProviderClient(orgId, providerId),
    queryFn: async (): Promise<NativeProviderClient> => {
      const { response, payload } = await requestJson(
        `/v1/oauth-providers/${encodeURIComponent(providerId)}/client`,
        { headers: getOrgScopeHeaders(requireOrgId(orgId)) },
        15000,
      );
      if (!response.ok) {
        throw getRequestError(payload, response, `Failed to load the OAuth client (${response.status}).`);
      }
      return parseNativeProviderClient(payload);
    },
  });
}

export type TelegramConnection = {
  id: string;
  status: "active" | "error";
  connected: boolean;
  bot: { id: string; username: string | null; displayName: string };
  worker: { id: string; name: string; status: string };
  webhook: { registered: boolean; lastReceivedAt: string | null; lastError: string | null };
  pairing: {
    paired: boolean;
    chat: { username: string | null; firstName: string | null; pairedAt: string } | null;
  };
  createdAt: string;
  updatedAt: string;
};

export type TelegramPairing = {
  url: string;
  code: string;
  expiresAt: string;
};

function requiredString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string") throw new Error("Telegram connection response was incomplete.");
  return value;
}

function nullableString(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  if (typeof value !== "string" && value !== null) throw new Error("Telegram connection response was incomplete.");
  return value;
}

function parseTelegramConnectionValue(value: unknown): TelegramConnection {
  if (!isRecord(value) || !isRecord(value.bot) || !isRecord(value.worker) || !isRecord(value.webhook) || !isRecord(value.pairing)) {
    throw new Error("Telegram connection response was incomplete.");
  }
  const { bot, worker, webhook, pairing } = value;
  const chat = pairing.chat;
  if (
    (value.status !== "active" && value.status !== "error")
    || typeof value.connected !== "boolean"
    || typeof webhook.registered !== "boolean"
    || typeof pairing.paired !== "boolean"
    || (chat !== null && !isRecord(chat))
  ) {
    throw new Error("Telegram connection response was incomplete.");
  }
  return {
    id: requiredString(value, "id"),
    status: value.status,
    connected: value.connected,
    bot: {
      id: requiredString(bot, "id"),
      username: nullableString(bot, "username"),
      displayName: requiredString(bot, "displayName"),
    },
    worker: {
      id: requiredString(worker, "id"),
      name: requiredString(worker, "name"),
      status: requiredString(worker, "status"),
    },
    webhook: {
      registered: webhook.registered,
      lastReceivedAt: nullableString(webhook, "lastReceivedAt"),
      lastError: nullableString(webhook, "lastError"),
    },
    pairing: {
      paired: pairing.paired,
      chat: chat === null ? null : {
        username: nullableString(chat, "username"),
        firstName: nullableString(chat, "firstName"),
        pairedAt: requiredString(chat, "pairedAt"),
      },
    },
    createdAt: requiredString(value, "createdAt"),
    updatedAt: requiredString(value, "updatedAt"),
  };
}

function parseTelegramConnectionPayload(payload: unknown): TelegramConnection | null {
  if (!isRecord(payload) || !("connection" in payload)) {
    throw new Error("Telegram connection response was incomplete.");
  }
  return payload.connection === null ? null : parseTelegramConnectionValue(payload.connection);
}

export function useTelegramConnection(enabled: boolean) {
  const { orgId } = useOrgDashboard();
  return useQuery({
    enabled: enabled && Boolean(orgId),
    queryKey: mcpConnectionQueryKeys.telegram(orgId),
    queryFn: async (): Promise<TelegramConnection | null> => {
      const { response, payload } = await requestJson(
        "/v1/telegram/connection",
        { headers: getOrgScopeHeaders(requireOrgId(orgId)) },
        15000,
      );
      if (!response.ok) throw getRequestError(payload, response, `Failed to load Telegram (${response.status}).`);
      return parseTelegramConnectionPayload(payload);
    },
  });
}

export function useSaveTelegramConnection() {
  const queryClient = useQueryClient();
  const { orgId, runReauthableAction } = useOrgDashboard();
  return useMutation({
    mutationFn: async (input: { botToken: string; workerId: string }): Promise<TelegramConnection> => {
      let connection: TelegramConnection | null = null;
      await runReauthableAction("save-telegram-connection", async () => {
        const { response, payload } = await requestJson(
          "/v1/telegram/connection",
          { method: "PUT", headers: getOrgScopeHeaders(requireOrgId(orgId)), body: JSON.stringify(input) },
          30000,
        );
        if (!response.ok) throw getRequestError(payload, response, `Failed to connect Telegram (${response.status}).`);
        connection = parseTelegramConnectionPayload(payload);
      });
      if (!connection) throw new Error("Telegram connection response was incomplete.");
      return connection;
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: mcpConnectionQueryKeys.telegram(orgId) }),
  });
}

export function useCreateTelegramPairing() {
  const queryClient = useQueryClient();
  const { orgId, runReauthableAction } = useOrgDashboard();
  return useMutation({
    mutationFn: async (): Promise<TelegramPairing> => {
      let pairing: TelegramPairing | null = null;
      await runReauthableAction("create-telegram-pairing", async () => {
        const { response, payload } = await requestJson(
          "/v1/telegram/connection/pairing",
          { method: "POST", headers: getOrgScopeHeaders(requireOrgId(orgId)), body: JSON.stringify({}) },
          15000,
        );
        if (!response.ok) throw getRequestError(payload, response, `Failed to create Telegram pairing (${response.status}).`);
        if (!isRecord(payload) || !isRecord(payload.pairing)) throw new Error("Telegram pairing response was incomplete.");
        pairing = {
          url: requiredString(payload.pairing, "url"),
          code: requiredString(payload.pairing, "code"),
          expiresAt: requiredString(payload.pairing, "expiresAt"),
        };
      });
      if (!pairing) throw new Error("Telegram pairing response was incomplete.");
      return pairing;
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: mcpConnectionQueryKeys.telegram(orgId) }),
  });
}

export function useDeleteTelegramConnection() {
  const queryClient = useQueryClient();
  const { orgId, runReauthableAction } = useOrgDashboard();
  return useMutation({
    mutationFn: async (): Promise<void> => {
      await runReauthableAction("delete-telegram-connection", async () => {
        const { response, payload } = await requestJson(
          "/v1/telegram/connection",
          { method: "DELETE", headers: getOrgScopeHeaders(requireOrgId(orgId)) },
          20000,
        );
        if (!response.ok) throw getRequestError(payload, response, `Failed to disconnect Telegram (${response.status}).`);
      });
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: mcpConnectionQueryKeys.telegram(orgId) }),
  });
}

export type TagConnection = {
  id: string;
  status: "active" | "error";
  connected: boolean;
  eventsUrl: string;
  slack: { teamId: string; teamName: string; botUserId: string; botName: string };
  installation: {
    source: "manual" | "oauth";
    appId: string | null;
    enterpriseId: string | null;
    enterpriseInstall: boolean;
    scopes: string[];
    tokenExpiresAt: string | null;
    tokenRefreshedAt: string | null;
    revokedAt: string | null;
  };
  worker: { id: string; name: string; status: string };
  policy: {
    serviceName: string;
    defaultInstructions: string;
    allowedUserIds: string[];
    allowGuests: boolean;
    allowSharedChannels: boolean;
    channels: Array<{ id: string; name: string | null; instructions: string | null }>;
  };
  webhook: { lastReceivedAt: string | null; lastError: string | null };
  createdAt: string;
  updatedAt: string;
};

export type TagRun = {
  id: string;
  status: "accepted" | "running" | "completed" | "failed" | "cancelled";
  slackUserId: string;
  prompt: string;
  response: string | null;
  error: string | null;
  channelId: string;
  threadTs: string;
  sessionId: string | null;
  workspaceId: string | null;
  snapshotHash: string;
  createdAt: string;
  completedAt: string | null;
};

export type TagPolicyInput = {
  workerId: string;
  serviceName: string;
  defaultInstructions: string;
  allowedUserIds: string[];
  allowGuests: boolean;
  allowSharedChannels: boolean;
  channels: Array<{ id: string; instructions?: string | null }>;
};

export type SaveTagConnectionInput = TagPolicyInput & {
  botToken: string;
  signingSecret: string;
};

export type TagOAuthConfig = {
  configured: boolean;
  eventsUrl: string;
  redirectUri: string;
  scopes: string[];
};

export type TagOAuthStart = {
  authorizeUrl: string;
  callbackOrigin: string;
};

function parseTagConnectionPayload(payload: unknown): TagConnection | null {
  if (!isRecord(payload) || !("connection" in payload)) throw new Error("OpenWork Tag response was incomplete.");
  if (payload.connection === null) return null;
  const value = payload.connection;
  if (
    !isRecord(value) || !isRecord(value.slack) || !isRecord(value.installation) || !isRecord(value.worker)
    || !isRecord(value.policy) || !isRecord(value.webhook) || !Array.isArray(value.policy.channels)
  ) throw new Error("OpenWork Tag response was incomplete.");
  return value as TagConnection;
}

export function useTagOAuthConfig(enabled: boolean) {
  const { orgId } = useOrgDashboard();
  return useQuery({
    enabled: enabled && Boolean(orgId),
    queryKey: mcpConnectionQueryKeys.tagOAuth(orgId),
    queryFn: async (): Promise<TagOAuthConfig> => {
      const { response, payload } = await requestJson(
        "/v1/tag/slack/oauth/config",
        { headers: getOrgScopeHeaders(requireOrgId(orgId)) },
        15000,
      );
      if (!response.ok) throw getRequestError(payload, response, `Failed to load Slack installation options (${response.status}).`);
      if (!isRecord(payload) || typeof payload.configured !== "boolean" || typeof payload.eventsUrl !== "string" || typeof payload.redirectUri !== "string" || !isStringArray(payload.scopes)) {
        throw new Error("Slack installation configuration was incomplete.");
      }
      return { configured: payload.configured, eventsUrl: payload.eventsUrl, redirectUri: payload.redirectUri, scopes: payload.scopes };
    },
  });
}

export function useStartTagOAuth() {
  const { orgId, runReauthableAction } = useOrgDashboard();
  return useMutation({
    mutationFn: async (input: TagPolicyInput): Promise<TagOAuthStart> => {
      let result: TagOAuthStart | null = null;
      await runReauthableAction("start-tag-slack-oauth", async () => {
        const { response, payload } = await requestJson(
          "/v1/tag/slack/oauth/start",
          { method: "POST", headers: getOrgScopeHeaders(requireOrgId(orgId)), body: JSON.stringify(input) },
          20000,
        );
        if (!response.ok) throw getRequestError(payload, response, `Failed to start Slack installation (${response.status}).`);
        if (!isRecord(payload) || typeof payload.authorizeUrl !== "string" || typeof payload.callbackOrigin !== "string") {
          throw new Error("Slack installation response was incomplete.");
        }
        result = { authorizeUrl: payload.authorizeUrl, callbackOrigin: payload.callbackOrigin };
      });
      if (!result) throw new Error("Slack installation response was incomplete.");
      return result;
    },
  });
}

export function useTagConnection(enabled: boolean) {
  const { orgId } = useOrgDashboard();
  return useQuery({
    enabled: enabled && Boolean(orgId),
    queryKey: mcpConnectionQueryKeys.tag(orgId),
    queryFn: async (): Promise<TagConnection | null> => {
      const { response, payload } = await requestJson(
        "/v1/tag/slack/connection",
        { headers: getOrgScopeHeaders(requireOrgId(orgId)) },
        15000,
      );
      if (!response.ok) throw getRequestError(payload, response, `Failed to load OpenWork Tag (${response.status}).`);
      return parseTagConnectionPayload(payload);
    },
  });
}

export function useSaveTagConnection() {
  const queryClient = useQueryClient();
  const { orgId, runReauthableAction } = useOrgDashboard();
  return useMutation({
    mutationFn: async (input: SaveTagConnectionInput): Promise<TagConnection> => {
      let connection: TagConnection | null = null;
      await runReauthableAction("save-tag-connection", async () => {
        const { response, payload } = await requestJson(
          "/v1/tag/slack/connection",
          { method: "PUT", headers: getOrgScopeHeaders(requireOrgId(orgId)), body: JSON.stringify(input) },
          30000,
        );
        if (!response.ok) throw getRequestError(payload, response, `Failed to connect OpenWork Tag (${response.status}).`);
        connection = parseTagConnectionPayload(payload);
      });
      if (!connection) throw new Error("OpenWork Tag response was incomplete.");
      return connection;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: mcpConnectionQueryKeys.tag(orgId) });
      queryClient.invalidateQueries({ queryKey: mcpConnectionQueryKeys.tagRuns(orgId) });
    },
  });
}

export function useUpdateTagConnection() {
  const queryClient = useQueryClient();
  const { orgId, runReauthableAction } = useOrgDashboard();
  return useMutation({
    mutationFn: async (input: TagPolicyInput): Promise<TagConnection> => {
      let connection: TagConnection | null = null;
      await runReauthableAction("update-tag-connection", async () => {
        const { response, payload } = await requestJson(
          "/v1/tag/slack/connection",
          { method: "PATCH", headers: getOrgScopeHeaders(requireOrgId(orgId)), body: JSON.stringify(input) },
          30000,
        );
        if (!response.ok) throw getRequestError(payload, response, `Failed to update OpenWork Tag (${response.status}).`);
        connection = parseTagConnectionPayload(payload);
      });
      if (!connection) throw new Error("OpenWork Tag response was incomplete.");
      return connection;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: mcpConnectionQueryKeys.tag(orgId) });
      queryClient.invalidateQueries({ queryKey: mcpConnectionQueryKeys.tagRuns(orgId) });
    },
  });
}

export function useDeleteTagConnection() {
  const queryClient = useQueryClient();
  const { orgId, runReauthableAction } = useOrgDashboard();
  return useMutation({
    mutationFn: async (): Promise<void> => {
      await runReauthableAction("delete-tag-connection", async () => {
        const { response, payload } = await requestJson(
          "/v1/tag/slack/connection",
          { method: "DELETE", headers: getOrgScopeHeaders(requireOrgId(orgId)) },
          20000,
        );
        if (!response.ok) throw getRequestError(payload, response, `Failed to disconnect OpenWork Tag (${response.status}).`);
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: mcpConnectionQueryKeys.tag(orgId) });
      queryClient.invalidateQueries({ queryKey: mcpConnectionQueryKeys.tagRuns(orgId) });
    },
  });
}

export function useTagRuns(enabled: boolean) {
  const { orgId } = useOrgDashboard();
  return useQuery({
    enabled: enabled && Boolean(orgId),
    queryKey: mcpConnectionQueryKeys.tagRuns(orgId),
    queryFn: async (): Promise<TagRun[]> => {
      const { response, payload } = await requestJson(
        "/v1/tag/slack/runs",
        { headers: getOrgScopeHeaders(requireOrgId(orgId)) },
        15000,
      );
      if (!response.ok) throw getRequestError(payload, response, `Failed to load OpenWork Tag runs (${response.status}).`);
      if (!isRecord(payload) || !Array.isArray(payload.items)) throw new Error("OpenWork Tag run response was incomplete.");
      return payload.items as TagRun[];
    },
    refetchInterval: enabled ? 5000 : false,
  });
}

export function formatMcpConnectedTimestamp(value: string | null): string {
  if (!value) return "Not connected";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Not connected";
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric" }).format(date);
}
